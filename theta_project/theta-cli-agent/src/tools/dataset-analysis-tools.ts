import { randomUUID } from 'node:crypto';
import { hashCanonicalJson, type JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { SQLiteDatasetObservationStore } from '../storage/dataset-observation-store.js';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { SQLiteRemoteSampleAuthorizationStore } from '../storage/remote-sample-authorization-store.js';
import { SQLiteDatasetExplorationCache, THETA_DATASET_READER_VERSION } from '../storage/dataset-exploration-cache.js';
import { defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { createThetaRuntimeComposition } from '../persistence/runtime-composition.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { callThetaBridge } from './bridge.js';
import type { ExploreColumnProfile, ThetaDatasetExploreOutput } from './dataset-exploration-contracts.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';
import { isPrimaryTextRole } from '../workspaces/dataset-column-roles.js';

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
  properties: {
    datasetRef: { type: 'string', minLength: 1, description: 'Optional compatibility hint. Runtime binds the governed current dataset.' },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
};

const columnsInputSchema: JsonSchema = {
  type: 'object',
  required: ['columns'],
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    sheetName: { type: 'string', minLength: 1, maxLength: 256 },
    columns: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};

const columnInputSchema: JsonSchema = {
  type: 'object',
  required: ['column'],
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
  version: '3.1.0',
  displayName: id,
  description,
  tags: ['theta', 'dataset', 'v6'],
  inputSchema,
  outputSchema: aggregateOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
  source: 'local',
});

export const thetaDatasetOverviewToolSpec = spec(
  THETA_TOOL_IDS.datasetOverview,
  'Read the current governed dataset shape, columns, format, sheets, aggregate role candidates, quality warnings and domain hints without returning row samples. Runtime binds the dataset; do not invent datasetRef.',
);
export const thetaDatasetColumnProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetColumnProfile,
  'Profile selected columns by type, missingness, uniqueness and lengths. Prefer stable columnRef values returned by overview.',
  columnsInputSchema,
);
export const thetaDatasetTextProfileToolSpec = spec(
  THETA_TOOL_IDS.datasetTextProfile,
  'Analyze one candidate text column using aggregate length, language and duplicate statistics. Prefer the stable columnRef returned by overview.',
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
      properties: {
        datasetRef: { type: 'string', minLength: 1, description: 'Optional compatibility hint. Runtime binds the governed current dataset.' },
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
      required: ['narrative', 'statements', 'columnRoles'],
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
  const input = bindDatasetInput(raw, context);
  const { data, runtimeDb, resolvedInput } = await explore(input, context);
  return observedOutput(toolId, data, project(data, resolvedInput), context, runtimeDb);
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
  columnDefinitions: data.columnDefinitions,
  candidateRoles: data.candidateRoles,
  inferredDomain: data.inferredDomain,
  profileBasis: profileBasis(data),
  qualityWarnings: data.qualityWarnings,
}));

export const thetaDatasetColumnProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetColumnProfile, (data, input) => ({
  profiles: selectProfiles(data, input.columns).map((profile) => profileForTool(data, profile)),
  basis: profileBasis(data),
}));

export const thetaDatasetTextProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetTextProfile, (data, input) => ({
  profile: profileForTool(data, requireProfile(data, input.column)),
  ...(isBoundedProfile(data)
    ? {
        estimatedLanguageDistribution: data.languageDistribution,
        estimatedDuplicateRatio: data.duplicateRatio,
      }
    : {
        languageDistribution: data.languageDistribution,
        duplicateRatio: data.duplicateRatio,
      }),
  basis: profileBasis(data),
}));

export const thetaDatasetTimeProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetTimeProfile, (data, input) => ({
  profile: profileForTool(data, requireProfile(data, input.column)),
  ...(isBoundedProfile(data)
    ? { observedSampleTimeCoverage: data.timeCoverage }
    : { timeCoverage: data.timeCoverage }),
  basis: profileBasis(data),
}));

export const thetaDatasetCategoricalProfileHandler = analysisHandler(THETA_TOOL_IDS.datasetCategoricalProfile, (data, input) => ({
  profiles: selectProfiles(data, input.columns).map((profile) => profileForTool(data, profile)),
  basis: profileBasis(data),
}));

export const thetaDatasetMissingnessHandler = analysisHandler(THETA_TOOL_IDS.datasetMissingness, (data, input) => ({
  columns: selectProfiles(data, input.columns).map((profile) => isBoundedProfile(data)
    ? { name: profile.name, columnRef: profile.columnRef, estimatedMissingRatio: profile.missingRatio }
    : { name: profile.name, columnRef: profile.columnRef, missingRatio: profile.missingRatio }),
  basis: profileBasis(data),
}));

export const thetaDatasetDuplicatesHandler = analysisHandler(THETA_TOOL_IDS.datasetDuplicates, (data, input) => ({
  column: requireProfile(data, input.column).name,
  ...(isBoundedProfile(data)
    ? { estimatedDuplicateRatio: data.duplicateRatio }
    : { duplicateRatio: data.duplicateRatio }),
  profiledRows: data.samplePolicy?.profileRows ?? null,
  basis: profileBasis(data),
}));

