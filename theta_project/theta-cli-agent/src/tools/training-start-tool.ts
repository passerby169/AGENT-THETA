import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import type {
  ThetaExpectedArtifact,
  ThetaTrainingCommand,
} from './training-dry-run-tool.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaTrainingStartInput {
  planId: string;
  planHash: string;
  approvalId: string;
  idempotencyKey: string;
}

export interface ThetaTrainingStartOutput {
  trainingRunId: string;
  planId: string;
  planHash: string;
  approvalId: string;
  status: string;
  progress: number;
  processStarted: boolean;
  pid?: number | null;
  currentStep: string;
  logPath?: string | null;
  commands: ThetaTrainingCommand[];
  expectedArtifacts?: ThetaExpectedArtifact[];
  artifacts?: ThetaExpectedArtifact[];
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
  message: string;
}

const trainingStartInputSchema: JsonSchema = {
  type: 'object',
  required: ['planId', 'planHash', 'approvalId', 'idempotencyKey'],
  properties: {
    planId: { type: 'string', minLength: 1 },
    planHash: { type: 'string', minLength: 1 },
    approvalId: { type: 'string', minLength: 1 },
    idempotencyKey: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const trainingStartOutputSchema: JsonSchema = {
  type: 'object',
  required: [
    'trainingRunId',
    'planId',
    'planHash',
    'approvalId',
    'status',
    'progress',
    'processStarted',
    'currentStep',
    'commands',
    'message',
  ],
  properties: {
    trainingRunId: { type: 'string' },
    planId: { type: 'string' },
    planHash: { type: 'string' },
    approvalId: { type: 'string' },
    status: { type: 'string' },
    progress: { type: 'number' },
    processStarted: { type: 'boolean' },
    pid: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    currentStep: { type: 'string' },
    logPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    commands: { type: 'array', items: { type: 'object', additionalProperties: true } },
    expectedArtifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    errorMessage: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: false,
};

export const thetaTrainingStartToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStart,
  version: '1.0.0',
  displayName: 'Start Training',
  description:
    'Start a THETA background training run only after plan approval and Hypha external-effect governance.',
  tags: ['theta', 'training'],
  inputSchema: trainingStartInputSchema,
  outputSchema: trainingStartOutputSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  humanApprovalPolicy: {
    required: true,
    reason: 'Starting THETA training creates a background process and local model artifacts.',
  },
  idempotencyPolicy: {
    mode: 'required',
  },
  timeoutPolicy: {
    timeoutMs: 60000,
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

const normalizeTrainingStartInput = (input: unknown): ThetaTrainingStartInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('training.start input must be an object.');
  }
  return input as ThetaTrainingStartInput;
};

const ensureTrainingStartOutput = (data: unknown): ThetaTrainingStartOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('training.start bridge returned a non-object payload.');
  }
  return data as ThetaTrainingStartOutput;
};

export const thetaTrainingStartHandler: ToolHandler<unknown, ThetaTrainingStartOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const response = await callThetaBridge('training.start', normalizeTrainingStartInput(input), {
    runId: context.runId,
    stepId: context.stepId,
  });

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'training.start bridge command failed.');
  }

  return ensureTrainingStartOutput(response.data);
};
