import assert from 'node:assert/strict';
import type { InferenceProvider } from '@hypha/inference';
import { applyDecisionGapAnswer, createInitialResearchIntent, deriveDecisionGaps, emptyInterviewMemory, selectNextDecisionGap } from './agent/decision-gap.js';
import { DatasetUnderstandingLanguageLoop, MAX_DATASET_EXPLORATION_CALLS } from './dataset-understanding/language-loop.js';
import { buildDatasetFacts, buildDeterministicUnderstanding } from './dataset-understanding/service.js';
import { plannerInputV2Hash, type PlannerDecisionV2, type PlannerInputV2 } from './planner/v2-contracts.js';
import { presentPlanV2 } from './planner/v2-presenter.js';
import { validatePlannerDecisionV2 } from './planner/v2-validator.js';
import type { ThetaDatasetExploreOutput } from './tools/dataset-explore-tool.js';

const output = {
  datasetRef: 'dataset_test', datasetHash: 'a'.repeat(64), fileName: 'dataset.csv', format: 'csv', sizeBytes: 1000,
  rowCount: 80, columns: ['text', 'timestamp'], sampleSeed: 'seed', profiles: [
    { name: 'text', inferredType: 'text', missingRatio: 0, uniqueCount: 80, averageLength: 40, maximumLength: 80 },
    { name: 'timestamp', inferredType: 'datetime', missingRatio: 0, uniqueCount: 20, averageLength: 10, maximumLength: 10 },
  ], languageDistribution: [{ language: 'zh', ratio: 1 }], duplicateRatio: 0,
  timeCoverage: { start: '2026-01-01', end: '2026-02-01' }, head: [{ text: '已脱敏样本' }], sample: [{ text: '已脱敏样本' }],
  sampleTruncated: false, redaction: { applied: true, redactedValueCount: 0, rules: ['email', 'phone', 'id'] },
  columnRoles: {
    text: [{ name: 'text', score: 0.96, reason: '文本列' }],
    time: [{ name: 'timestamp', score: 0.9, reason: '时间列' }], id: [], metadata: [],
  }, inferredDomain: { label: '社会文本研究', confidence: 0.72, evidence: ['文本样本'] }, qualityWarnings: [],
} as ThetaDatasetExploreOutput;
const facts = buildDatasetFacts(output);
const provider: InferenceProvider = {
  id: 'fake',
  infer: async () => ({ id: 'fake', output: { kind: 'tool_calls', toolCalls: [{ id: '1', name: 'theta.dataset.explore', arguments: { datasetRef: 'ignored', view: 'samples' } }] } }),
};
let calls = 0;
const loop = new DatasetUnderstandingLanguageLoop({ provider, explore: async () => { calls += 1; return output; } });
const bounded = await loop.understand(facts, output);
assert.equal(calls, MAX_DATASET_EXPLORATION_CALLS);
assert.equal(bounded.source, 'deterministic');
assert.equal(bounded.fallbackReason, 'tool_budget_exhausted');

const understanding = buildDeterministicUnderstanding(facts, output);
const confirmation = {
  schemaVersion: '2.0.0' as const, datasetRef: facts.datasetRef, datasetHash: facts.datasetHash,
  status: 'confirmed' as const, domainLabel: understanding.domain.label, analysisUnit: understanding.analysisUnit,
  textColumns: ['text'], timeColumns: ['timestamp'], idColumns: [], metadataColumns: [],
  confirmedBy: 'owner', confirmedAt: new Date().toISOString(),
};
const initialIntent = createInitialResearchIntent();
const gaps = deriveDecisionGaps(understanding, confirmation, initialIntent);
const first = selectNextDecisionGap(gaps, emptyInterviewMemory());
assert.ok(first);
const turn = applyDecisionGapAnswer(initialIntent, first, '不知道', emptyInterviewMemory());
assert.ok(!turn.intent.unknowns.includes(first.id));
assert.equal(turn.appliedDefaults.length, 1);

const plannerInput: PlannerInputV2 = {
  schemaVersion: '2.0.0', facts, confirmation,
  intent: { ...turn.intent, temporalAnalysis: true, unknowns: [] },
  hardware: { device: 'cpu', memoryGb: 16, offlineOnly: true }, catalogVersion: 'test',
  candidates: [{ modelId: 'dtm', runnable: true, capabilities: ['temporal_topics'], estimatedMemoryGb: 4 }],
  evidenceRefs: ['evidence-1'], userOverrides: {},
};
const decision: PlannerDecisionV2 = {
  schemaVersion: '2.0.0', inputHash: plannerInputV2Hash(plannerInput), modelId: 'dtm', parameters: { numTopics: 5 },
  evaluation: ['主题一致性与人工可解释性'], visualizations: ['主题随时间变化图'], warnings: [], assumptions: [],
};
const validation = validatePlannerDecisionV2(plannerInput, decision);
assert.equal(validation.valid, true);
assert.equal(presentPlanV2(plannerInput, decision, validation).approvalRequired, true);
console.log(JSON.stringify({ status: 'ok', explorationCalls: calls, defaultedGap: first.id, plannerValid: validation.valid }));