export const thetaDatasetRelationshipsHandler = analysisHandler(THETA_TOOL_IDS.datasetRelationships, (data, input) => ({
  relationships: pairwiseRelationships(data.sampleRows, requiredColumns(input.columns, data.columns)),
  basis: { rows: data.sampleRows.length, bounded: true },
}));

export const thetaDatasetSampleHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = bindDatasetInput(raw, context);
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
    const { data, resolvedInput } = await explore({ ...input, sampleSize: Math.min(receipt.maxRows, input.sampleSize ?? 10) }, context);
    const selected = resolvedInput.columns;
    const sampleRows = selected?.length
      ? data.sampleRows.map((row) => Object.fromEntries([...selected, '_theta_sample_id'].filter((key) => key in row).map((key) => [key, row[key]])))
      : data.sampleRows;
    const material = {
      datasetRef: data.datasetRef,
      datasetHash: data.datasetHash,
      authorizationReceiptId: receipt.receiptId,
      sampleRows: sampleRows.slice(0, receipt.maxRows),
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
  const input = bindDatasetUnderstandingInput(raw, context);
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
    const resolvedRoles = (input.columnRoles ?? []).map((role) => ({ ...role, column: resolveColumnIdentifier(data, role.column) }));
    for (const role of resolvedRoles) assertConfidence(role.confidence);
    const primaryTextRoles = resolvedRoles.filter(isPrimaryTextRole);
    if (primaryTextRoles.length !== 1) {
      throw new Error(`Dataset understanding must propose exactly one existing primary_text column before it can finish; found ${primaryTextRoles.length}.`);
    }
    for (const statement of input.statements ?? []) assertConfidence(statement.confidence);
    const refs = [
      ...(input.statements ?? []).flatMap((item) => item.observationRefs ?? []),
      ...resolvedRoles.flatMap((item) => item.observationRefs ?? []),
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
        narrative: appendProfileBasisNote(input.narrative.trim(), data),
        statements: (input.statements ?? []).map((statement, index) => ({ id: `dataset-statement:${index + 1}:${hashCanonicalJson(statement).slice(-12)}`, semanticLabel: statement.semanticLabel, statement: statement.statement, epistemicStatus: statement.epistemicStatus, confidence: statement.confidence, sourceRefs: statement.observationRefs })),
        columnRoles: resolvedRoles.map((role) => ({
          column: role.column,
          proposedRole: role.proposedRole,
          confidence: role.confidence,
          epistemicStatus: 'proposed' as const,
          sourceRefs: role.observationRefs,
        })),
        risks: appendProfileBasisRisk(input.risks ?? [], data),
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
  const cache = new SQLiteDatasetExplorationCache(runtimeDb);
  try {
    const record = registry.require(input.datasetRef, owner);
    let data = cache.get(record.sha256, input.sheetName);
    if (!data) {
      const response = await callThetaBridge('dataset.explore', {
        filePath: record.managedPath,
        datasetRef: record.datasetRef,
        datasetHash: record.sha256,
        fileName: record.displayName,
        sizeBytes: record.sizeBytes,
        sheetName: input.sheetName,
        sampleSize: 10,
      }, { runId: context.runId, stepId: context.stepId });
      if (response.status !== 'ok') throw new Error(response.error?.message ?? 'Dataset analysis failed.');
      data = response.data as ThetaDatasetExploreOutput;
      if (data.readerVersion !== THETA_DATASET_READER_VERSION) {
        throw new Error(`Dataset reader version mismatch: expected ${THETA_DATASET_READER_VERSION}, received ${data.readerVersion ?? '(missing)'}.`);
      }
      cache.put(record.sha256, input.sheetName, data);
    }
    const resolvedInput: DatasetToolInput = {
      ...input,
      ...(input.column === undefined ? {} : { column: resolveColumnIdentifier(data, input.column) }),
      ...(input.columns === undefined ? {} : { columns: input.columns.map((column) => resolveColumnIdentifier(data as ThetaDatasetExploreOutput, column)) }),
    };
    return { data: { ...data, datasetRef: record.datasetRef, fileName: record.displayName }, runtimeDb, resolvedInput };
  } finally {
    cache.close();
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

const objectInput = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Dataset tool input must be an object.');
  return raw as Record<string, unknown>;
};

const boundDatasetRef = (raw: Record<string, unknown>, context: ToolCallContext): string => {
  const governed = context.metadata?.datasetRef;
  if (typeof governed === 'string' && governed.trim()) return governed;
  if (typeof raw.datasetRef === 'string' && raw.datasetRef.trim()) return raw.datasetRef;
  throw new Error('当前工具上下文没有绑定数据集，请返回数据接入阶段重新选择文件。');
};

const bindDatasetInput = (raw: unknown, context: ToolCallContext): DatasetToolInput => {
  const input = objectInput(raw);
  return { ...input, datasetRef: boundDatasetRef(input, context) } as DatasetToolInput;
};

const bindDatasetUnderstandingInput = (
  raw: unknown,
  context: ToolCallContext,
): DatasetUnderstandingInput => {
  const input = objectInput(raw);
  return { ...input, datasetRef: boundDatasetRef(input, context) } as unknown as DatasetUnderstandingInput;
};

const withoutValues = ({ sampleValues: _sampleValues, ...profile }: ExploreColumnProfile) => profile;

const isBoundedProfile = (data: ThetaDatasetExploreOutput): boolean =>
  data.samplePolicy?.profileTruncated === true;

const profileForTool = (
  data: ThetaDatasetExploreOutput,
  profile: ExploreColumnProfile,
): Record<string, unknown> => {
  const safe = withoutValues(profile) as ExploreColumnProfile & { nonEmptyCount?: number };
  if (!isBoundedProfile(data)) return safe as unknown as Record<string, unknown>;
  return {
    name: safe.name,
    ...(safe.columnRef === undefined ? {} : { columnRef: safe.columnRef }),
    inferredType: safe.inferredType,
    sampleNonEmptyCount: safe.nonEmptyCount,
    estimatedMissingRatio: safe.missingRatio,
    sampleUniqueCount: safe.uniqueCount,
    ...(safe.uniqueRatio === undefined ? {} : { estimatedUniqueRatio: safe.uniqueRatio }),
    estimatedAverageLength: safe.averageLength,
    sampleMaximumLength: safe.maximumLength,
    ...(safe.parseSuccessRatio === undefined ? {} : { estimatedParseSuccessRatio: safe.parseSuccessRatio }),
  };
};

const profileBasisNote = (data: ThetaDatasetExploreOutput): string | undefined => {
  if (!isBoundedProfile(data)) return undefined;
  return `统计口径：完整行数为 ${data.rowCount}；其余列画像基于 ${data.samplePolicy?.profileRows ?? 0} 行确定性蓄水池样本，唯一值、比例、长度、语言、重复和时间覆盖均为样本观察或估计，不代表全量精确统计。`;
};

const appendProfileBasisNote = (narrative: string, data: ThetaDatasetExploreOutput): string => {
  const note = profileBasisNote(data);
  if (!note || narrative.includes('确定性蓄水池样本')) return narrative;
  return `${narrative}\n\n${note}`;
};

const appendProfileBasisRisk = (risks: string[], data: ThetaDatasetExploreOutput): string[] => {
  const note = profileBasisNote(data);
  return note === undefined ? risks : [...new Set([...risks, note])];
};

const requiredColumns = (selected: string[] | undefined, all: readonly string[]): string[] => {
  if (!selected?.length) throw new Error('At least one column is required.');
  const unknown = selected.filter((column) => !all.includes(column));
  if (unknown.length) throw new Error(`Unknown dataset columns: ${unknown.join(', ')}`);
  return [...new Set(selected)];
};

const resolveColumnIdentifier = (data: ThetaDatasetExploreOutput, value: string): string => {
  const definitions = data.columnDefinitions ?? data.columns.map((column, position) => ({
    columnRef: `column_${String(position + 1).padStart(4, '0')}`,
    position,
    originalName: column,
    normalizedName: normalizeColumnIdentifier(column),
    displayName: column,
  }));
  const normalized = normalizeColumnIdentifier(value);
  const matches = definitions.filter((definition) =>
    value === definition.columnRef ||
    value === definition.originalName ||
    value === definition.displayName ||
    normalized === definition.normalizedName ||
    normalized === normalizeColumnIdentifier(definition.displayName));
  if (matches.length === 1) return matches[0].displayName;
  const available = definitions.map((item) => `${item.columnRef}=${item.displayName}`).join('、');
  if (matches.length === 0) throw new Error(`未找到列“${value}”。当前可用列：${available}`);
  throw new Error(`列“${value}”规范化后不唯一，请使用 columnRef。当前可用列：${available}`);
};

const normalizeColumnIdentifier = (value: string): string => {
  const cleaned = value.normalize('NFC').replace(/^\uFEFF/u, '').replace(/[\u200B-\u200D\u0000-\u001F\u007F-\u009F]/gu, '').trim();
  if ([...cleaned].some((character) => character.charCodeAt(0) > 0xff)) return cleaned;
  try {
    const bytes = Uint8Array.from([...cleaned].map((character) => character.charCodeAt(0)));
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return cjkCount(repaired) > cjkCount(cleaned) ? repaired : cleaned;
  } catch {
    return cleaned;
  }
};

const cjkCount = (value: string): number => [...value].filter((character) => /[\u3400-\u9FFF]/u.test(character)).length;

const profileBasis = (data: ThetaDatasetExploreOutput) => ({
  method: data.samplePolicy?.method ?? 'unknown',
  profiledRows: data.samplePolicy?.profileRows ?? data.rowCount,
  totalRows: data.rowCount,
  bounded: data.samplePolicy?.profileTruncated === true,
  interpretation: data.samplePolicy?.profileTruncated === true
    ? '除 totalRows/rowCount 外，唯一值、比例、长度、语言和时间覆盖等画像统计均基于确定性样本，只能作为估计。'
    : '画像统计覆盖全部记录。',
});

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
