import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import { resolveDatasetFile } from './dataset-path-policy.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaDatasetFileInput {
  filePath: string;
  sampleSize?: number;
}

export interface ThetaDatasetColumnProfile {
  name: string;
  nonEmptySampleCount: number;
  missingSampleCount: number;
  missingSampleRatio: number;
  uniqueSampleCount: number;
  avgLength: number;
  maxLength: number;
  inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
  sampleValues: string[];
  estimatedTotalRows: number;
}

export interface ThetaDatasetColumnCandidate {
  name: string;
  score: number;
  reason: string;
}

export interface ThetaDatasetInspectOutput {
  filePath: string;
  fileName: string;
  suffix: string;
  supported: boolean;
  encoding: string;
  delimiter: string | null;
  rowCount: number;
  sampleRowCount: number;
  columns: string[];
  columnProfiles: ThetaDatasetColumnProfile[];
  sampleRows: Array<Record<string, unknown>>;
  textColumnCandidates: ThetaDatasetColumnCandidate[];
}

export const thetaDatasetFileInputSchema: JsonSchema = {
  type: 'object',
  required: ['filePath'],
  properties: {
    filePath: { type: 'string', minLength: 1 },
    sampleSize: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  additionalProperties: false,
};

export const thetaDatasetColumnCandidateSchema: JsonSchema = {
  type: 'object',
  required: ['name', 'score', 'reason'],
  properties: {
    name: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  additionalProperties: false,
};

const thetaDatasetColumnProfileSchema: JsonSchema = {
  type: 'object',
  required: [
    'name',
    'nonEmptySampleCount',
    'missingSampleCount',
    'missingSampleRatio',
    'uniqueSampleCount',
    'avgLength',
    'maxLength',
    'inferredType',
    'sampleValues',
    'estimatedTotalRows',
  ],
  properties: {
    name: { type: 'string' },
    nonEmptySampleCount: { type: 'integer', minimum: 0 },
    missingSampleCount: { type: 'integer', minimum: 0 },
    missingSampleRatio: { type: 'number', minimum: 0, maximum: 1 },
    uniqueSampleCount: { type: 'integer', minimum: 0 },
    avgLength: { type: 'number', minimum: 0 },
    maxLength: { type: 'integer', minimum: 0 },
    inferredType: { enum: ['empty', 'number', 'datetime', 'text', 'string'] },
    sampleValues: { type: 'array', items: { type: 'string' } },
    estimatedTotalRows: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const thetaDatasetInspectOutputSchema: JsonSchema = {
  type: 'object',
  required: [
    'filePath',
    'fileName',
    'suffix',
    'supported',
    'encoding',
    'delimiter',
    'rowCount',
    'sampleRowCount',
    'columns',
    'columnProfiles',
    'sampleRows',
    'textColumnCandidates',
  ],
  properties: {
    filePath: { type: 'string' },
    fileName: { type: 'string' },
    suffix: { type: 'string' },
    supported: { type: 'boolean' },
    encoding: { type: 'string' },
    delimiter: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rowCount: { type: 'integer', minimum: 0 },
    sampleRowCount: { type: 'integer', minimum: 0 },
    columns: { type: 'array', items: { type: 'string' } },
    columnProfiles: { type: 'array', items: thetaDatasetColumnProfileSchema },
    sampleRows: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    textColumnCandidates: {
      type: 'array',
      items: thetaDatasetColumnCandidateSchema,
    },
  },
  additionalProperties: false,
};

export const thetaDatasetInspectToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetInspect,
  version: '1.0.0',
  displayName: 'Inspect Dataset',
  description:
    'Inspect an allowed local dataset and return its deterministic structure and bounded samples.',
  tags: ['theta', 'dataset'],
  inputSchema: thetaDatasetFileInputSchema,
  outputSchema: thetaDatasetInspectOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: 'fail',
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: false,
  },
  source: 'local',
};

const normalizeDatasetInput = (input: unknown): ThetaDatasetFileInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('Dataset input must be an object.');
  }
  return input as ThetaDatasetFileInput;
};

const ensureDatasetInspectOutput = (data: unknown): ThetaDatasetInspectOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('dataset.inspect bridge returned a non-object payload.');
  }
  return data as ThetaDatasetInspectOutput;
};

export const thetaDatasetInspectHandler: ToolHandler<unknown, ThetaDatasetInspectOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const normalized = normalizeDatasetInput(input);
  const resolved = await resolveDatasetFile(normalized.filePath);
  const response = await callThetaBridge(
    'dataset.inspect',
    {
      filePath: resolved.filePath,
      ...(normalized.sampleSize === undefined ? {} : { sampleSize: normalized.sampleSize }),
    },
    {
      runId: context.runId,
      stepId: context.stepId,
    }
  );

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'dataset.inspect bridge command failed.');
  }

  return ensureDatasetInspectOutput(response.data);
};
