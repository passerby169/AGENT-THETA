import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { CapabilityRegistry } from '../capabilities/registry.js';
import type { ModelCapabilityCard } from '../capabilities/contracts.js';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const modelIdInput: JsonSchema = {
  type: 'object',
  required: ['modelId'],
  properties: { modelId: { type: 'string', pattern: '^[a-z0-9_-]+$' } },
  additionalProperties: false,
};

const readSpec = (id: string, displayName: string, description: string, inputSchema: JsonSchema): ToolSpec => ({
  id,
  version: '1.0.0',
  displayName,
  description,
  tags: ['theta', 'model', 'planner-v3'],
  inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.modelRead],
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
});

export const thetaModelListAvailableToolSpec = readSpec(
  THETA_TOOL_IDS.modelListAvailable,
  'List executable planning models',
  'List concise, audited and runnable model summaries. Use get_capability or get_parameter_contract for details instead of loading the whole catalog.',
  { type: 'object', additionalProperties: false },
);

export const thetaModelGetCapabilityToolSpec = readSpec(
  THETA_TOOL_IDS.modelGetCapability,
  'Read one model capability',
  'Read objective execution capabilities, maturity, inputs, outputs and limitations for one audited model.',
  modelIdInput,
);

export const thetaModelGetParameterContractToolSpec = readSpec(
  THETA_TOOL_IDS.modelGetParameterContract,
  'Read one model parameter contract',
  'Read only parameters that can be represented and checked for one model, including actual training exposure and legal ranges.',
  modelIdInput,
);

export const thetaModelCompareToolSpec = readSpec(
  THETA_TOOL_IDS.modelCompare,
  'Compare model capabilities',
  'Return an objective side-by-side capability comparison. The tool does not choose a winner.',
  {
    type: 'object', required: ['modelIds'],
    properties: { modelIds: { type: 'array', minItems: 2, maxItems: 6, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9_-]+$' } } },
    additionalProperties: false,
  },
);

export const thetaModelListAvailableHandler: ToolHandler<unknown, Record<string, unknown>> = async (_input, context) => {
  const response = await callThetaBridge('model.catalog', {}, { runId: context.runId, stepId: context.stepId });
  if (response.status !== 'ok') throw new Error(response.error?.message ?? 'model.catalog failed.');
  const catalog = record(response.data);
  const catalogModels = Array.isArray(catalog.models) ? catalog.models.map(record) : [];
  const runnable = new Set(catalogModels.filter((model) => model.runnable === true).map((model) => String(model.id)));
  const registry = new CapabilityRegistry();
  const models = registry.cards
    .filter((card) => registry.plannerEligibleModelIds().includes(card.modelId) && runnable.has(card.modelId))
    .map((card) => ({
      modelId: card.modelId,
      displayName: card.displayName,
      maturity: card.maturity,
      family: card.implementation.family,
      temporalTopics: card.capabilities.temporalTopics,
      metadataEffects: card.capabilities.metadataEffects,
      shortTextOptimized: card.capabilities.shortTextOptimized,
      topicCountMode: card.capabilities.topicCountMode,
      offlineExecution: card.capabilities.offlineExecution,
      cpuExecution: card.capabilities.cpuExecution,
      plannerReason: card.planner.reason,
    }));
  return { models, modelIds: models.map((model) => model.modelId) };
};

export const thetaModelGetCapabilityHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const card = new CapabilityRegistry().require(String(record(input).modelId));
  return capabilitySummary(card);
};

export const thetaModelGetParameterContractHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const card = new CapabilityRegistry().require(String(record(input).modelId));
  return {
    modelId: card.modelId,
    parameters: card.parameters.map((parameter) => ({
      parameterId: parameter.parameterId,
      valueType: parameter.valueType,
      defaultValue: parameter.defaultValue,
      planField: parameter.planField,
      exposure: parameter.exposure,
      usedByTraining: parameter.usedByTraining,
      minimum: parameter.minimum ?? null,
      maximum: parameter.maximum ?? null,
      choices: parameter.choices,
      notes: parameter.notes,
    })),
  };
};

export const thetaModelCompareHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const ids = Array.isArray(record(input).modelIds) ? record(input).modelIds as string[] : [];
  const registry = new CapabilityRegistry();
  return { models: ids.map((modelId) => capabilitySummary(registry.require(modelId))) };
};

const capabilitySummary = (card: ModelCapabilityCard): Record<string, unknown> => ({
  modelId: card.modelId,
  displayName: card.displayName,
  maturity: card.maturity,
  planner: card.planner,
  implementation: card.implementation,
  capabilities: card.capabilities,
  artifacts: card.artifacts,
  limitations: card.limitations,
  unverifiedClaims: card.unverifiedClaims,
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

