import { randomUUID } from 'node:crypto';
import { hashCanonicalJson, type JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { SQLiteDatasetObservationStore } from '../storage/dataset-observation-store.js';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { SQLiteRemoteSampleAuthorizationStore } from '../storage/remote-sample-authorization-store.js';
import { defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { createThetaRuntimeComposition } from '../persistence/runtime-composition.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { callThetaBridge } from './bridge.js';
import type { ExploreColumnProfile, ThetaDatasetExploreOutput } from './dataset-exploration-contracts.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

interface DatasetToolInput {
  datasetRef: string;
  sheetName?: string;
  columns?: string[];
  column?: string;
  sampleSize?: number;
}

interface DatasetUnderstandingInput {
  datasetRef: string;
  narrative: string;
  statements: Array<{ semanticLabel: string; statement: string; epistemicStatus: 'observed' | 'inferred'; confidence: number; observationRefs: string[] }>;
  columnRoles: Array<{ column: string; proposedRole: string; confidence: number; observationRefs: string[] }>;
  risks?: string[];
}

const baseInputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
};

const columnsInputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef', 'columns'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
    columns: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};

const columnInputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef', 'column'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
    column: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const aggregateOutputSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef', 'datasetHash', 'observationRef', 'observationHash', 'analysis'],
  properties: {
    datasetRef: { type: 'string' },
    datasetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    observationRef: { type: 'string' },
    observationHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    analysis: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

const spec = (id: string, description: string, inputSchema: JsonSchema = baseInputSchema): ToolSpec => ({
  id,
  version: '3.0.0',
  displayName: id,
  description,
  tags: ['theta', 'dataset', 'v6'],
  inputSchema,
  outputSchema: aggregateOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: { timeoutMs: 45_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
  source: 'local',
});

export const thetaDatasetOverviewToolSpec = spec(
  THETA_TOOL_IDS.datasetOverview,
  'Read dataset shape, columns, format, sheets, aggregate role candidates, quality warnings and domain hints without returning row samples.',
);
export const thetaDatasetColumnProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetColumnProfile,
  'Profile selected columns by type, missingness, uniqueness and lengths without returning cell values.',
  columnsInputSchema,
);
export const thetaDatasetTextProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetTextProfile,
  'Analyze one candidate text column using aggregate length, language and duplicate statistics.',
  columnInputSchema,
);
export const thetaDatasetTimeProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetTimeProfile,
  'Analyze one candidate time column using parse coverage and observed time range.',
  columnInputSchema,
);
export const thetaDatasetCategoricalProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetCategoricalProfile,
  'Analyze selected grouping or categorical columns using aggregate cardinality and missingness.',
  columnsInputSchema,
);
export const thetaDatasetMissingnessToolSpec = spec(
  THETA_TOOL_IDS.datasetMissingness,
  'Compare missingness across selected columns.',
  columnsInputSchema,
);
export const thetaDatasetDuplicatesToolSpec = spec(
  THETA_TOOL_IDS.datasetDuplicates,
  'Estimate duplicate text or record prevalence for one selected column.',
  columnInputSchema,
);
export const thetaDatasetRelationshipsToolSpec = spec(
  THETA_TOOL_IDS.datasetRelationships,
  'Estimate bounded pairwise association among selected columns without exposing rows.',
  columnsInputSchema,
);

