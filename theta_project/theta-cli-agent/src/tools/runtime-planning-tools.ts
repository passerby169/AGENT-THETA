import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { probeThetaPythonModules } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const modelInput: JsonSchema = {
  type: 'object', required: ['modelId'],
  properties: { modelId: { type: 'string', pattern: '^[a-z0-9_-]+$' } },
  additionalProperties: false,
};

const runtimeSpec = (id: string, name: string, description: string, inputSchema: JsonSchema): ToolSpec => ({
  id, version: '1.0.0', displayName: name, description,
  tags: ['theta', 'runtime', 'planner-v3'], inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'read', permissionScope: [THETA_PERMISSION_SCOPES.runtimeRead],
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' }, retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true }, source: 'local',
});

export const thetaRuntimeProfileHardwareToolSpec = runtimeSpec(
  THETA_TOOL_IDS.runtimeProfileHardware, 'Profile local hardware',
  'Return local CPU and memory facts used for bounded plan estimates.',
  { type: 'object', additionalProperties: false },
);
export const thetaRuntimeCheckDependenciesToolSpec = runtimeSpec(
  THETA_TOOL_IDS.runtimeCheckDependencies, 'Check model dependencies',
  'Check the active THETA Python environment for the exact packages required by one model.', modelInput,
);
export const thetaRuntimeCheckModelAssetsToolSpec = runtimeSpec(
  THETA_TOOL_IDS.runtimeCheckModelAssets, 'Check model assets',
  'Check local model assets and disclose whether a plan may require network access.', modelInput,
);
export const thetaRuntimeCheckOfflineReadinessToolSpec = runtimeSpec(
  THETA_TOOL_IDS.runtimeCheckOfflineReadiness, 'Check offline readiness',
  'Combine audited model capability, installed dependencies and local assets into an objective offline readiness result.', modelInput,
);
export const thetaRuntimeEstimateCandidateToolSpec = runtimeSpec(
  THETA_TOOL_IDS.runtimeEstimateCandidate, 'Estimate candidate cost',
  'Estimate bounded resource and training-run scale from a candidate model and protocol. This is an estimate, not a model recommendation.',
  {
    type: 'object', required: ['modelId', 'rowCount', 'trainingRuns'],
    properties: {
      modelId: { type: 'string', pattern: '^[a-z0-9_-]+$' },
      rowCount: { type: 'integer', minimum: 1 },
      trainingRuns: { type: 'integer', minimum: 1, maximum: 100 },
    }, additionalProperties: false,
  },
);

export const thetaRuntimeProfileHardwareHandler: ToolHandler<unknown, Record<string, unknown>> = async () => ({
  platform: process.platform,
  architecture: process.arch,
  cpuLogicalCores: os.cpus().length,
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
  condaEnvironment: process.env.CONDA_DEFAULT_ENV ?? null,
  pythonConfigured: process.env.THETA_AGENT_PYTHON ?? process.env.THETA_AGENT_BRIDGE_PYTHON ?? 'python',
});

export const thetaRuntimeCheckDependenciesHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const card = new CapabilityRegistry().require(String(record(input).modelId));
  const packageToModule: Record<string, string> = {
    'scikit-learn': 'sklearn', 'sentence-transformers': 'sentence_transformers', 'umap-learn': 'umap',
  };
  const modules = card.implementation.runtimePackages.map((name) => packageToModule[name] ?? name.replaceAll('-', '_'));
  const probe = probeThetaPythonModules(modules);
  const missing = Object.entries(probe.modules).filter(([, present]) => !present).map(([name]) => name);
  return { modelId: card.modelId, python: probe.executable, version: probe.version, modules: probe.modules, missing, ready: missing.length === 0 };
};

export const thetaRuntimeCheckModelAssetsHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const card = new CapabilityRegistry().require(String(record(input).modelId));
  const sbertPath = process.env.SBERT_MODEL_PATH?.trim();
  const requiresSbert = card.catalog.requires.includes('sbert');
  const sbertReady = !requiresSbert || Boolean(sbertPath && existsSync(path.resolve(sbertPath)));
  return {
    modelId: card.modelId,
    requiresSbert,
    sbertModelPath: sbertPath ? path.resolve(sbertPath) : null,
    localAssetsReady: sbertReady,
    networkMayBeRequired: requiresSbert && !sbertReady,
    limitations: card.limitations,
  };
};

export const thetaRuntimeCheckOfflineReadinessHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const modelId = String(record(input).modelId);
  const card = new CapabilityRegistry().require(modelId);
  const dependencies = await thetaRuntimeCheckDependenciesHandler({ modelId }, context) as Record<string, unknown>;
  const assets = await thetaRuntimeCheckModelAssetsHandler({ modelId }, context) as Record<string, unknown>;
  const ready = dependencies.ready === true && assets.localAssetsReady === true && card.capabilities.offlineExecution !== 'unsupported';
  return { modelId, ready, auditedSupport: card.capabilities.offlineExecution, dependencies, assets };
};

export const thetaRuntimeEstimateCandidateHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const value = record(input);
  const card = new CapabilityRegistry().require(String(value.modelId));
  const rows = Number(value.rowCount);
  const runs = Number(value.trainingRuns);
  const familyWeight: Record<string, number> = {
    probabilistic_bow: 1, short_text_probabilistic: 1.5, structural_covariate: 2,
    dynamic_neural: 4, embedding_clustering: 4, llm_embedding_neural: 6,
  };
  const score = rows * runs * (familyWeight[card.implementation.family] ?? 2);
  return {
    modelId: card.modelId, rowCount: rows, trainingRuns: runs,
    computeScale: score < 10_000 ? 'low' : score < 200_000 ? 'medium' : 'high',
    cpuSupport: card.capabilities.cpuExecution,
    timeLevel: score < 20_000 ? 'minutes' : score < 500_000 ? 'hours' : 'long_running',
    note: 'Bounded heuristic from row count, run count and audited model family; dry-run remains authoritative.',
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

