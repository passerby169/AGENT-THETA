import { createHash } from 'node:crypto';
import type { PromptMessage } from '@hypha/inference';
import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { z } from 'zod';
import { datasetFactsSchema, type DatasetFacts } from '../dataset-understanding/contracts.js';
import { createMiniMaxProviderFromEnv } from '../providers/minimax.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const viewSchema = z.enum(['schema', 'head', 'sample', 'profiles', 'quality']);

const requestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  facts: datasetFactsSchema,
  observations: z.array(z.record(z.string(), z.unknown())).max(4),
  allowRemoteSamples: z.boolean(),
  remainingExplorationCalls: z.number().int().min(0).max(3),
  validationErrors: z.array(z.string()).max(20).default([]),
});

const decisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request_view'),
    view: viewSchema,
    selectedColumns: z.array(z.string().min(1)).max(10).optional(),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('final'),
    understanding: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('fallback') }),
]);

export type DatasetUnderstandingLanguageRequest = z.infer<typeof requestSchema>;
export type DatasetUnderstandingLanguageDecision = z.infer<typeof decisionSchema>;

export interface DatasetUnderstandingLanguageResult {
  schemaVersion: '1.0.0';
  source: 'minimax' | 'deterministic';
  factsHash: string;
  decision: DatasetUnderstandingLanguageDecision;
  fallbackReason?:
    | 'provider_not_configured'
    | 'provider_error'
    | 'invalid_output'
    | 'tool_budget_exhausted'
    | 'illegal_tool_request';
  telemetry: Record<string, unknown>;
}

const inputSchema: JsonSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'facts',
    'observations',
    'allowRemoteSamples',
    'remainingExplorationCalls',
    'validationErrors',
  ],
  properties: {
    schemaVersion: { const: '1.0.0' },
    facts: { type: 'object', additionalProperties: true },
    observations: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: true } },
    allowRemoteSamples: { type: 'boolean' },
    remainingExplorationCalls: { type: 'integer', minimum: 0, maximum: 3 },
    validationErrors: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: 'object',
  required: ['schemaVersion', 'source', 'factsHash', 'decision', 'telemetry'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    source: { enum: ['minimax', 'deterministic'] },
    factsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    decision: { type: 'object', additionalProperties: true },
    fallbackReason: { type: 'string' },
    telemetry: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaDatasetUnderstandingLanguageToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetUnderstandingLanguage,
  version: '1.0.0',
  displayName: 'Interpret Bounded Dataset Evidence',
  description:
    'Ask MiniMax for one bounded dataset-understanding decision without exposing file paths or unapproved samples.',
  tags: ['theta', 'dataset', 'understanding', 'language', 'inference'],
  inputSchema,
  outputSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.inferenceUse,
  ],
  humanApprovalPolicy: {
    required: true,
    reason:
      'Sending sanitized dataset statistics to MiniMax requires explicit session consent.',
  },
  idempotencyPolicy: { mode: 'required' },
  timeoutPolicy: { timeoutMs: 75_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: true },
  source: 'local',
};

export const thetaDatasetUnderstandingLanguageHandler: ToolHandler<
  unknown,
  DatasetUnderstandingLanguageResult
> = async (input) => {
  const request = requestSchema.parse(input);
  const factsHash = hashFacts(request.facts);
  const provider = createMiniMaxProviderFromEnv();
  if (!provider) {
    return fallback(factsHash, 'provider_not_configured');
  }
  try {
    const response = await provider.infer({
      runId: `theta-understanding-${request.facts.datasetHash.slice(0, 16)}`,
      stepId: `understanding-${4 - request.remainingExplorationCalls}`,
      modelAlias: provider.model,
      input: { messages: promptMessages(sanitize(request)) },
      options: { temperature: 0.1, maxTokens: 1000, extra: { toolChoice: 'none' } },
      trace: true,
      metadata: {
        purpose: 'dataset_understanding',
        datasetRef: request.facts.datasetRef,
        remoteSamplesAllowed: request.allowRemoteSamples,
      },
    });
    const decision = decisionSchema.parse(response.output);
    return {
      schemaVersion: '1.0.0',
      source: 'minimax',
      factsHash,
      decision,
      telemetry: {
        provider: provider.id,
        model: provider.model,
        remainingExplorationCalls: request.remainingExplorationCalls,
        remoteSamplesAllowed: request.allowRemoteSamples,
      },
    };
  } catch (error) {
    return fallback(
      factsHash,
      error instanceof z.ZodError ? 'invalid_output' : 'provider_error',
    );
  }
};

const sanitize = (
  request: DatasetUnderstandingLanguageRequest,
): DatasetUnderstandingLanguageRequest => ({
  ...request,
  facts: {
    ...request.facts,
    fileName: 'registered-dataset',
    columns: request.facts.columns.map((column) => ({
      ...column,
      sampleValues: request.allowRemoteSamples ? column.sampleValues : [],
    })),
  },
  observations: request.observations.map((observation) =>
    request.allowRemoteSamples
      ? observation
      : withoutKeys(
          observation,
          new Set(['head', 'sample', 'samples', 'sampleValues']),
        ) as Record<string, unknown>,
  ),
});

const promptMessages = (
  request: DatasetUnderstandingLanguageRequest,
): PromptMessage[] => [
  {
    role: 'system',
    content: [
      'You are THETA dataset understanding planner.',
      'Use only the supplied bounded observations.',
      'Never request paths, files, shell, network, writes, approval, planning, or training actions.',
      'Return JSON only.',
      'If more evidence is essential, return {"kind":"request_view","view":"schema|head|sample|profiles|quality","selectedColumns":[...],"reason":"..."}.',
      'Request head or sample only when allowRemoteSamples is true.',
      'Otherwise return {"kind":"final","understanding":{domain,analysisUnit,evidenceReferences,textColumns,timeColumns,idColumns,metadataColumns,groupColumns,covariateColumns,evaluationColumns,ignoredColumns,qualityWarnings,assumptions,confidence}}.',
      'Column roles must reference supplied columns. Do not add identity, provenance, schemaVersion, datasetRef, or datasetHash.',
      request.validationErrors.length > 0
        ? `Repair these validation errors: ${request.validationErrors.join(' | ')}`
        : '',
    ].filter(Boolean).join(' '),
  },
  { role: 'user', content: JSON.stringify(request) },
];

const fallback = (
  factsHash: string,
  fallbackReason: NonNullable<DatasetUnderstandingLanguageResult['fallbackReason']>,
): DatasetUnderstandingLanguageResult => ({
  schemaVersion: '1.0.0',
  source: 'deterministic',
  factsHash,
  decision: { kind: 'fallback' },
  fallbackReason,
  telemetry: { remoteProviderCalled: fallbackReason !== 'provider_not_configured' },
});

const hashFacts = (facts: DatasetFacts): string =>
  createHash('sha256').update(JSON.stringify(facts)).digest('hex');

const withoutKeys = (
  value: unknown,
  blocked: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, blocked));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blocked.has(key))
      .map(([key, item]) => [key, withoutKeys(item, blocked)]),
  );
};
