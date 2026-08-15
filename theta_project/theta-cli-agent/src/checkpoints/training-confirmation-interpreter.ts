import type { InferenceProvider, InferenceRequest, InferenceToolDescriptor } from '@hypha/inference';
import type { TrainingCheckpointFeedbackDecision } from './contracts.js';

export class MiniMaxTrainingConfirmationInterpreter {
  constructor(private readonly inference: InferenceProvider) {}

  async interpret(request: {
    runId: string;
    messageId: string;
    message: string;
    dryRunHash: string;
    checkpointSummary: string;
  }): Promise<TrainingCheckpointFeedbackDecision> {
    const response = await this.inference.infer(inferenceRequest('interpret', request, interpretationTool(request.dryRunHash)));
    const value = singleToolArguments(response.output, 'theta_interpret_training_confirmation');
    return validateDecision(value, request.dryRunHash);
  }

  async verifyUnqualifiedAcceptance(request: {
    runId: string;
    messageId: string;
    message: string;
    dryRunHash: string;
    checkpointSummary: string;
  }): Promise<{ accepted: boolean; rationale: string }> {
    const response = await this.inference.infer(inferenceRequest('verify', request, verificationTool(request.dryRunHash)));
    const value = record(singleToolArguments(response.output, 'theta_verify_training_confirmation'));
    if (typeof value.accepted !== 'boolean' || value.dryRunHash !== request.dryRunHash || typeof value.rationale !== 'string' || !value.rationale.trim()) {
      throw new Error('Training confirmation verifier returned an invalid or stale verdict.');
    }
    return { accepted: value.accepted, rationale: value.rationale.trim() };
  }
}

const inferenceRequest = (
  mode: 'interpret' | 'verify',
  request: { runId: string; messageId: string; message: string; dryRunHash: string; checkpointSummary: string },
  tool: InferenceToolDescriptor,
): InferenceRequest => ({
  runId: request.runId,
  stepId: `training-confirmation-${mode}:${request.messageId}`,
  agentId: 'agent.theta.research-training',
  modelAlias: process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7',
  input: {
    instructions: mode === 'interpret'
      ? 'Interpret the complete user reply at the mandatory training-start checkpoint. Call theta_interpret_training_confirmation exactly once.'
      : 'Independently verify whether the complete user reply is a clear, unconditional approval to start the exact dry run. Call theta_verify_training_confirmation exactly once.',
    messages: [
      {
        role: 'system',
        content: [
          'A question, hesitation, condition, requested change, exception, or mixed approval is never an approval.',
          'Questions stay at the checkpoint. Changes return to PlanDesign. Only explicit unqualified approval may confirm.',
          'Never invent or alter dryRunHash.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ userMessage: request.message, dryRunHash: request.dryRunHash, checkpointSummary: request.checkpointSummary }) },
    ],
  },
  tools: [tool],
  options: { temperature: 0, maxTokens: 700, responseFormat: 'json_object', extra: { toolChoice: 'required' } },
  metadata: { messageId: request.messageId, dryRunHash: request.dryRunHash },
});

const interpretationTool = (dryRunHash: string): InferenceToolDescriptor => ({
  id: 'theta_interpret_training_confirmation',
  name: 'theta_interpret_training_confirmation',
  description: 'Classify one natural-language response to the exact training checkpoint.',
  inputSchema: {
    type: 'object',
    required: ['action', 'dryRunHash', 'responseToUser'],
    properties: {
      action: { enum: ['ask', 'revise', 'confirm', 'reject'] },
      dryRunHash: { const: dryRunHash },
      question: { type: 'string' },
      requestedChanges: { type: 'string' },
      reason: { type: 'string' },
      responseToUser: { type: 'string', minLength: 1, maxLength: 3000 },
    },
    additionalProperties: false,
  },
});

const verificationTool = (dryRunHash: string): InferenceToolDescriptor => ({
  id: 'theta_verify_training_confirmation',
  name: 'theta_verify_training_confirmation',
  description: 'Independently verify unqualified approval for an exact DryRun hash.',
  inputSchema: {
    type: 'object',
    required: ['accepted', 'dryRunHash', 'rationale'],
    properties: {
      accepted: { type: 'boolean' },
      dryRunHash: { const: dryRunHash },
      rationale: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    additionalProperties: false,
  },
});

const validateDecision = (value: unknown, dryRunHash: string): TrainingCheckpointFeedbackDecision => {
  const item = record(value);
  if (item.dryRunHash !== dryRunHash) throw new Error('Training confirmation targeted a stale or invented DryRun hash.');
  const responseToUser = text(item.responseToUser, 'responseToUser');
  if (item.action === 'ask') return { kind: 'ask_about_checkpoint', question: text(item.question, 'question'), responseToUser };
  if (item.action === 'revise') return { kind: 'revise_checkpoint', requestedChanges: text(item.requestedChanges, 'requestedChanges'), responseToUser };
  if (item.action === 'confirm') return { kind: 'confirm_checkpoint', targetHash: dryRunHash, responseToUser };
  if (item.action === 'reject') return { kind: 'reject_checkpoint', reason: text(item.reason, 'reason'), responseToUser };
  throw new Error('Training confirmation interpreter returned an unsupported action.');
};

const singleToolArguments = (output: unknown, expectedName: string): unknown => {
  const item = record(output);
  const calls = item.kind === 'tool_calls' && Array.isArray(item.toolCalls)
    ? item.toolCalls as Array<{ name?: unknown; arguments?: unknown }>
    : [];
  if (calls.length !== 1 || calls[0]?.name !== expectedName) throw new Error(`MiniMax must call ${expectedName} exactly once.`);
  return calls[0].arguments;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Training confirmation ${label} is required.`);
  return value.trim();
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
