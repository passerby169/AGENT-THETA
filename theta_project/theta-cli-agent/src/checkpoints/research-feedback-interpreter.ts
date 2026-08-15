import type { InferenceProvider, InferenceRequest, InferenceToolDescriptor } from '@hypha/inference';
import type { ResearchWorkspace } from '../workspaces/contracts.js';
import type { ConversationalCheckpoint, ResearchCheckpointFeedbackDecision } from './contracts.js';

export class MiniMaxResearchCheckpointFeedbackInterpreter {
  constructor(private readonly inference: InferenceProvider) {}

  async interpret(request: {
    runId: string;
    messageId: string;
    message: string;
    checkpoint: ConversationalCheckpoint;
    workspace: ResearchWorkspace;
  }): Promise<ResearchCheckpointFeedbackDecision> {
    const inferenceRequest: InferenceRequest = {
      runId: request.runId,
      stepId: `research-checkpoint-feedback:${request.messageId}`,
      agentId: 'agent.theta.research-training',
      modelAlias: process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7',
      input: {
        instructions: 'Interpret the current research checkpoint feedback semantically. You MUST call the supplied theta_research_checkpoint_decision function exactly once.',
        messages: [
          {
            role: 'system',
            content: [
              'Interpret one natural-language response to the current research synthesis confirmation.',
              'If the user requests any change, choose revise_checkpoint even if the same message also says confirm.',
              'confirm_checkpoint is valid only for unqualified acceptance and must return CURRENT_HASH exactly.',
              'Questions use ask_about_checkpoint. Rejection uses reject_checkpoint. Returning for revision uses return_to_phase.',
              'Return one JSON object only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: request.message,
              currentTargetHash: request.checkpoint.targetHash,
              checkpoint: request.checkpoint,
              researchWorkspace: request.workspace,
            }),
          },
        ],
      },
      tools: [researchCheckpointDecisionTool(request.checkpoint.targetHash)],
      options: { temperature: 0, maxTokens: 1200, responseFormat: 'json_object', extra: { toolChoice: 'required' } },
      metadata: { checkpointId: request.checkpoint.checkpointId, messageId: request.messageId },
    };
    const output = (await this.inference.infer(inferenceRequest)).output;
    const calls = record(output).kind === 'tool_calls' && Array.isArray(record(output).toolCalls)
      ? record(output).toolCalls as Array<{ name?: unknown; arguments?: unknown }>
      : [];
    const selected = calls.length === 1 && calls[0]?.name === 'theta_research_checkpoint_decision'
      ? calls[0].arguments
      : output;
    return validateResearchCheckpointDecision(selected, request.checkpoint.targetHash);
  }
}

export const validateResearchCheckpointDecision = (
  value: unknown,
  targetHash: string,
): ResearchCheckpointFeedbackDecision => {
  const candidate = record(value);
  if (candidate.kind === 'ask_about_checkpoint' && text(candidate.question) && text(candidate.responseToUser)) {
    return candidate as unknown as ResearchCheckpointFeedbackDecision;
  }
  if (candidate.kind === 'revise_checkpoint' && text(candidate.requestedChanges) && text(candidate.responseToUser)) {
    return candidate as unknown as ResearchCheckpointFeedbackDecision;
  }
  if (candidate.kind === 'confirm_checkpoint' && candidate.targetHash === targetHash && text(candidate.responseToUser)) {
    return candidate as unknown as ResearchCheckpointFeedbackDecision;
  }
  if (candidate.kind === 'reject_checkpoint' && text(candidate.reason) && text(candidate.responseToUser)) {
    return candidate as unknown as ResearchCheckpointFeedbackDecision;
  }
  if (candidate.kind === 'return_to_phase' && candidate.phase === 'ResearchDialogue' && text(candidate.reason) && text(candidate.responseToUser)) {
    return candidate as unknown as ResearchCheckpointFeedbackDecision;
  }
  throw new Error(`MiniMax research checkpoint decision is invalid: ${JSON.stringify(value)}.`);
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const researchCheckpointDecisionTool = (targetHash: string): InferenceToolDescriptor => ({
  id: 'theta_research_checkpoint_decision',
  name: 'theta_research_checkpoint_decision',
  description: 'Return the single semantic decision for the current research synthesis feedback.',
  inputSchema: {
    type: 'object',
    required: ['kind', 'responseToUser'],
    properties: {
      kind: { enum: ['ask_about_checkpoint', 'revise_checkpoint', 'confirm_checkpoint', 'reject_checkpoint', 'return_to_phase'] },
      question: { type: 'string', minLength: 1 },
      requestedChanges: { type: 'string', minLength: 1 },
      targetHash: { const: targetHash },
      reason: { type: 'string', minLength: 1 },
      phase: { const: 'ResearchDialogue' },
      responseToUser: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
});
