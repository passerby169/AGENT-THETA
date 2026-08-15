import type { InferenceProvider, InferenceRequest } from '@hypha/inference';
import type { CheckpointFeedbackDecision, ConversationalCheckpoint } from './contracts.js';
import type { DatasetWorkspace } from '../workspaces/contracts.js';

export interface InterpretCheckpointFeedbackRequest {
  runId: string;
  messageId: string;
  message: string;
  checkpoint: ConversationalCheckpoint;
  workspace: DatasetWorkspace;
}

export class MiniMaxCheckpointFeedbackInterpreter {
  constructor(private readonly inference: InferenceProvider) {}

  async interpret(request: InterpretCheckpointFeedbackRequest): Promise<CheckpointFeedbackDecision> {
    const inferenceRequest: InferenceRequest = {
      runId: request.runId,
      stepId: `checkpoint-feedback:${request.checkpoint.checkpointId}:${request.messageId}`,
      agentId: 'agent.theta.research-training',
      modelAlias: 'MiniMax-M2.7',
      input: {
        instructions: [
          'Interpret one user message about the current dataset checkpoint.',
          'Choose semantic intent from the complete message; never use keyword matching.',
          'A message that both confirms and requests any modification MUST be revise_checkpoint, never confirm_checkpoint.',
          'confirm_checkpoint is allowed only when the user clearly accepts the current checkpoint without changes.',
          'If there is exactly one proposed primary text column, a user response such as “不知道”, “不确定”, “按你的判断”, or “采用你的建议” delegates that column decision to the Agent and counts as acceptance of the current recommendation. Return confirm_checkpoint unless the same message requests another change.',
          'If there is no primary text candidate or more than one candidate, delegation is not enough: ask one focused question or request DatasetDiscovery revision instead of confirming ambiguity.',
          'Questions are ask_about_checkpoint. Corrections, additions, removals or role changes are revise_checkpoint.',
          'Return exactly one JSON action satisfying the supplied schema. Do not invent a different target hash.',
          'Allowed JSON shapes: {"kind":"ask_about_checkpoint","question":"...","responseToUser":"..."}; {"kind":"revise_checkpoint","requestedChanges":"...","responseToUser":"..."}; {"kind":"confirm_checkpoint","targetHash":"CURRENT_HASH","responseToUser":"..."}; {"kind":"reject_checkpoint","reason":"...","responseToUser":"..."}; {"kind":"return_to_phase","phase":"DatasetDiscovery","reason":"...","responseToUser":"..."}.',
        ].join(' '),
        messages: [
          {
            role: 'system',
            content: JSON.stringify({
              checkpoint: request.checkpoint,
              datasetWorkspace: request.workspace,
              currentTargetHash: request.checkpoint.targetHash,
            }),
          },
          { role: 'user', content: request.message },
        ],
      },
      options: { temperature: 0, maxTokens: 1200, responseFormat: 'json_object' },
      metadata: { checkpointId: request.checkpoint.checkpointId, messageId: request.messageId },
    };
    return validateDecision((await this.inference.infer(inferenceRequest)).output, request.checkpoint.targetHash);
  }
}

export const validateDecision = (
  value: unknown,
  currentTargetHash: string,
): CheckpointFeedbackDecision => {
  const candidate = record(value);
  const kind = candidate.kind;
  const responseToUser = nonEmpty(candidate.responseToUser, 'responseToUser');
  if (kind === 'ask_about_checkpoint') {
    return { kind, question: nonEmpty(candidate.question, 'question'), responseToUser };
  }
  if (kind === 'revise_checkpoint') {
    return { kind, requestedChanges: nonEmpty(candidate.requestedChanges, 'requestedChanges'), responseToUser };
  }
  if (kind === 'confirm_checkpoint') {
    const targetHash = nonEmpty(candidate.targetHash, 'targetHash');
    if (targetHash !== currentTargetHash) throw new Error('MiniMax confirmation targeted a stale or invented Hash.');
    return { kind, targetHash, responseToUser };
  }
  if (kind === 'reject_checkpoint') {
    return { kind, reason: nonEmpty(candidate.reason, 'reason'), responseToUser };
  }
  if (kind === 'return_to_phase') {
    if (candidate.phase !== 'DatasetDiscovery' && candidate.phase !== 'ResearchDialogue') {
      throw new Error('Checkpoint feedback contains an invalid return phase.');
    }
    return {
      kind,
      phase: candidate.phase,
      reason: nonEmpty(candidate.reason, 'reason'),
      responseToUser,
    };
  }
  throw new Error(`MiniMax checkpoint feedback kind is invalid: ${String(kind)}.`);
};

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Checkpoint feedback requires ${field}.`);
  return value.trim();
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
