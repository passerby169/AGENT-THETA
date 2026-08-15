import type { ReActAction } from '@hypha/kernel';

export const THETA_AGENT_CONTRACT_VERSION = '3.0.0' as const;

export const THETA_INTELLIGENT_PHASES = [
  'DatasetDiscovery',
  'ResearchDialogue',
  'PlanDesign',
  'PlanConfirmation',
] as const;

export type ThetaIntelligentPhase = (typeof THETA_INTELLIGENT_PHASES)[number];

export type ThetaCheckpointKind = 'dataset' | 'research' | 'plan';

export interface ThetaResearchQuestionRequest {
  purpose: 'research_question';
  question: string;
  whyItMatters: string;
}

export interface ThetaCheckpointRequest {
  purpose: 'dataset_checkpoint' | 'research_checkpoint' | 'plan_confirmation';
  checkpointId: string;
  targetHash: string;
}

export type ThetaHumanRequest = ThetaResearchQuestionRequest | ThetaCheckpointRequest;

export interface ThetaPhaseCompletionProposal {
  kind: 'phase_completion_proposed';
  phase: ThetaIntelligentPhase;
  artifactRef: string;
  artifactHash: string;
  rationale: string;
  confidence: number;
  checkpointDecision: 'request' | 'skip';
}

export interface ThetaReturnToPhaseProposal {
  kind: 'return_to_phase_requested';
  targetPhase: ThetaIntelligentPhase;
  reason: string;
}

export interface ThetaPhaseBlocked {
  kind: 'phase_blocked';
  reason: string;
  requiredUserDecision?: string;
}

export interface ThetaPlanConfirmationDecision {
  kind: 'plan_confirmation_decision';
  action: 'ask_about_checkpoint' | 'revise_checkpoint' | 'confirm_checkpoint' | 'reject_checkpoint' | 'return_to_phase';
  responseToUser: string;
  question?: string;
  requestedChanges?: string;
  targetHash?: string;
  reason?: string;
  phase?: 'PlanDesign';
}

export type ThetaPhaseOutcome =
  | ThetaPhaseCompletionProposal
  | ThetaReturnToPhaseProposal
  | ThetaPhaseBlocked
  | ThetaPlanConfirmationDecision;

export interface ThetaPhaseBudget {
  maxIterations: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxConsecutiveNoProgress: number;
  quantumIterations: number;
}

export interface ThetaPhaseContextIdentity {
  runId: string;
  sessionId: string;
  userId: string;
  phase: ThetaIntelligentPhase;
  datasetHash: string;
  workspaceHash: string;
  toolContractSnapshotHash: string;
}

export const isThetaHumanRequest = (value: unknown): value is ThetaHumanRequest => {
  if (!isRecord(value) || typeof value.purpose !== 'string') return false;
  if (value.purpose === 'research_question') {
    return nonEmpty(value.question) && nonEmpty(value.whyItMatters);
  }
  return (
    (value.purpose === 'dataset_checkpoint' ||
      value.purpose === 'research_checkpoint' ||
      value.purpose === 'plan_confirmation') &&
    nonEmpty(value.checkpointId) &&
    isHash(value.targetHash)
  );
};

export const isThetaPhaseOutcome = (value: unknown): value is ThetaPhaseOutcome => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'phase_completion_proposed') {
    return (
      THETA_INTELLIGENT_PHASES.includes(value.phase as ThetaIntelligentPhase) &&
      nonEmpty(value.artifactRef) &&
      isHash(value.artifactHash) &&
      nonEmpty(value.rationale) &&
      typeof value.confidence === 'number' &&
      value.confidence >= 0 &&
      value.confidence <= 1 &&
      (value.checkpointDecision === 'request' || value.checkpointDecision === 'skip')
    );
  }
  if (value.kind === 'return_to_phase_requested') {
    return (
      THETA_INTELLIGENT_PHASES.includes(value.targetPhase as ThetaIntelligentPhase) &&
      nonEmpty(value.reason)
    );
  }
  if (value.kind === 'plan_confirmation_decision') {
    if (!nonEmpty(value.responseToUser)) return false;
    if (value.action === 'ask_about_checkpoint') return nonEmpty(value.question);
    if (value.action === 'revise_checkpoint') return nonEmpty(value.requestedChanges);
    if (value.action === 'confirm_checkpoint') return isHash(value.targetHash);
    if (value.action === 'reject_checkpoint') return nonEmpty(value.reason);
    return value.action === 'return_to_phase' && value.phase === 'PlanDesign' && nonEmpty(value.reason);
  }
  return value.kind === 'phase_blocked' && nonEmpty(value.reason);
};

export const validateThetaAgentAction = (action: ReActAction): ReActAction => {
  if (action.type === 'human_review' && !isThetaHumanRequest(action.input)) {
    throw new Error('THETA human_review action does not satisfy the V3 contract.');
  }
  if (action.type === 'finish' && !isThetaPhaseOutcome(action.input)) {
    throw new Error('THETA finish action does not satisfy the V3 phase outcome contract.');
  }
  return structuredClone(action);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