export const thetaDatasetSampleToolSpec: ToolSpec = {
  ...spec(
    THETA_TOOL_IDS.datasetSample,
    'Return at most ten deterministic random rows after local redaction. This tool fails unless the owner granted a current remote-sample authorization receipt.',
    {
      type: 'object',
      required: ['datasetRef'],
      properties: {
        datasetRef: { type: 'string', minLength: 1 },
        sheetName: { type: 'string', minLength: 1, maxLength: 256 },
        columns: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        sampleSize: { type: 'integer', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
  ),
  outputSchema: {
    type: 'object',
    required: ['datasetRef', 'datasetHash', 'authorizationReceiptId', 'observationRef', 'observationHash', 'sampleRows', 'sampleSeed', 'redactionSummary'],
    properties: {
      datasetRef: { type: 'string' },
      datasetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      authorizationReceiptId: { type: 'string' },
      observationRef: { type: 'string' },
      observationHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      sampleRows: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: true } },
      sampleSeed: { type: 'string' },
      redactionSummary: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  },
};

export const thetaDatasetSubmitUnderstandingToolSpec: ToolSpec = {
  ...spec(
    THETA_TOOL_IDS.datasetSubmitUnderstanding,
    'Validate a proposed open dataset understanding against current columns and governed observation receipts. This proposes an artifact; it does not advance the FSM.',
    {
      type: 'object',
      required: ['datasetRef', 'narrative', 'statements', 'columnRoles'],
      properties: {
        datasetRef: { type: 'string', minLength: 1 },
        narrative: { type: 'string', minLength: 1, maxLength: 12000 },
        statements: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['semanticLabel', 'statement', 'epistemicStatus', 'confidence', 'observationRefs'], properties: { semanticLabel: { type: 'string' }, statement: { type: 'string' }, epistemicStatus: { enum: ['observed', 'inferred'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, observationRefs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false } },
        columnRoles: { type: 'array', maxItems: 30, items: { type: 'object', required: ['column', 'proposedRole', 'confidence', 'observationRefs'], properties: { column: { type: 'string' }, proposedRole: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, observationRefs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false } },
        risks: { type: 'array', maxItems: 100, items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  ),
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetWrite],
  outputSchema: {
    type: 'object',
    required: ['valid', 'datasetRef', 'datasetHash', 'workspaceRef', 'workspaceHash', 'revision'],
    properties: {
      valid: { const: true },
      datasetRef: { type: 'string' },
      datasetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      workspaceRef: { type: 'string' },
      workspaceHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      revision: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
};

const analysisHandler = (
  toolId: string,
  project: (data: ThetaDatasetExploreOutput, input: DatasetToolInput) => Record<string, unknown>,
): ToolHandler<unknown, Record<string, unknown>> => async (raw, context) => {
  const input = objectInput(raw);
  const { data, runtimeDb } = await explore(input, context);
  return observedOutput(toolId, data, project(data, input), context, runtimeDb);
};

export const thetaDatasetOverviewHandler = analysisHandler(THETA_TOOL_IDS.datasetOverview, (data) => ({
  fileName: data.fileName,
  format: data.format,
  sizeBytes: data.sizeBytes,
  encoding: data.encoding,
  delimiter: data.delimiter,
  sheets: data.sheets,
  selectedSheet: data.selectedSheet,
  rowCount: data.rowCount,
  columns: data.columns,
  candidateRoles: data.candidateRoles,
  inferredDomain: data.inferredDomain,
  qualityWarnings: data.qualityWarnings,
}));

export const thetaDatasetColumnProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetColumnProfile, (data, input) => ({
  profiles: selectProfiles(data, input.columns).map(withoutValues),
}));

export const thetaDatasetTextProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetTextProfile, (data, input) => ({
  profile: withoutValues(requireProfile(data, input.column)),
  languageDistribution: data.languageDistribution,
  duplicateRatio: data.duplicateRatio,
}));

export const thetaDatasetTimeProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetTimeProfile, (data, input) => ({
  profile: withoutValues(requireProfile(data, input.column)),
  timeCoverage: data.timeCoverage,
}));

export const thetaDatasetCategoricalProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetCategoricalProfile, (data, input) => ({
  profiles: selectProfiles(data, input.columns).map((profile) => ({
    name: profile.name,
    missingRatio: profile.missingRatio,
    uniqueCount: profile.uniqueCount,
    uniqueRatio: profile.uniqueRatio,
    inferredType: profile.inferredType,
  })),
}));

export const thetaDatasetMissingnessHandler = analysisHandler(THETA_TOOL_IDS.datasetMissingness, (data, input) => ({
  columns: selectProfiles(data, input.columns).map((profile) => ({ name: profile.name, missingRatio: profile.missingRatio })),
}));

export const thetaDatasetDuplicatesHandler = analysisHandler(THETA_TOOL_IDS.datasetDuplicates, (data, input) => ({
  column: requireProfile(data, input.column).name,
  duplicateRatio: data.duplicateRatio,
  profiledRows: data.samplePolicy?.profileRows ?? null,
}));

export const thetaDatasetRelationshipsHandler = analysisHandler(THETA_TOOL_IDS.datasetRelationships, (data, input) => ({
  relationships: pairwiseRelationships(data.sampleRows, requiredColumns(input.columns, data.columns)),
  basis: { rows: data.sampleRows.length, bounded: true },
}));

export const thetaDatasetSampleHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = objectInput(raw);
  const runtimeDb = runtimeDbFrom(context);
  const owner = ownerFrom(context);
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  const authorizations = new SQLiteRemoteSampleAuthorizationStore(runtimeDb);
  try {
    const dataset = registry.require(input.datasetRef, owner);
    const receipt = authorizations.requireActive({
      runId: context.runId,
      datasetHash: dataset.sha256,
      ...owner,
    });
    const { data } = await explore({ ...input, sampleSize: Math.min(receipt.maxRows, input.sampleSize ?? 10) }, context);
    const material = {
      datasetRef: data.datasetRef,
      datasetHash: data.datasetHash,
      authorizationReceiptId: receipt.receiptId,
      sampleRows: data.sampleRows.slice(0, receipt.maxRows),
      sampleSeed: data.sampleSeed,
      redactionSummary: data.redactionSummary,
    };
    return observedOutput(THETA_TOOL_IDS.datasetSample, data, material, context, runtimeDb, true);
  } finally {
    authorizations.close();
    registry.close();
  }
};

export const thetaDatasetSubmitUnderstandingHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = raw as DatasetUnderstandingInput;
  if (!input || typeof input !== 'object' || !String(input.narrative ?? '').trim()) {
    throw new Error('Dataset understanding requires a non-empty narrative.');
  }
  const runtimeDb = runtimeDbFrom(context);
  const owner = ownerFrom(context);
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  const observations = new SQLiteDatasetObservationStore(runtimeDb);
  const runtime = await createThetaRuntimeComposition(runtimeDb);
  try {
    const dataset = registry.require(input.datasetRef, owner);
    const { data } = await explore({ datasetRef: input.datasetRef }, context);
    const columns = new Set(data.columns);
    for (const role of input.columnRoles ?? []) { if (!columns.has(role.column)) throw new Error(`Dataset understanding references an unknown column: ${role.column}`); assertConfidence(role.confidence); }
    for (const statement of input.statements ?? []) assertConfidence(statement.confidence);
    const refs = [
      ...(input.statements ?? []).flatMap((item) => item.observationRefs ?? []),
      ...(input.columnRoles ?? []).flatMap((item) => item.observationRefs ?? []),
    ];
    if (refs.length === 0) throw new Error('Dataset understanding must cite at least one governed observation.');
    const receipts = observations.requireAll(context.runId, dataset.sha256, refs);
    const sourceRefs = receipts.map((receipt) => ({
      id: receipt.observationRef,
      kind: 'tool_observation' as const,
      hash: receipt.outputHash,
    }));
    const repository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
    const current = await repository.current(context.runId, 'dataset');
    if (!current) throw new Error('Initial DatasetWorkspace was not found.');
    if (current.datasetHash !== `sha256:${dataset.sha256}`) throw new Error('DatasetWorkspace is bound to a different dataset Hash.');
    const workspace = await repository.revise({
      runId: context.runId,
      sessionId: context.sessionId,
      userId: owner.userId,
      expectedRevision: current.revision,
      draft: {
        workspaceType: 'dataset',
        schemaVersion: '3.1.0',
        runId: context.runId,
        datasetHash: `sha256:${dataset.sha256}`,
        narrative: input.narrative.trim(),
        statements: (input.statements ?? []).map((statement, index) => ({ id: `dataset-statement:${index + 1}:${hashCanonicalJson(statement).slice(-12)}`, semanticLabel: statement.semanticLabel, statement: statement.statement, epistemicStatus: statement.epistemicStatus, confidence: statement.confidence, sourceRefs: statement.observationRefs })),
        columnRoles: (input.columnRoles ?? []).map((role) => ({ column: role.column, proposedRole: role.proposedRole, confidence: role.confidence, sourceRefs: role.observationRefs })),
        risks: input.risks ?? [],
        sourceRefs,
      },
      reason: 'Dataset Agent submitted a concise evidence-grounded understanding.',
      invalidates: ['checkpoint', 'plan', 'approval', 'dry_run', 'training_approval'],
    });
    return {
      valid: true,
      datasetRef: dataset.datasetRef,
      datasetHash: dataset.sha256,
      workspaceRef: `workspace:dataset:${workspace.revision}`,
      workspaceHash: workspace.workspaceHash,
      revision: workspace.revision,
    };
  } finally {
    runtime.close();
    observations.close();
    registry.close();
  }
};

const explore = async (input: DatasetToolInput, context: ToolCallContext) => {
  const runtimeDb = runtimeDbFrom(context);
  const owner = ownerFrom(context);
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try {
    const record = registry.require(input.datasetRef, owner);
    const response = await callThetaBridge('dataset.explore', {
      filePath: record.managedPath,
      datasetRef: record.datasetRef,
      datasetHash: record.sha256,
      fileName: record.displayName,
      sizeBytes: record.sizeBytes,
      sheetName: input.sheetName,
      sampleSize: input.sampleSize,
      selectedColumns: input.columns ?? (input.column ? [input.column] : undefined),
    }, { runId: context.runId, stepId: context.stepId });
    if (response.status !== 'ok') throw new Error(response.error?.message ?? 'Dataset analysis failed.');
    return { data: response.data as ThetaDatasetExploreOutput, runtimeDb };
  } finally {
    registry.close();
  }
};

const observedOutput = (
  toolId: string,
  data: ThetaDatasetExploreOutput,
  analysis: Record<string, unknown>,
  context: ToolCallContext,
  runtimeDb: string,
  sample = false,
): Record<string, unknown> => {
  const observationRef = `observation:${context.invocationId ?? randomUUID()}`;
  const material = sample ? analysis : { datasetRef: data.datasetRef, datasetHash: data.datasetHash, analysis };
  const observationHash = hashCanonicalJson(material);
  const store = new SQLiteDatasetObservationStore(runtimeDb);
  try {
    store.record({
      observationRef,
      runId: context.runId,
      datasetHash: data.datasetHash,
      toolId,
      outputHash: observationHash,
      observedAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
  return sample
    ? { ...analysis, observationRef, observationHash }
    : { datasetRef: data.datasetRef, datasetHash: data.datasetHash, observationRef, observationHash, analysis };
};

const runtimeDbFrom = (context: ToolCallContext): string => {
  const value = context.metadata?.thetaRuntimeDb;
  return typeof value === 'string' && value.trim() ? value : defaultThetaV6RuntimeDb();
};

const ownerFrom = (context: ToolCallContext) => ({
  userId: context.userId ?? context.principal?.userId ?? 'local_user',
  workspaceId: context.workspaceId ?? context.principal?.workspaceId ?? 'local_workspace',
});

const objectInput = (raw: unknown): DatasetToolInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Dataset tool input must be an object.');
  return raw as DatasetToolInput;
};

const withoutValues = ({ sampleValues: _sampleValues, ...profile }: ExploreColumnProfile) => profile;

const requiredColumns = (selected: string[] | undefined, all: readonly string[]): string[] => {
  if (!selected?.length) throw new Error('At least one column is required.');
  const unknown = selected.filter((column) => !all.includes(column));
  if (unknown.length) throw new Error(`Unknown dataset columns: ${unknown.join(', ')}`);
  return [...new Set(selected)];
};

const selectProfiles = (data: ThetaDatasetExploreOutput, selected?: string[]): ExploreColumnProfile[] => {
  const columns = requiredColumns(selected, data.columns);
  return columns.map((column) => requireProfile(data, column));
};

const requireProfile = (data: ThetaDatasetExploreOutput, column?: string): ExploreColumnProfile => {
  if (!column || !data.columns.includes(column)) throw new Error(`Unknown dataset column: ${column ?? '(missing)'}`);
  const profile = data.columnProfiles.find((candidate) => candidate.name === column);
  if (!profile) throw new Error(`Column profile was not produced: ${column}`);
  return profile;
};

const pairwiseRelationships = (rows: Array<Record<string, unknown>>, columns: readonly string[]) => {
  const results: Array<Record<string, unknown>> = [];
  for (let leftIndex = 0; leftIndex < columns.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < columns.length; rightIndex += 1) {
      const left = columns[leftIndex];
      const right = columns[rightIndex];
      const pairs = rows
        .map((row) => [String(row[left] ?? '').trim(), String(row[right] ?? '').trim()] as const)
        .filter(([a, b]) => a && b);
      const consistency = (sourceIndex: 0 | 1, targetIndex: 0 | 1) => {
        const groups = new Map<string, Map<string, number>>();
        for (const pair of pairs) {
          const group = groups.get(pair[sourceIndex]) ?? new Map<string, number>();
          group.set(pair[targetIndex], (group.get(pair[targetIndex]) ?? 0) + 1);
          groups.set(pair[sourceIndex], group);
        }
        const modal = [...groups.values()].reduce((sum, group) => sum + Math.max(...group.values()), 0);
        return pairs.length ? modal / pairs.length : 0;
      };
      results.push({
        left,
        right,
        pairedRows: pairs.length,
        directionalConsistency: {
          leftToRight: consistency(0, 1),
          rightToLeft: consistency(1, 0),
        },
      });
    }
  }
  return results;
};

const assertConfidence = (value: number): void => {
  if (typeof value !== 'number' || value < 0 || value > 1) throw new Error('Confidence must be between 0 and 1.');
};
