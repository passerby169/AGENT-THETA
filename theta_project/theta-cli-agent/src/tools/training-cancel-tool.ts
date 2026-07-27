import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaTrainingCancelInput {
  trainingRunId: string;
  reason: string;
}

export interface ThetaTrainingCancelOutput {
  trainingRunId: string;
  status: string;
  changed: boolean;
  reason?: string;
  message: string;
}

const trainingCancelInputSchema: JsonSchema = {
  type: 'object',
  required: ['trainingRunId', 'reason'],
  properties: {
    trainingRunId: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const trainingCancelOutputSchema: JsonSchema = {
  type: 'object',
  required: ['trainingRunId', 'status', 'changed', 'message'],
  properties: {
    trainingRunId: { type: 'string' },
    status: { type: 'string' },
    changed: { type: 'boolean' },
    reason: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: false,
};

export const thetaTrainingCancelToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingCancel,
  version: '1.0.0',
  displayName: 'Cancel Training',
  description:
    'Request cooperative cancellation of a THETA training run through Hypha external-effect governance.',
  tags: ['theta', 'training'],
  inputSchema: trainingCancelInputSchema,
  outputSchema: trainingCancelOutputSchema,
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  humanApprovalPolicy: {
    required: true,
    reason: 'Cancelling THETA training changes an active run and requires explicit confirmation.',
  },
  idempotencyPolicy: {
    mode: 'required',
  },
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

const normalizeTrainingCancelInput = (input: unknown): ThetaTrainingCancelInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('training.cancel input must be an object.');
  }
  return input as ThetaTrainingCancelInput;
};

const ensureTrainingCancelOutput = (data: unknown): ThetaTrainingCancelOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('training.cancel bridge returned a non-object payload.');
  }
  return data as ThetaTrainingCancelOutput;
};

export const thetaTrainingCancelHandler: ToolHandler<unknown, ThetaTrainingCancelOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const response = await callThetaBridge('training.cancel', normalizeTrainingCancelInput(input), {
    runId: context.runId,
    stepId: context.stepId,
  });

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'training.cancel bridge command failed.');
  }

  return ensureTrainingCancelOutput(response.data);
};
