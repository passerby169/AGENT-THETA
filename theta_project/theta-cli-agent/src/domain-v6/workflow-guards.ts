import type { FSMGuardContext } from '@hypha/fsm';
import { isThetaPhaseOutcome } from '../agent-runtime/contracts.js';

export const THETA_V6_GUARDS = {
  datasetRegistered: 'theta.guard.dataset-registered',
  datasetUnderstood: 'theta.guard.dataset-understood',
  datasetReady: 'theta.guard.dataset-ready',
  datasetCheckpointResolved: 'theta.guard.dataset-checkpoint-resolved',
  researchCheckpointResolved: 'theta.guard.research-checkpoint-resolved',
  researchReady: 'theta.guard.research-ready',
  planValid: 'theta.guard.plan-valid',
  planApproved: 'theta.guard.plan-approved',
  canonicalPlanCreated: 'theta.guard.canonical-plan-created',
  dryRunPassed: 'theta.guard.dry-run-passed',
  trainingApproved: 'theta.guard.training-approved',
  datasetVerified: 'theta.guard.dataset-verified',
  trainingStarted: 'theta.guard.training-started',
  artifactsVerified: 'theta.guard.artifacts-verified',
  resultsEvaluated: 'theta.guard.results-evaluated',
} as const;

export type ThetaV6Guard = (typeof THETA_V6_GUARDS)[keyof typeof THETA_V6_GUARDS];

