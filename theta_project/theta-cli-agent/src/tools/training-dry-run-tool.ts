import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaTrainingDryRunInput {
  planId: string;
  planHash: string;
}

export interface ThetaTrainingCommand {
  step: string;
  cwd: string;
  argv: string[];
  sideEffect: string;
}

export interface ThetaExpectedArtifact {
  kind: string;
  path: string;
  description: string;
}

export interface ThetaTrainingDryRunOutput {
  planId: string;
  planHash: string;
  valid: boolean;
  approved: boolean;
  approvals: Array<{
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  }>;
  validation: Record<string, unknown>;
  commands: ThetaTrainingCommand[];
  expectedArtifacts: ThetaExpectedArtifact[];
  notes: string[];
}

const trainingDryRunInputSchema: JsonSchema = {
  type: 'object',
  required: ['planId', 'planHash'],
  properties: {
    planId: { type: 'string', minLength: 1 },
    planHash: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const trainingDryRunOutputSchema: JsonSchema = {
  type: 'object',
  required: [
    'planId',
    'planHash',
    'valid',
    'approved',
    'approvals',
    'validation',
    'commands',
    'expectedArtifacts',
    'notes',
  ],
  properties: {
    planId: { type: 'string' },
    planHash: { type: 'string' },
    valid: { type: 'boolean' },
    approved: { type: 'boolean' },
    approvals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['approvalId', 'approvedBy', 'approvedAt'],
        properties: {
          approvalId: { type: 'string' },
          approvedBy: { type: 'string' },
          approvedAt: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    validation: {
      type: 'object',
      additionalProperties: true,
    },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'cwd', 'argv', 'sideEffect'],
        properties: {
          step: { type: 'string' },
          cwd: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' } },
          sideEffect: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    expectedArtifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'path', 'description'],
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaTrainingDryRunToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingDryRun,
  version: '1.0.0',
  displayName: 'Preview Training Run',
  description:
    'Derive THETA training commands and expected artifacts from a stored plan without starting training.',
  tags: ['theta', 'training'],
  inputSchema: trainingDryRunInputSchema,
  outputSchema: trainingDryRunOutputSchema,
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.trainingRead],
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

const normalizeTrainingDryRunInput = (input: unknown): ThetaTrainingDryRunInput => {
  if (!input || typeof input !== 'object') {
    throw new Error('training.dry_run input must be an object.');
  }
  return input as ThetaTrainingDryRunInput;
};

const ensureTrainingDryRunOutput = (data: unknown): ThetaTrainingDryRunOutput => {
  if (!data || typeof data !== 'object') {
    throw new Error('training.dry_run bridge returned a non-object payload.');
  }
  return data as ThetaTrainingDryRunOutput;
};

export const thetaTrainingDryRunHandler: ToolHandler<unknown, ThetaTrainingDryRunOutput> = async (
  input: unknown,
  context: ToolCallContext
) => {
  const response = await callThetaBridge('training.dry_run', normalizeTrainingDryRunInput(input), {
    runId: context.runId,
    stepId: context.stepId,
  });

  if (response.status !== 'ok') {
    throw new Error(response.error?.message ?? 'training.dry_run bridge command failed.');
  }

  return ensureTrainingDryRunOutput(response.data);
};
