import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { FtsEvidenceIndex } from '../rag/fts-index.js';
import type { EvidenceRef } from '../rag/contracts.js';
import { thetaRagSearchHandler } from './rag-search-tool.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const evidenceIdsInput: JsonSchema = {
  type: 'object', required: ['evidenceIds'],
  properties: { evidenceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } } },
  additionalProperties: false,
};

const spec = (id: string, name: string, description: string, inputSchema: JsonSchema): ToolSpec => ({
  id, version: '1.0.0', displayName: name, description, tags: ['theta', 'rag', 'planner-v3'],
  inputSchema, outputSchema: { type: 'object', additionalProperties: true }, sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.ragRead], timeoutPolicy: { timeoutMs: 10_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 }, auditPolicy: { enabled: true, includeInput: true, includeOutput: true }, source: 'local',
});

export const thetaRagGetEvidenceToolSpec = spec(THETA_TOOL_IDS.ragGetEvidence, 'Read selected evidence', 'Read evidence objects by exact legal ID.', evidenceIdsInput);
export const thetaRagFindConflictsToolSpec = spec(THETA_TOOL_IDS.ragFindConflicts, 'Find evidence conflicts', 'Search and group evidence that declares the same conflict group.', {
  type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1 }, modelIds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false,
});
export const thetaRagCompareModelsToolSpec = spec(THETA_TOOL_IDS.ragCompareModels, 'Compare model evidence', 'Retrieve evidence coverage for two or more named models without choosing a winner.', {
  type: 'object', required: ['modelIds', 'query'], properties: { modelIds: { type: 'array', minItems: 2, maxItems: 6, uniqueItems: true, items: { type: 'string' } }, query: { type: 'string', minLength: 1 } }, additionalProperties: false,
});
export const thetaRagCheckClaimSupportToolSpec = spec(THETA_TOOL_IDS.ragCheckClaimSupport, 'Check claim support', 'Search for bounded support and conflicts for one candidate claim. No evidence is reported explicitly.', {
  type: 'object', required: ['claim'], properties: { claim: { type: 'string', minLength: 1 }, modelIds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false,
});

export const thetaRagGetEvidenceHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const ids = record(input).evidenceIds as string[];
  return withIndex((index) => {
    const evidence = ids.map((id) => index.getEvidence(id));
    const missing = ids.filter((_id, position) => evidence[position] === undefined);
    if (missing.length) throw new Error(`Unknown evidence ID(s): ${missing.join(', ')}.`);
    return { evidence: evidence as EvidenceRef[] };
  });
};

export const thetaRagFindConflictsHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const value = record(input);
  const result = await thetaRagSearchHandler({ query: String(value.query), modelIds: value.modelIds as string[] | undefined, limit: 30 }, context) as unknown as Record<string, unknown>;
  const evidence = Array.isArray(result.evidence) ? result.evidence as EvidenceRef[] : [];
  const groups = new Map<string, EvidenceRef[]>();
  for (const item of evidence) if (item.conflictGroupId) groups.set(item.conflictGroupId, [...(groups.get(item.conflictGroupId) ?? []), item]);
  return { conflicts: [...groups.entries()].filter(([, items]) => items.length > 1).map(([conflictGroupId, items]) => ({ conflictGroupId, evidence: items })) };
};

export const thetaRagCompareModelsHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const value = record(input);
  const modelIds = value.modelIds as string[];
  const comparisons = [];
  for (const modelId of modelIds) {
    const result = await thetaRagSearchHandler({ query: `${String(value.query)} ${modelId}`, modelIds: [modelId], limit: 8 }, context) as unknown as Record<string, unknown>;
    comparisons.push({ modelId, evidence: result.evidence ?? [], noEvidence: result.noEvidence ?? true });
  }
  return { comparisons };
};

export const thetaRagCheckClaimSupportHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const value = record(input);
  const result = await thetaRagSearchHandler({ query: String(value.claim), modelIds: value.modelIds as string[] | undefined, limit: 10 }, context) as unknown as Record<string, unknown>;
  return { claim: value.claim, supported: Array.isArray(result.evidence) && result.evidence.length > 0, evidence: result.evidence ?? [], retrievalTrace: result.retrievalTrace };
};

const withIndex = async <T>(operation: (index: FtsEvidenceIndex) => T): Promise<T> => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const databasePath = process.env.THETA_KNOWLEDGE_INDEX ?? path.join(root, '.theta_agent', 'knowledge.sqlite');
  if (!existsSync(databasePath)) throw new Error('THETA knowledge index has not been built.');
  const index = await FtsEvidenceIndex.open(databasePath, root);
  try { return operation(index); } finally { index.close(); }
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
