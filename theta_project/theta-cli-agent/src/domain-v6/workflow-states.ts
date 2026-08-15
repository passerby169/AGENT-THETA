export const THETA_DOMAIN_PACK_ID = 'domain.theta.training';
export const THETA_DOMAIN_PACK_VERSION = '6.0.0';
export const THETA_WORKFLOW_ID = 'workflow.theta.training';
export const THETA_WORKFLOW_VERSION = '6.0.0';

export const THETA_WORKFLOW_STATES = {
  intake: 'Intake',
  datasetDiscovery: 'DatasetDiscovery',
  datasetCheckpoint: 'DatasetCheckpoint',
  researchDialogue: 'ResearchDialogue',
  researchCheckpoint: 'ResearchCheckpoint',
  planDesign: 'PlanDesign',
  planConfirmation: 'PlanConfirmation',
  createPlan: 'CreatePlan',
  dryRun: 'DryRun',
  trainingConfirmation: 'TrainingConfirmation',
  verifyDataset: 'VerifyDataset',
  startTraining: 'StartTraining',
  monitorTraining: 'MonitorTraining',
  evaluateResults: 'EvaluateResults',
  completed: 'Completed',
  recovering: 'Recovering',
  humanRecovery: 'HumanRecovery',
  quarantined: 'Quarantined',
  cancelled: 'Cancelled',
  failed: 'Failed',
} as const;

export type ThetaWorkflowState =
  (typeof THETA_WORKFLOW_STATES)[keyof typeof THETA_WORKFLOW_STATES];

export const THETA_CHECKPOINT_KEYS = {
  dataset: 'theta.checkpoint.dataset',
  research: 'theta.checkpoint.research',
  plan: 'theta.checkpoint.plan',
  training: 'theta.checkpoint.training',
} as const;

export const THETA_TERMINAL_STATES: readonly ThetaWorkflowState[] = [
  THETA_WORKFLOW_STATES.completed,
  THETA_WORKFLOW_STATES.quarantined,
  THETA_WORKFLOW_STATES.cancelled,
  THETA_WORKFLOW_STATES.failed,
];
