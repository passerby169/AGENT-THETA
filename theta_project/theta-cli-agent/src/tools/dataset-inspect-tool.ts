import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  datasetSha256: string;
  fileSizeBytes: number;
  suffix: string;
  supported: boolean;
  encoding: string;
  delimiter: string | null;
  rowCount: number;
  sampleRowCount: number;
  sampleDuplicateRatio: number;
  languageDistribution: Array<{ language: string; ratio: number }>;
  timeCoverage: { start: string | null; end: string | null };
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
    'datasetSha256',
    'fileSizeBytes',
    'suffix',
    'supported',
    'encoding',
    'delimiter',
    'rowCount',
    'sampleRowCount',
    'sampleDuplicateRatio',
    'languageDistribution',
    'timeCoverage',
    'columns',
    'columnProfiles',
    'sampleRows',
    'textColumnCandidates',
  ],
  properties: {
    filePath: { type: 'string' },
    fileName: { type: 'string' },
    datasetSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    fileSizeBytes: { type: 'integer', minimum: 0 },
    suffix: { type: 'string' },
    supported: { type: 'boolean' },
    encoding: { type: 'string' },
    delimiter: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rowCount: { type: 'integer', minimum: 0 },
    sampleRowCount: { type: 'integer', minimum: 0 },
    sampleDuplicateRatio: { type: 'number', minimum: 0, maximum: 1 },
    languageDistribution: {
      type: 'array',
      items: {
        type: 'object',
        required: ['language', 'ratio'],
        properties: {
          language: { type: 'string', minLength: 1 },
          ratio: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    timeCoverage: {
      type: 'object',
      required: ['start', 'end'],
      properties: {
        start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      additionalProperties: false,
    },
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

  const output = ensureDatasetInspectOutput(response.data);
  const textColumn = output.textColumnCandidates[0]?.name;
  const [datasetSha256, fileInfo] = await Promise.all([
    sha256File(resolved.filePath),
    stat(resolved.filePath),
  ]);
  return {
    ...output,
    datasetSha256,
    fileSizeBytes: fileInfo.size,
    sampleDuplicateRatio: sampleDuplicateRatio(output.sampleRows, textColumn),
    languageDistribution: sampleLanguageDistribution(output.sampleRows, textColumn),
    timeCoverage: sampleTimeCoverage(output.sampleRows, output.columnProfiles),
  };
};

const sha256File = async (filename: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

const sampleDuplicateRatio = (
  rows: Array<Record<string, unknown>>,
  textColumn?: string,
): number => {
  if (rows.length === 0) return 0;
  const uniqueRows = new Set(
    rows.map((row) =>
      textColumn
        ? String(row[textColumn] ?? '').trim()
        : JSON.stringify(
            Object.fromEntries(
              Object.entries(row).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
          ),
    ),
  );
  return (rows.length - uniqueRows.size) / rows.length;
};

const sampleLanguageDistribution = (
  rows: Array<Record<string, unknown>>,
  textColumn?: string,
): Array<{ language: string; ratio: number }> => {
  const text = rows
    .flatMap((row) =>
      textColumn ? [row[textColumn]] : Object.values(row),
    )
    .filter((value): value is string => typeof value === 'string')
    .join('');
  const cjkCount = [...text].filter((character) =>
    /[\u3400-\u9fff]/.test(character),
  ).length;
  const latinCount = [...text].filter((character) =>
    /[A-Za-z]/.test(character),
  ).length;
  const total = cjkCount + latinCount;
  if (total === 0) return [];
  return [
    ...(cjkCount === 0
      ? []
      : [{ language: 'zh-Hans', ratio: cjkCount / total }]),
    ...(latinCount === 0
      ? []
      : [{ language: 'latin', ratio: latinCount / total }]),
  ];
};

const sampleTimeCoverage = (
  rows: Array<Record<string, unknown>>,
  profiles: ThetaDatasetColumnProfile[],
): { start: string | null; end: string | null } => {
  const timeColumns = profiles
    .filter(
      (profile) =>
        profile.inferredType === 'datetime' ||
        /(date|time|created|updated|timestamp)/i.test(profile.name),
    )
    .map((profile) => profile.name);
  const timestamps = rows
    .flatMap((row) => timeColumns.map((column) => row[column]))
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    start:
      timestamps.length === 0
        ? null
        : new Date(timestamps[0]).toISOString(),
    end:
      timestamps.length === 0
        ? null
        : new Date(timestamps[timestamps.length - 1]).toISOString(),
  };
};
