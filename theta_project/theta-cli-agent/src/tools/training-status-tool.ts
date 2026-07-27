import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import type {
  ThetaExpectedArtifact,
  ThetaTrainingCommand,
} from './training-dry-run-tool.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaTrainingStatusInput {
  trainingRunId: string;
  logLimit?: number;
}

export interface ThetaTrainingStatusOutput {
  trainingRunId: string;
  found: boolean;
  status: string;
  logs: string[];
  artifacts: ThetaExpectedArtifact[];
  planId?: string;
  planHash?: string;
  approvalId?: string;
  progress?: number;
  pid?: number | null;
  currentStep?: string;
  commands?: ThetaTrainingCommand[];
  errorMessage?: string | null;
  logPath?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  events?: Array<{
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

const trainingStatusInputSchema: JsonSchema = {
  type: 'object',
  required: ['trainingRunId'],
  properties: {
    trainingRunId: { type: 'string', minLength: 1 },
    logLimit: { type: 'integer', minimum: 1, maximum: 500 },
  },
  additionalProperties: false,
};

const trainingStatusOutputSchema: JsonSchema = {
  type: 'object',
  required: ['trainingRunId', 'found', 'status', 'logs', 'artifacts'],
  properties: {
    trainingRunId: { type: 'string' },
    found: { type: 'boolean' },
    status: { type: 'string' },
    logs: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    planId: { type: 'string' },
    planHash: { type: 'string' },
    approvalId: { type: 'string' },
    progress: { type: 'number' },
    pid: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    currentStep: { type: 'string' },
    commands: { type: 'array', items: { type: 'object', additionalProperties: true } },
    errorMessage: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    logPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    startedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    finishedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    events: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: false,
};

export const thetaTrainingStatusToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStatus,
  version: '1.0.0',
  displayName: 'Get Training Status',
  description: 'Read THETA training progress, logs, artifacts, and lifecycle events through Hypha governance.',
  tags: ['theta', 'training'],
  inputSchema: trainingStatusInputSchema,
  outputSchema: trainingStatusOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingRead],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: 'fail',
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: 'local',
};

const normalizeTrainingStatusInput = (input: unknown): ThetaTrainingStatusInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('training.status input must be an object.');
  }
  return input as ThetaTrainingStatusInput;
};

const ensureTrainingStatusOutput = (data: unknown): ThetaTrainingStatusOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('training.status bridge returned a non-object payload.');
  }
  return data as ThetaTrainingStatusOutput;
};

export const thetaTrainingStatusHandler: ToolHandler<unknown, ThetaTrainingStatusOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const response = await callThetaBridge('training.status', normalizeTrainingStatusInput(input), {
    runId: context.runId,
    stepId: context.stepId,
  });

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'training.status bridge command failed.');
  }

  return ensureTrainingStatusOutput(response.data);
};
