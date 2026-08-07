import {
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from './contracts.js';
import type { ThetaDatasetExploreOutput } from '../tools/dataset-explore-tool.js';

export const buildDatasetFacts = (
  output: ThetaDatasetExploreOutput,
): DatasetFacts =>
  datasetFactsSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: output.datasetRef,
    datasetHash: output.datasetHash,
    fileName: output.fileName,
    format: output.format,
    sizeBytes: output.sizeBytes,
    rowCount: output.rowCount,
    columns: output.profiles.map((profile) => ({
      name: profile.name,
      inferredType: profile.inferredType,
      missingRatio: profile.missingRatio,
      uniqueCount: profile.uniqueCount,
      averageLength: profile.averageLength,
    })),
    languageDistribution: output.languageDistribution,
    duplicateRatio: output.duplicateRatio,
    timeCoverage: output.timeCoverage,
    generatedAt: new Date().toISOString(),
  });

export const buildDeterministicUnderstanding = (
  facts: DatasetFacts,
  output: ThetaDatasetExploreOutput,
): DatasetUnderstandingDraft => {
  const candidate = (column: string, confidence: number, reason: string) => ({
    column,
    confidence,
    reason,
  });
  const textColumns = output.columnRoles.text.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const timeColumns = output.columnRoles.time.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const idColumns = output.columnRoles.id.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const metadataColumns = output.columnRoles.metadata.map((entry) =>
    candidate(entry.name, entry.score, entry.reason),
  );
  const analysisUnit = textColumns[0]
    ? `每一行是一条独立记录，主要分析 ${textColumns[0].column} 列中的文本。`
    : '每一行是一条独立记录；当前没有足够证据确定正文列。';
  return datasetUnderstandingDraftSchema.parse({
    schemaVersion: '2.0.0',
    datasetRef: facts.datasetRef,
    datasetHash: facts.datasetHash,
    domain: output.inferredDomain,
    analysisUnit,
    textColumns,
    timeColumns,
    idColumns,
    metadataColumns,
    qualityWarnings: output.qualityWarnings,
    assumptions: [
      '列角色来自字段名、数据类型、长度与唯一性统计，尚未替代用户的领域确认。',
    ],
    confidence: textColumns[0]?.confidence ?? 0.35,
    provenance: {
      source: 'deterministic',
      toolIds: ['theta.dataset.explore'],
      sampleSeed: output.sampleSeed,
      generatedAt: new Date().toISOString(),
    },
  });
};
