import type { ToolExecutionScope } from '@hypha/tools';
import type { ThetaIntelligentPhase } from '../agent-runtime/contracts.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from '../tools/tool-ids.js';
import { THETA_WORKFLOW_STATES, type ThetaWorkflowState } from './workflow-states.js';

const datasetReadTools = [
  THETA_TOOL_IDS.datasetOverview,
  THETA_TOOL_IDS.datasetSample,
  THETA_TOOL_IDS.datasetColumnProfile,
  THETA_TOOL_IDS.datasetTextProfile,
  THETA_TOOL_IDS.datasetTimeProfile,
  THETA_TOOL_IDS.datasetCategoricalProfile,
  THETA_TOOL_IDS.datasetMissingness,
  THETA_TOOL_IDS.datasetDuplicates,
  THETA_TOOL_IDS.datasetRelationships,
] as const;

const intakeTools = [
  THETA_TOOL_IDS.agentProtocolFeedback,
  THETA_TOOL_IDS.datasetRequestUpload,
  THETA_TOOL_IDS.datasetIngestAttachment,
] as const;

const datasetDiscoveryTools = [
  THETA_TOOL_IDS.agentProtocolFeedback,
  ...datasetReadTools,
  THETA_TOOL_IDS.datasetSubmitUnderstanding,
  THETA_TOOL_IDS.datasetApplyUserRevision,
] as const;

const datasetCheckpointTools = [
  ...datasetReadTools,
  THETA_TOOL_IDS.datasetApplyUserRevision,
] as const;

const researchReadTools = [
  ...datasetReadTools,
  THETA_TOOL_IDS.researchReadWorkspace,
  THETA_TOOL_IDS.modelCatalog,
  THETA_TOOL_IDS.ragStatus,
  THETA_TOOL_IDS.ragSearch,
] as const;

const researchDialogueTools = [
  THETA_TOOL_IDS.agentProtocolFeedback,
  ...researchReadTools,
  THETA_TOOL_IDS.researchUpdateUnderstanding,
] as const;

const plannerTools = [
  THETA_TOOL_IDS.agentProtocolFeedback,
  THETA_TOOL_IDS.plannerInspectCase,
  THETA_TOOL_IDS.modelShortlist,
  THETA_TOOL_IDS.plannerEvaluateCandidate,
  THETA_TOOL_IDS.plannerValidateAlignment,
  THETA_TOOL_IDS.runtimeEstimateCandidate,
  THETA_TOOL_IDS.ragSearch,
  THETA_TOOL_IDS.plannerCreateCandidate,
  THETA_TOOL_IDS.plannerGetCandidate,
  THETA_TOOL_IDS.plannerCompareCandidates,
  THETA_TOOL_IDS.plannerSubmitRevision,
] as const;

const planConfirmationReadTools = [
  THETA_TOOL_IDS.agentProtocolFeedback,
  ...researchReadTools,
  THETA_TOOL_IDS.modelGetCapability,
  THETA_TOOL_IDS.modelCompare,
  THETA_TOOL_IDS.modelGetParameterContract,
  THETA_TOOL_IDS.ragGetEvidence,
  THETA_TOOL_IDS.plannerGetCandidate,
  THETA_TOOL_IDS.plannerCompareCandidates,
] as const;

export const thetaToolsForPhase = (phase: ThetaIntelligentPhase): readonly string[] => {
  if (phase === 'Intake') return intakeTools;
  if (phase === 'DatasetDiscovery') return datasetDiscoveryTools;
  if (phase === 'ResearchDialogue') return researchDialogueTools;
  if (phase === 'PlanDesign') return plannerTools;
  return planConfirmationReadTools;
};

export interface ThetaStateToolProfile {
  allowedToolIds: readonly string[];
  permissionScopes: readonly string[];
  policyRefs: readonly string[];
}

const readonlyProfile = (
  allowedToolIds: readonly string[],
  permissionScopes: readonly string[],
): ThetaStateToolProfile => ({
  allowedToolIds,
  permissionScopes,
  policyRefs: ['policy.theta.v6.readonly'],
});

const datasetWorkspaceProfile = (allowedToolIds: readonly string[]): ThetaStateToolProfile => ({
  allowedToolIds,
  permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead, THETA_PERMISSION_SCOPES.datasetWrite],
  policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write'],
});

