export type ConversationalCheckpointKind = 'dataset' | 'research' | 'plan' | 'training';
export type ThetaCheckpointStatus = 'proposed' | 'revising' | 'confirmed' | 'skipped' | 'rejected' | 'invalidated';

export interface ConversationalCheckpoint {
  checkpointId: string;
  kind: ConversationalCheckpointKind;
  runId: string;
  revision: number;
  targetWorkspaceRef: string;
  targetHash: string;
  content: Record<string, unknown>;
  contentHash: string;
  summaryForUser: string;
  assumptions: string[];
  warnings: string[];
  sourceRefs: string[];
  status: ThetaCheckpointStatus;
  requestedBy: 'minimax' | 'fsm';
  mandatory: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedByMessageId?: string;
  resolutionReason?: string;
}

export type CheckpointFeedbackDecision =
  | { kind: 'ask_about_checkpoint'; question: string; responseToUser: string }
  | { kind: 'revise_checkpoint'; requestedChanges: string; responseToUser: string }
  | { kind: 'confirm_checkpoint'; targetHash: string; responseToUser: string }
  | { kind: 'reject_checkpoint'; reason: string; responseToUser: string }
  | { kind: 'return_to_phase'; phase: 'DatasetDiscovery' | 'ResearchDialogue'; reason: string; responseToUser: string };

export type ResearchCheckpointFeedbackDecision =
  | { kind: 'ask_about_checkpoint'; question: string; responseToUser: string }
  | { kind: 'revise_checkpoint'; requestedChanges: string; responseToUser: string }
  | { kind: 'confirm_checkpoint'; targetHash: string; responseToUser: string }
  | { kind: 'reject_checkpoint'; reason: string; responseToUser: string }
  | { kind: 'return_to_phase'; phase: 'ResearchDialogue'; reason: string; responseToUser: string };

export type PlanCheckpointFeedbackDecision =
  | { kind: 'ask_about_checkpoint'; question: string; responseToUser: string }
  | { kind: 'revise_checkpoint'; requestedChanges: string; responseToUser: string }
  | { kind: 'confirm_checkpoint'; targetHash: string; responseToUser: string }
  | { kind: 'reject_checkpoint'; reason: string; responseToUser: string }
  | { kind: 'return_to_phase'; phase: 'PlanDesign'; reason: string; responseToUser: string };

export type TrainingCheckpointFeedbackDecision =
  | { kind: 'ask_about_checkpoint'; question: string; responseToUser: string }
  | { kind: 'revise_checkpoint'; requestedChanges: string; responseToUser: string }
  | { kind: 'confirm_checkpoint'; targetHash: string; responseToUser: string }
  | { kind: 'reject_checkpoint'; reason: string; responseToUser: string };

export interface SubmitCheckpointMessageRequest {
  runId: string;
  content: string;
  messageId?: string;
  runtimeDb?: string;
  userId?: string;
  workspaceId?: string;
}
