import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export type DatasetExploreView =
  | 'schema'
  | 'head'
  | 'sample'
  | 'profiles'
  | 'quality';

export interface ThetaDatasetExploreInput {
  datasetRef: string;
  views?: DatasetExploreView[];
  sampleSize?: number;
  sampleSeed?: string;
}

export interface ExploreColumnProfile {
  name: string;
  inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
  missingRatio: number;
  uniqueCount: number;
  averageLength: number;
  maximumLength: number;
}

export interface ExploreColumnCandidate {
  name: string;
  score: number;
  reason: string;
}

export interface ThetaDatasetExploreOutput {
  datasetRef: string;
  datasetHash: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  rowCount: number;
  columns: string[];
  profiles: ExploreColumnProfile[];
  head: Array<Record<string, unknown>>;
  sample: Array<Record<string, unknown>>;
  sampleSeed: string;
  sampleTruncated: boolean;
  redaction: {
    applied: boolean;
    redactedValueCount: number;
    rules: string[];
  };
  columnRoles: {
    text: ExploreColumnCandidate[];
    time: ExploreColumnCandidate[];
    id: ExploreColumnCandidate[];
    metadata: ExploreColumnCandidate[];
  };
  languageDistribution: Array<{ language: string; ratio: number }>;
  duplicateRatio: number;
  timeCoverage: { start: string | null; end: string | null };
  inferredDomain: {
    label: string;
    confidence: number;
    evidence: string[];
  };
  qualityWarnings: string[];
}

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    views: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['schema', 'head', 'sample', 'profiles', 'quality'] },
      maxItems: 5,
    },
    sampleSize: { type: 'integer', minimum: 1, maximum: 100 },
    sampleSeed: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: [
    'datasetRef',
    'datasetHash',
    'fileName',
    'format',
    'sizeBytes',
    'rowCount',
    'columns',
    'profiles',
    'head',
    'sample',
    'sampleSeed',
    'sampleTruncated',
    'redaction',
    'columnRoles',
    'languageDistribution',
    'duplicateRatio',
    'timeCoverage',
    'inferredDomain',
    'qualityWarnings',
  ],
  properties: {
    datasetRef: { type: 'string' },
    datasetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    fileName: { type: 'string' },
    format: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    rowCount: { type: 'integer', minimum: 0 },
    columns: { type: 'array', items: { type: 'string' } },
    profiles: { type: 'array', items: { type: 'object', additionalProperties: true } },
    head: { type: 'array', items: { type: 'object', additionalProperties: true } },
    sample: { type: 'array', items: { type: 'object', additionalProperties: true } },
    sampleSeed: { type: 'string' },
    sampleTruncated: { type: 'boolean' },
    redaction: { type: 'object', additionalProperties: true },
    columnRoles: { type: 'object', additionalProperties: true },
    languageDistribution: { type: 'array', items: { type: 'object', additionalProperties: true } },
    duplicateRatio: { type: 'number', minimum: 0, maximum: 1 },
    timeCoverage: { type: 'object', additionalProperties: true },
    inferredDomain: { type: 'object', additionalProperties: true },
    qualityWarnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaDatasetExploreToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetExplore,
  version: '2.0.0',
  displayName: 'Explore Dataset',
  description:
    'Return deterministic, bounded and locally redacted dataset facts for an opaque dataset reference.',
  tags: ['theta', 'dataset', 'understanding'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: { timeoutMs: 45_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
  source: 'local',
};

export const thetaDatasetExploreHandler: ToolHandler<
  unknown,
  ThetaDatasetExploreOutput
> = async (rawInput, context: ToolCallContext) => {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('Dataset explore input must be an object.');
  }
  const input = rawInput as ThetaDatasetExploreInput;
  const userId = context.userId ?? context.principal?.userId ?? 'local_user';
  const workspaceId =
    context.workspaceId ?? context.principal?.workspaceId ?? 'local_workspace';
  const runtimeDb = context.metadata?.thetaRuntimeDb;
  const registry = new SQLiteDatasetRegistry(
    typeof runtimeDb === 'string' && runtimeDb.trim()
      ? runtimeDb
      : undefined,
  );
  try {
    const record = registry.require(input.datasetRef, { userId, workspaceId });
    const response = await callThetaBridge(
      'dataset.explore',
      {
        filePath: record.managedPath,
        datasetRef: record.datasetRef,
        datasetHash: record.sha256,
        fileName: record.displayName,
        sizeBytes: record.sizeBytes,
        views: input.views ?? ['schema', 'head', 'sample', 'profiles', 'quality'],
        sampleSize: input.sampleSize ?? 20,
        sampleSeed: input.sampleSeed ?? record.sha256.slice(0, 16),
      },
      { runId: context.runId, stepId: context.stepId },
    );
    if (response.status !== 'ok') {
      throw new Error(response.error?.message ?? 'dataset.explore bridge command failed.');
    }
    return response.data as ThetaDatasetExploreOutput;
  } finally {
    registry.close();
  }
};
