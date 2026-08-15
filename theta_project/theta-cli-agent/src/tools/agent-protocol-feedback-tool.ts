import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const inputSchema: JsonSchema = {
  type: 'object',
  required: ['phase', 'code', 'message', 'invalidOutput'],
  properties: {
    phase: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    invalidOutput: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaAgentProtocolFeedbackToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.agentProtocolFeedback,
  version: '1.0.0',
  displayName: 'Agent protocol feedback',
  description: 'Runtime-only bounded feedback for an invalid native phase action. The language model should not select this tool directly.',
  tags: ['theta', 'agent-runtime', 'internal'],
  inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead],
  timeoutPolicy: { timeoutMs: 1_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaAgentProtocolFeedbackHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => ({
  ...(input as Record<string, unknown>),
  repairInstruction: 'Correct the native action using the exact current tool output and contract. Do not repeat the same invalid payload.',
});