export const evaluateThetaV6Guard = (
  guard: string,
  context: Readonly<FSMGuardContext>,
): boolean => {
  const values = records(context);
  if (guard === THETA_V6_GUARDS.datasetRegistered) {
    const outcome = values.phaseOutcome;
    return typeof values.datasetRef === 'string' && values.datasetRef.length > 0 &&
      isHash(values.datasetHash) &&
      isThetaPhaseOutcome(outcome) &&
      outcome.kind === 'phase_completion_proposed' &&
      outcome.phase === 'Intake' &&
      outcome.artifactRef === values.datasetRef &&
      outcome.artifactHash === values.datasetHash;
  }
  if (guard === THETA_V6_GUARDS.datasetUnderstood) {
    return phaseReady(values, 'DatasetDiscovery', 'datasetWorkspaceHash');
  }
  if (guard === THETA_V6_GUARDS.datasetReady) {
    return phaseReady(values, 'DatasetDiscovery', 'datasetWorkspaceHash') &&
      values.datasetPrimaryTextConfirmed === true;
  }
  if (guard === THETA_V6_GUARDS.researchReady) {
    return phaseReady(values, 'ResearchDialogue', 'researchWorkspaceHash');
  }
  if (guard === THETA_V6_GUARDS.datasetCheckpointResolved) {
    return values.datasetCheckpointStatus === 'confirmed' &&
      values.datasetPrimaryTextConfirmed === true &&
      isHash(values.datasetCheckpointTargetHash) &&
      values.datasetCheckpointTargetHash === values.datasetWorkspaceHash;
  }
  if (guard === THETA_V6_GUARDS.researchCheckpointResolved) {
    return values.researchCheckpointStatus === 'confirmed' &&
      values.researchBlockingIssuesResolved === true &&
      isHash(values.researchCheckpointTargetHash) &&
      values.researchCheckpointTargetHash === values.researchWorkspaceHash;
  }
  if (guard === THETA_V6_GUARDS.planValid) {
    return (
      phaseReady(values, 'PlanDesign', 'planWorkspaceHash') &&
      isHash(values.validationReceiptHash) &&
      isHash(values.candidatePlanHash) &&
      isHash(values.evidenceBundleHash) &&
      values.validationCandidatePlanHash === values.candidatePlanHash &&
      values.validationEvidenceBundleHash === values.evidenceBundleHash &&
      values.candidateDatasetHash === values.currentDatasetHash &&
      values.candidateDatasetWorkspaceHash === values.currentDatasetWorkspaceHash &&
      values.candidateResearchWorkspaceHash === values.currentResearchWorkspaceHash &&
      values.candidateToolContractSnapshotHash === values.currentToolContractSnapshotHash
    );
  }
  if (guard === THETA_V6_GUARDS.planApproved) {
    return isHash(values.planApprovalHash) &&
      isHash(values.candidatePlanHash) &&
      isHash(values.planWorkspaceHash) &&
      isHash(values.validationReceiptHash) &&
      isHash(values.evidenceBundleHash) &&
      isHash(values.planCheckpointContentHash) &&
      values.approvedPlanHash === values.candidatePlanHash &&
      values.planApprovalCandidateHash === values.candidatePlanHash &&
      values.planApprovalWorkspaceHash === values.planWorkspaceHash &&
      values.planApprovalValidationHash === values.validationReceiptHash &&
      values.planApprovalEvidenceHash === values.evidenceBundleHash &&
      values.planApprovalCheckpointHash === values.planCheckpointContentHash &&
      typeof values.approvalPrincipalId === 'string' &&
      values.approvalPrincipalId.length > 0;
  }
  if (guard === THETA_V6_GUARDS.trainingApproved) {
    return isHash(values.trainingApprovalHash) &&
      values.approvedDryRunHash === values.dryRunHash &&
      values.trainingApprovalPlanHash === values.canonicalPlanHash &&
      values.trainingApprovalDatasetHash === values.currentDatasetHash &&
      typeof values.trainingApprovalPrincipalId === 'string' && values.trainingApprovalPrincipalId.length > 0 &&
      typeof values.trainingApprovalMessageId === 'string' && values.trainingApprovalMessageId.length > 0;
  }
  if (guard === THETA_V6_GUARDS.datasetVerified) {
    return values.datasetVerificationPassed === true &&
      isHash(values.datasetVerificationHash) &&
      values.datasetVerificationPlanHash === values.canonicalPlanHash &&
      values.datasetVerificationDryRunHash === values.dryRunHash &&
      values.datasetVerificationApprovalHash === values.trainingApprovalHash &&
      values.datasetVerificationDatasetHash === values.currentDatasetHash;
  }
  if (guard === THETA_V6_GUARDS.trainingStarted) {
    return typeof values.trainingRunId === 'string' && values.trainingRunId.length > 0 &&
      isHash(values.trainingRunReceiptHash) &&
      values.trainingRunPlanHash === values.canonicalPlanHash &&
      values.trainingRunDryRunHash === values.dryRunHash &&
      values.trainingRunApprovalHash === values.trainingApprovalHash &&
      values.trainingRunDatasetVerificationHash === values.datasetVerificationHash;
  }
  if (guard === THETA_V6_GUARDS.artifactsVerified) {
    return isHash(values.artifactManifestHash) &&
      values.artifactManifestTrainingRunId === values.trainingRunId &&
      values.artifactManifestPlanHash === values.canonicalPlanHash;
  }
  if (guard === THETA_V6_GUARDS.resultsEvaluated) {
    return values.resultsEvaluationCompleted === true &&
      isHash(values.resultsArtifactManifestHash) &&
      values.resultsArtifactManifestHash === values.artifactManifestHash;
  }
  if (guard === THETA_V6_GUARDS.canonicalPlanCreated) {
    return isHash(values.canonicalPlanHash) &&
      typeof values.canonicalPlanId === 'string' && values.canonicalPlanId.length > 0 &&
      values.canonicalPlanCandidateHash === values.candidatePlanHash &&
      values.canonicalPlanApprovalHash === values.planApprovalHash &&
      values.canonicalPlanDatasetHash === values.currentDatasetHash;
  }
  if (guard === THETA_V6_GUARDS.dryRunPassed) {
    return values.dryRunPassed === true &&
      isHash(values.dryRunHash) &&
      values.dryRunPlanHash === values.canonicalPlanHash &&
      values.dryRunDatasetHash === values.currentDatasetHash;
  }
  return false;
};


const phaseReady = (
  values: Record<string, unknown>,
  phase: string,
  workspaceHashKey: string,
): boolean => {
  const outcome = values.phaseOutcome;
  return (
    isThetaPhaseOutcome(outcome) &&
    outcome.kind === 'phase_completion_proposed' &&
    outcome.phase === phase &&
    isHash(values[workspaceHashKey]) &&
    outcome.artifactHash === values[workspaceHashKey]
  );
};

const records = (context: Readonly<FSMGuardContext>): Record<string, unknown> => {
  const candidate = context as unknown as Record<string, unknown>;
  const variables = candidate.variables;
  return variables && typeof variables === 'object' && !Array.isArray(variables)
    ? (variables as Record<string, unknown>)
    : candidate;
};

const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
