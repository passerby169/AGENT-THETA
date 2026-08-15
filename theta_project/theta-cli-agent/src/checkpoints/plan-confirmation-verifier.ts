import type { InferenceProvider, InferenceRequest, InferenceToolDescriptor } from '@hypha/inference';

export interface PlanConfirmationVerification {
  unqualifiedAcceptance: boolean;
  targetHash: string;
  rationale: string;
}

export class MiniMaxPlanConfirmationVerifier {
  constructor(private readonly inference: InferenceProvider) {}

  async verify(request: {
    runId: string;
    messageId: string;
    message: string;
    targetHash: string;
    checkpointSummary: string;
  }): Promise<PlanConfirmationVerification> {
    const inferenceRequest: InferenceRequest = {
      runId: request.runId,
      stepId: `plan-confirmation-verifier:${request.messageId}`,
      agentId: 'agent.theta.research-training',
      modelAlias: process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7',
      input: {
        instructions: 'Independently verify whether the complete user message is a clear, unqualified acceptance of the exact current candidate. You MUST call theta_verify_plan_confirmation exactly once.',
        messages: [
          {
            role: 'system',
            content: [
              'Return unqualifiedAcceptance=false if the message contains any question, uncertainty, hesitation, condition, requested change, exception, addition, removal, alternative, or future-dependent acceptance.',
              'Acceptance must apply to the exact current targetHash. Do not infer acceptance from politeness or from a request to continue discussion.',
              'Never invent or alter targetHash.',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify({ userMessage: request.message, targetHash: request.targetHash, checkpointSummary: request.checkpointSummary }) },
        ],
      },
      tools: [verificationTool(request.targetHash)],
      options: { temperature: 0, maxTokens: 500, responseFormat: 'json_object', extra: { toolChoice: 'required' } },
      metadata: { messageId: request.messageId, targetHash: request.targetHash },
    };
    const output = (await this.inference.infer(inferenceRequest)).output;
    const calls = record(output).kind === 'tool_calls' && Array.isArray(record(output).toolCalls)
      ? record(output).toolCalls as Array<{ name?: unknown; arguments?: unknown }>
      : [];
    const selected = calls.length === 1 && calls[0]?.name === 'theta_verify_plan_confirmation'
      ? calls[0].arguments
      : output;
    return validatePlanConfirmationVerification(selected, request.targetHash);
  }
}

export const validatePlanConfirmationVerification = (
  value: unknown,
  targetHash: string,
): PlanConfirmationVerification => {
  const candidate = record(value);
  if (typeof candidate.unqualifiedAcceptance !== 'boolean') throw new Error('Plan confirmation verifier requires unqualifiedAcceptance.');
  if (candidate.targetHash !== targetHash) throw new Error('Plan confirmation verifier targeted a stale or invented hash.');
  if (typeof candidate.rationale !== 'string' || !candidate.rationale.trim()) throw new Error('Plan confirmation verifier requires a concise rationale.');
  return { unqualifiedAcceptance: candidate.unqualifiedAcceptance, targetHash, rationale: candidate.rationale.trim() };
};

const verificationTool = (targetHash: string): InferenceToolDescriptor => ({
  id: 'theta_verify_plan_confirmation',
  name: 'theta_verify_plan_confirmation',
  description: 'Return an independent semantic verdict for an exact PlanConfirmation message.',
  inputSchema: {
    type: 'object',
    required: ['unqualifiedAcceptance', 'targetHash', 'rationale'],
    properties: {
      unqualifiedAcceptance: { type: 'boolean' },
      targetHash: { const: targetHash },
      rationale: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    additionalProperties: false,
  },
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