export const THETA_STATE_TOOL_PROFILES: Readonly<Record<ThetaWorkflowState, ThetaStateToolProfile>> = {
  [THETA_WORKFLOW_STATES.intake]: {
    allowedToolIds: intakeTools,
    permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead, THETA_PERMISSION_SCOPES.datasetWrite],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.datasetDiscovery]: datasetWorkspaceProfile(datasetDiscoveryTools),
  [THETA_WORKFLOW_STATES.datasetCheckpoint]: datasetWorkspaceProfile(datasetCheckpointTools),
  [THETA_WORKFLOW_STATES.researchDialogue]: {
    allowedToolIds: researchDialogueTools,
    permissionScopes: [
      THETA_PERMISSION_SCOPES.datasetRead,
      THETA_PERMISSION_SCOPES.datasetWrite,
      THETA_PERMISSION_SCOPES.researchRead,
      THETA_PERMISSION_SCOPES.researchWrite,
      THETA_PERMISSION_SCOPES.modelRead,
      THETA_PERMISSION_SCOPES.ragRead,
    ],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.researchCheckpoint]: readonlyProfile(researchReadTools, [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.datasetWrite,
    THETA_PERMISSION_SCOPES.researchRead,
    THETA_PERMISSION_SCOPES.modelRead,
    THETA_PERMISSION_SCOPES.ragRead,
  ]),
  [THETA_WORKFLOW_STATES.planDesign]: {
    allowedToolIds: plannerTools,
    permissionScopes: [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.datasetWrite,
    THETA_PERMISSION_SCOPES.researchRead,
    THETA_PERMISSION_SCOPES.modelRead,
    THETA_PERMISSION_SCOPES.ragRead,
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.planWrite,
    THETA_PERMISSION_SCOPES.runtimeRead,
    ],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.planConfirmation]: readonlyProfile(planConfirmationReadTools, [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.datasetWrite,
    THETA_PERMISSION_SCOPES.researchRead,
    THETA_PERMISSION_SCOPES.modelRead,
    THETA_PERMISSION_SCOPES.ragRead,
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.runtimeRead,
  ]),
  [THETA_WORKFLOW_STATES.createPlan]: {
    allowedToolIds: [THETA_TOOL_IDS.planCreate],
    permissionScopes: [THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.planWrite],
    policyRefs: ['policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.dryRun]: {
    allowedToolIds: [THETA_TOOL_IDS.trainingDryRun],
    permissionScopes: [
      THETA_PERMISSION_SCOPES.datasetRead,
      THETA_PERMISSION_SCOPES.planRead,
      THETA_PERMISSION_SCOPES.planWrite,
      THETA_PERMISSION_SCOPES.runtimeRead,
    ],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.trainingConfirmation]: readonlyProfile([], []),
  [THETA_WORKFLOW_STATES.verifyDataset]: {
    allowedToolIds: [THETA_TOOL_IDS.datasetVerifyForTraining],
    permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead, THETA_PERMISSION_SCOPES.trainingWrite],
    policyRefs: ['policy.theta.v6.state-write'],
  },
  [THETA_WORKFLOW_STATES.startTraining]: {
    allowedToolIds: [THETA_TOOL_IDS.trainingStart],
    permissionScopes: [THETA_PERMISSION_SCOPES.trainingWrite],
    policyRefs: ['policy.theta.v6.training-control'],
  },
  [THETA_WORKFLOW_STATES.monitorTraining]: {
    allowedToolIds: [THETA_TOOL_IDS.trainingStatus, THETA_TOOL_IDS.trainingCancel, THETA_TOOL_IDS.artifactsVerify],
    permissionScopes: [THETA_PERMISSION_SCOPES.trainingRead, THETA_PERMISSION_SCOPES.trainingWrite, THETA_PERMISSION_SCOPES.resultsRead],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.state-write', 'policy.theta.v6.training-control'],
  },
  [THETA_WORKFLOW_STATES.evaluateResults]: readonlyProfile(
    [THETA_TOOL_IDS.resultsListArtifacts, THETA_TOOL_IDS.resultsGetSummary],
    [THETA_PERMISSION_SCOPES.resultsRead],
  ),
  [THETA_WORKFLOW_STATES.completed]: readonlyProfile(
    [THETA_TOOL_IDS.resultsListArtifacts, THETA_TOOL_IDS.resultsGetSummary],
    [THETA_PERMISSION_SCOPES.resultsRead],
  ),
  [THETA_WORKFLOW_STATES.recovering]: readonlyProfile([THETA_TOOL_IDS.trainingStatus], [THETA_PERMISSION_SCOPES.trainingRead]),
  [THETA_WORKFLOW_STATES.humanRecovery]: {
    allowedToolIds: [THETA_TOOL_IDS.trainingStatus, THETA_TOOL_IDS.trainingCancel],
    permissionScopes: [THETA_PERMISSION_SCOPES.trainingRead, THETA_PERMISSION_SCOPES.trainingWrite],
    policyRefs: ['policy.theta.v6.readonly', 'policy.theta.v6.training-control'],
  },
  [THETA_WORKFLOW_STATES.quarantined]: readonlyProfile([], []),
  [THETA_WORKFLOW_STATES.cancelled]: readonlyProfile([], []),
  [THETA_WORKFLOW_STATES.failed]: readonlyProfile([], []),
};

export const resolveThetaV6StateToolScope = (state: ThetaWorkflowState): ToolExecutionScope => {
  const profile = THETA_STATE_TOOL_PROFILES[state];
  if (!profile) throw new Error(`Unknown THETA V6 workflow state: ${state}`);
  return {
    fsmState: state,
    allowedToolIds: [...profile.allowedToolIds],
    policyRefs: [...profile.policyRefs],
  };
};
