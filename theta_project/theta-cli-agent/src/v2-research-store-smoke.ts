import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { emptyInterviewMemory } from './agent/decision-gap.js';
import {
  datasetConfirmationSchema,
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  researchIntentSchema,
} from './dataset-understanding/contracts.js';
import { SQLiteV2ResearchStore } from './storage/v2-research-store.js';

const filename = path.resolve('.theta_agent', 'v2-research-store-smoke.sqlite');
try {
  unlinkSync(filename);
} catch {}

const datasetHash = 'a'.repeat(64);
const runId = 'theta-v2-store-smoke';
const store = new SQLiteV2ResearchStore(filename);
try {
  const facts = datasetFactsSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: 'dataset_smoke',
    datasetHash,
    fileName: 'sample.csv',
    format: 'csv',
    sizeBytes: 100,
    rowCount: 2,
    columns: [
      {
        name: 'text',
        inferredType: 'text',
        missingRatio: 0,
        uniqueCount: 2,
        averageLength: 12,
      },
    ],
    languageDistribution: [{ language: 'zh', ratio: 1 }],
    duplicateRatio: 0,
    timeCoverage: { start: null, end: null },
    generatedAt: new Date().toISOString(),
  });
  const firstFacts = store.appendFacts(runId, facts);
  const secondFacts = store.appendFacts(runId, facts);
  if (firstFacts.revision !== 1 || secondFacts.revision !== 2) {
    throw new Error('Dataset fact revisions are not monotonic.');
  }

  const understanding = datasetUnderstandingDraftSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: facts.datasetRef,
    datasetHash,
    domain: { label: '文本研究', confidence: 0.8, evidence: ['text'] },
    analysisUnit: '每一行是一条文本记录。',
    textColumns: [
      { column: 'text', confidence: 0.95, reason: '最长自然语言字段' },
    ],
    timeColumns: [],
    idColumns: [],
    metadataColumns: [],
    qualityWarnings: [],
    assumptions: [],
    confidence: 0.8,
    provenance: {
      source: 'deterministic',
      toolIds: ['theta.dataset.explore'],
      sampleSeed: 'stable',
      generatedAt: new Date().toISOString(),
    },
  });
  store.appendUnderstanding(runId, understanding);
  store.saveConfirmation(
    runId,
    datasetConfirmationSchema.parse({
      schemaVersion: '2.0.0',
      datasetRef: facts.datasetRef,
      datasetHash,
      status: 'confirmed',
      domainLabel: understanding.domain.label,
      analysisUnit: understanding.analysisUnit,
      textColumns: ['text'],
      timeColumns: [],
      idColumns: [],
      metadataColumns: [],
      confirmedBy: 'local_user',
      confirmedAt: new Date().toISOString(),
    }),
  );
  store.appendIntent(
    runId,
    researchIntentSchema.parse({
      schemaVersion: '2.0.0',
      researchQuestion: '识别主要主题',
      comparisonDimensions: [],
      temporalAnalysis: false,
      topicGranularity: 'medium',
      successCriteria: ['主题可解释'],
      constraints: ['本地运行'],
      unknowns: [],
    }),
  );
  store.saveInterviewMemory(runId, emptyInterviewMemory());

  if (store.latestFacts(runId)?.revision !== 2) {
    throw new Error('Latest dataset facts revision could not be read.');
  }
  if (store.confirmation(runId)?.textColumns[0] !== 'text') {
    throw new Error('Dataset confirmation could not be read.');
  }
  if (store.latestIntent(runId)?.value.researchQuestion !== '识别主要主题') {
    throw new Error('Research intent could not be read.');
  }
  if (!store.interviewMemory(runId)) {
    throw new Error('Interview memory could not be read.');
  }

  store.invalidateAfterDatasetHashChange(runId, 'b'.repeat(64));
  if (store.confirmation(runId) || store.latestIntent(runId)) {
    throw new Error('Dataset hash invalidation retained stale confirmation or intent.');
  }

  console.log(JSON.stringify({ status: 'ok', factsRevision: 2, invalidation: true }));
} finally {
  store.close();
}
