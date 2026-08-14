// Generated-contract mirror for theta-agent-api-v3.openapi.yaml.
// Keep this file transport-only; product behavior belongs in lib/agent.

export const THETA_AGENT_API_VERSION = '3.0.0' as const;

export interface ApiMeta {
  apiVersion: typeof THETA_AGENT_API_VERSION;
  requestId: string;
  serverTime: string;
  runRevision?: number;
  currentRunRevision?: number;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export type ApiErrorCategory =
  | 'validation'
  | 'conflict'
  | 'permission'
  | 'not_found'
  | 'provider'
  | 'tool'
  | 'runtime'
  | 'unavailable';

export interface ApiErrorDescriptor {
  code: string;
  category: ApiErrorCategory;
  message: string;
  retryable: boolean;
  fieldIssues?: Array<{ path: string; message: string }>;
  recovery?: {
    action: 'refresh' | 'retry' | 'resume' | 'contact_user' | 'none';
    label: string;
    description: string;
  };
  correlationId?: string;
  detailsRef?: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorDescriptor;
  meta: ApiMeta;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export interface ThetaHealthV3 {
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  capabilities: {
    agent: boolean;
    events: boolean;
    checkpoints: boolean;
  };
  checks?: Array<{
    id: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    remediation?: string;
  }>;
}

export type RunLifecycle =
  | 'active'
  | 'waiting_user'
  | 'waiting_runtime'
  | 'completed'
  | 'failed'
  | 'quarantined'
  | 'cancelled';

export type RunPhase =
  | 'intake'
  | 'dataset_understanding'
  | 'research_dialogue'
  | 'plan_design'
  | 'plan_confirmation'
  | 'dry_run'
  | 'training_confirmation'
  | 'training'
  | 'result_analysis'
  | 'completed'
  | 'recovery';

export interface RunInteraction {
  kind: 'none' | 'conversation' | 'checkpoint' | 'training_approval' | 'recovery';
  prompt?: string;
  checkpointId?: string;
  expectsUserInput: boolean;
}

export interface RunActivity {
  kind:
    | 'idle'
    | 'agent_reasoning'
    | 'tool_calling'
    | 'validating'
    | 'waiting_user'
    | 'waiting_timer'
    | 'training'
    | 'recovering';
  label: string;
  detail?: string;
  startedAt?: string;
  tool?: {
    displayName: string;
    safePurpose: string;
  };
}

export interface RunProgress {
  scope: 'run' | 'phase' | 'training';
  stageId: string;
  label: string;
  detail?: string;
  completedUnits?: number;
  totalUnits?: number;
  percent: number | null;
  indeterminate: boolean;
}

export interface RunCapabilities {
  canSendMessage: boolean;
  canConfirmCheckpoint: boolean;
  canRejectCheckpoint: boolean;
  canApprovePlan: boolean;
  canApproveTraining: boolean;
  canCancelAgentWork: boolean;
  canCancelTraining: boolean;
  canRetry: boolean;
  canResume: boolean;
  canDeleteRun: boolean;
  canViewTechnicalEvents: boolean;
}

export interface CheckpointSection {
  id: string;
  title: string;
  kind: 'text' | 'facts' | 'list' | 'table' | 'decision' | 'warning';
  content: unknown;
  provenance?: Array<{ refId: string; label: string }>;
}

export interface ConversationalCheckpointView {
  checkpointId: string;
  kind: 'dataset' | 'research' | 'plan';
  revision: number;
  contentHash: string;
  mandatory: boolean;
  status: 'proposed' | 'revising' | 'confirmed' | 'skipped' | 'rejected';
  requestedBy: 'minimax' | 'fsm';
  title: string;
  summary: string;
  sections: CheckpointSection[];
  assumptions: string[];
  warnings: string[];
  allowedActions: Array<'ask' | 'revise' | 'confirm' | 'reject' | 'return_previous'>;
  createdAt: string;
}

export interface DatasetWorkspaceSummary {
  datasetRef: string;
  datasetHash: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  languageSummary?: string;
  qualityWarnings: string[];
  assumptions: string[];
}

export interface DatasetCatalogItem {
  datasetRef: string;
  fileName: string;
  sizeBytes: number;
  suffix: string;
  createdAt: string;
  source: 'local' | 'remote';
  availability: 'ready' | 'remote_sample_authorization_required';
  rowCount?: number;
  columnCount?: number;
  languageSummary?: string;
}

export interface DatasetCatalogPage {
  items: DatasetCatalogItem[];
}

export interface ResearchWorkspaceSummary {
  workspaceHash: string;
  narrative: string;
  statements: Array<{
    id: string;
    text: string;
    status: 'confirmed' | 'inferred' | 'uncertain' | 'contradicted';
  }>;
  assumptions: string[];
  contradictions: string[];
}

export interface ModelDecisionView {
  modelId: string;
  displayName?: string;
  rationale: string;
}

export interface ValidationIssueView {
  code: string;
  severity: 'warning' | 'blocking';
  message: string;
  field?: string;
}

export interface PlanResourceEstimateView {
  estimatedMinutes?: number;
  cpuCores?: number;
  memoryGb?: number;
  accelerator?: string;
  notes: string[];
}

export interface PlanAlternativeView {
  modelId: string;
  displayName?: string;
  tradeoff: string;
}

export interface PlanEvidenceView {
  refId: string;
  label: string;
  summary: string;
  type: 'dataset_observation' | 'model_capability' | 'validator' | 'research';
}

export interface PlanCandidateView {
  candidateId: string;
  revision: number;
  candidatePlanHash: string;
  boundDatasetHash: string;
  boundResearchWorkspaceHash: string;
  status: 'designing' | 'validating' | 'valid' | 'invalid' | 'superseded';
  summary: string;
  primaryModel?: ModelDecisionView;
  baselineModel?: ModelDecisionView;
  parameters: Array<{
    field: string;
    value: string | number | boolean | null;
    rationale: string;
    source: 'agent' | 'user' | 'validator_default';
  }>;
  experiment?: {
    mode: string;
    runCount: number;
    seeds: number[];
    rationale: string;
  };
  preprocessing?: string[];
  evaluation?: string[];
  visualizations?: string[];
  expectedOutputs?: string[];
  resources?: PlanResourceEstimateView;
  alternatives?: PlanAlternativeView[];
  evidence?: PlanEvidenceView[];
  assumptions: string[];
  warnings: string[];
  validation?: {
    valid: boolean;
    receiptHash: string;
    issues: ValidationIssueView[];
  };
}

export interface TrainingView {
  status:
    | 'not_started'
    | 'queued'
    | 'running'
    | 'evaluating'
    | 'visualizing'
    | 'completed'
    | 'failed'
    | 'cancelled';
  stage: { id: string; label: string; detail?: string };
  progress: RunProgress;
  experiments: Array<{
    experimentId: string;
    modelId: string;
    seed?: number;
    status: string;
    percent: number | null;
  }>;
  startedAt?: string;
  updatedAt: string;
  etaSeconds?: number | null;
  recentNotices: string[];
  canonicalPlanHash?: string;
  dryRunHash?: string;
}

export interface FailureDescriptor {
  failureId: string;
  code: string;
  category: 'provider' | 'tool' | 'validation' | 'runtime' | 'training' | 'storage' | 'permission';
  stage: string;
  title: string;
  userMessage: string;
  technicalMessageRef?: string;
  retryable: boolean;
  recoverable: boolean;
  suggestedActions: Array<{
    id: string;
    label: string;
    description: string;
    type: 'retry' | 'resume' | 'return_plan' | 'return_research' | 'cancel';
  }>;
  occurredAt: string;
}

export interface ResultAvailabilitySummary {
  status: 'unavailable' | 'preparing' | 'available' | 'failed';
  artifactCount: number;
  overviewUrl?: string;
}

export interface ApproveTrainingRequest {
  clientCommandId: string;
  expectedRunRevision: number;
  dryRunHash: string;
}

export interface TrainingApprovalReceipt {
  receiptId: string;
  dryRunHash: string;
  canonicalPlanHash: string;
  approvedBy: string;
  approvedAt: string;
  command: CommandReceipt;
}

export interface RecoveryCommandRequest {
  clientCommandId: string;
  expectedRunRevision: number;
  actionId: string;
}

export interface RecoveryCommandAccepted {
  failureId: string;
  actionId: string;
  runRevision: number;
  command: CommandReceipt;
}

export interface ResultArtifactSummary {
  artifactId: string;
  name: string;
  kind: 'report' | 'table' | 'image' | 'interactive' | 'model' | 'log';
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  contentUrl: string;
  experimentId?: string;
}

export interface ResultArtifactPage {
  items: ResultArtifactSummary[];
}

export interface ResultAnalysisMessageRequest {
  clientMessageId: string;
  clientCommandId: string;
  expectedRunRevision: number;
  content: string;
  artifactIds?: string[];
}

export interface ThetaRunViewV3 {
  runId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lifecycle: RunLifecycle;
  phase: RunPhase;
  activity: RunActivity;
  interaction: RunInteraction;
  progress: RunProgress;
  checkpoint?: ConversationalCheckpointView;
  dataset?: DatasetWorkspaceSummary;
  research?: ResearchWorkspaceSummary;
  plan?: PlanCandidateView;
  training?: TrainingView;
  results?: ResultAvailabilitySummary;
  failure?: FailureDescriptor;
  capabilities: RunCapabilities;
  links: {
    messages: string;
    events: string;
    timeline: string;
    checkpoint?: string;
    plan?: string;
    training?: string;
    results?: string;
  };
  debug?: {
    hyphaState: string;
    eventCount: number;
    lastEventId?: string;
    checkpointRef?: string;
  };
}

export interface ThetaRunSummaryV3 {
  runId: string;
  revision: number;
  lifecycle: RunLifecycle;
  phase: RunPhase;
  updatedAt: string;
  title?: string;
  interaction: RunInteraction;
}

export interface CreateRunRequest {
  datasetRef: string;
  initialMessage?: string;
  remoteSampleAuthorizationId?: string;
  clientCommandId: string;
}

export interface CommandReceipt {
  commandId: string;
  clientCommandId: string;
  status: 'accepted' | 'running' | 'waiting_user' | 'completed' | 'failed';
  acceptedAt: string;
  updatedAt?: string;
  statusUrl: string;
  error?: ApiErrorDescriptor;
}

export interface CreateRunAccepted {
  runId: string;
  command: CommandReceipt;
  view: ThetaRunViewV3;
}

export type ConversationMessageKind =
  | 'text'
  | 'agent_question'
  | 'agent_summary'
  | 'checkpoint_proposed'
  | 'checkpoint_revised'
  | 'checkpoint_confirmed'
  | 'activity_notice'
  | 'failure_notice';

export interface ConversationMessage {
  messageId: string;
  clientMessageId?: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  kind: ConversationMessageKind;
  content: string;
  createdAt: string;
  status: 'accepted' | 'processing' | 'completed' | 'failed';
  commandId?: string;
  checkpointId?: string;
  citations?: Array<{
    refId: string;
    label: string;
    type: 'dataset_observation' | 'evidence' | 'plan' | 'result';
  }>;
}

export interface ConversationPage {
  items: ConversationMessage[];
  nextAfterSequence: number | null;
}

export interface SendMessageRequest {
  clientMessageId: string;
  clientCommandId: string;
  expectedRunRevision: number;
  content: string;
  checkpointContext?: {
    checkpointId: string;
    revision: number;
    contentHash: string;
  };
}

export interface MessageAccepted {
  message: ConversationMessage;
  command: CommandReceipt;
  runRevision: number;
}

export interface ConfirmCheckpointRequest {
  clientCommandId: string;
  expectedRunRevision: number;
  checkpointRevision: number;
  contentHash: string;
}

export interface CheckpointConfirmationReceipt {
  receiptId: string;
  checkpointId: string;
  checkpointRevision: number;
  contentHash: string;
  kind: 'dataset' | 'research' | 'plan';
  confirmedBy: string;
  confirmedAt: string;
  command: CommandReceipt;
}

export interface CreateRemoteSampleAuthorizationRequest {
  clientCommandId: string;
  maxRows: number;
  purpose: 'dataset_understanding';
  expiresInMinutes: number;
  acceptedRedactionPolicyVersion: string;
}

export interface RemoteSampleAuthorizationReceipt {
  authorizationId: string;
  datasetRef: string;
  datasetHash: string;
  maxRows: number;
  purpose: 'dataset_understanding';
  redactionPolicyVersion: string;
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export type ProductRunEventType =
  | 'run.view.updated'
  | 'conversation.message.created'
  | 'agent.activity.started'
  | 'agent.activity.updated'
  | 'agent.activity.completed'
  | 'checkpoint.proposed'
  | 'checkpoint.revised'
  | 'checkpoint.confirmed'
  | 'checkpoint.skipped'
  | 'plan.candidate.updated'
  | 'plan.validation.updated'
  | 'training.progress.updated'
  | 'run.failure.updated'
  | 'run.completed';

export interface ProductRunEvent<T = unknown> {
  eventId: string;
  sequence: number;
  type: ProductRunEventType;
  runId: string;
  runRevision: number;
  occurredAt: string;
  payload: T;
}
