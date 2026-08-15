import { randomUUID } from 'node:crypto';
import { createFrameworkEvent, type EventStore, type FrameworkEvent } from '@hypha/core';
import type { CanonicalPlanRecord } from './contracts.js';
import type {
  DatasetVerificationReceipt,
  DryRunReceipt,
  HumanPlanReview,
  HumanTrainingReview,
  TrainingCancellationReceipt,
  TrainingProgressSnapshot,
  TrainingRunReceipt,
  VerifiedArtifactManifest,
} from './training-contracts.js';
import { THETA_EXECUTION_EVENT_TYPE } from './event-schemas.js';

export interface CanonicalPlanExecutionRecord {
  canonicalPlanRecord: CanonicalPlanRecord;
  planReview: HumanPlanReview;
  bridgeStateDb: string;
  recordedAt: string;
}

export class ThetaExecutionEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async canonicalPlans(runId: string): Promise<CanonicalPlanExecutionRecord[]> {
    return projectExecution(await this.events.list({ runId })).canonicalPlans;
  }

  async currentCanonicalPlan(runId: string): Promise<CanonicalPlanExecutionRecord | null> {
    return (await this.canonicalPlans(runId)).at(-1) ?? null;
  }

  async dryRuns(runId: string): Promise<DryRunReceipt[]> {
    return projectExecution(await this.events.list({ runId })).dryRuns;
  }

  async currentDryRun(runId: string, planHash?: string): Promise<DryRunReceipt | null> {
    return (await this.dryRuns(runId))
      .filter((receipt) => planHash === undefined || receipt.planHash === planHash)
      .at(-1) ?? null;
  }

  async currentTrainingApproval(runId: string, dryRunHash?: string): Promise<HumanTrainingReview | null> {
    return projectExecution(await this.events.list({ runId })).trainingApprovals
      .filter((receipt) => dryRunHash === undefined || receipt.dryRunHash === dryRunHash)
      .at(-1) ?? null;
  }

  async currentDatasetVerification(runId: string, trainingApprovalHash?: string): Promise<DatasetVerificationReceipt | null> {
    return projectExecution(await this.events.list({ runId })).datasetVerifications
      .filter((receipt) => trainingApprovalHash === undefined || receipt.trainingApprovalHash === trainingApprovalHash)
      .at(-1) ?? null;
  }

  async currentTrainingRun(runId: string): Promise<TrainingRunReceipt | null> {
    return projectExecution(await this.events.list({ runId })).trainingRuns.at(-1) ?? null;
  }

  async currentTrainingProgress(runId: string, trainingRunId?: string): Promise<TrainingProgressSnapshot | null> {
    return projectExecution(await this.events.list({ runId })).trainingProgress
      .filter((item) => trainingRunId === undefined || item.trainingRunId === trainingRunId)
      .at(-1) ?? null;
  }

  async currentArtifactManifest(runId: string, trainingRunId?: string): Promise<VerifiedArtifactManifest | null> {
    return projectExecution(await this.events.list({ runId })).artifactManifests
      .filter((item) => trainingRunId === undefined || item.trainingRunId === trainingRunId)
      .at(-1) ?? null;
  }

  async recordCanonicalPlan(input: {
    runId: string;
    sessionId: string;
    userId: string;
    value: CanonicalPlanExecutionRecord;
  }): Promise<CanonicalPlanExecutionRecord> {
    await this.append(input, 'theta.execution.canonical_plan.created', {
      canonicalPlanRecord: input.value.canonicalPlanRecord,
      planReview: input.value.planReview,
      bridgeStateDb: input.value.bridgeStateDb,
      recordedAt: input.value.recordedAt,
    }, `canonical-plan:${input.value.canonicalPlanRecord.planHash}`);
    return structuredClone(input.value);
  }

  async recordDryRun(input: {
    runId: string;
    sessionId: string;
    userId: string;
    receipt: DryRunReceipt;
  }): Promise<DryRunReceipt> {
    await this.append(input, 'theta.execution.dry_run.completed', { receipt: input.receipt }, `dry-run:${input.receipt.dryRunHash}`);
    return structuredClone(input.receipt);
  }

  async recordTrainingApproval(input: Identity & { receipt: HumanTrainingReview }): Promise<HumanTrainingReview> {
    await this.append(input, 'theta.execution.training_approval.created', { receipt: input.receipt }, `training-approval:${input.receipt.trainingApprovalHash}`);
    return structuredClone(input.receipt);
  }

  async recordDatasetVerification(input: Identity & { receipt: DatasetVerificationReceipt }): Promise<DatasetVerificationReceipt> {
    await this.append(input, 'theta.execution.dataset_verification.completed', { receipt: input.receipt }, `dataset-verification:${input.receipt.verificationHash}`);
    return structuredClone(input.receipt);
  }

  async recordTrainingRun(input: Identity & { receipt: TrainingRunReceipt }): Promise<TrainingRunReceipt> {
    await this.append(input, 'theta.execution.training_run.accepted', { receipt: input.receipt }, `training-run:${input.receipt.trainingRunId}`);
    return structuredClone(input.receipt);
  }

  async recordTrainingProgress(input: Identity & { snapshot: TrainingProgressSnapshot }): Promise<TrainingProgressSnapshot> {
    const fingerprint = `${input.snapshot.trainingRunId}:${input.snapshot.status}:${input.snapshot.phase}:${input.snapshot.completedRuns}:${Math.floor(input.snapshot.overallPercent)}`;
    await this.append(input, 'theta.execution.training_progress.observed', { snapshot: input.snapshot }, `training-progress:${fingerprint}`);
    return structuredClone(input.snapshot);
  }

  async recordCancellation(input: Identity & { receipt: TrainingCancellationReceipt }): Promise<TrainingCancellationReceipt> {
    await this.append(input, 'theta.execution.training_cancellation.recorded', { receipt: input.receipt }, `training-cancel:${input.receipt.cancellationHash}`);
    return structuredClone(input.receipt);
  }

  async recordArtifactManifest(input: Identity & { manifest: VerifiedArtifactManifest }): Promise<VerifiedArtifactManifest> {
    await this.append(input, 'theta.execution.artifact_manifest.verified', { manifest: input.manifest }, `artifact-manifest:${input.manifest.manifestHash}`);
    return structuredClone(input.manifest);
  }

  private async append(
    identity: { runId: string; sessionId: string; userId: string },
    kind: ExecutionEventKind,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<void> {
    const existing = await this.events.list({ runId: identity.runId });
    if (existing.some((event) => event.type === THETA_EXECUTION_EVENT_TYPE && record(event.payload).idempotencyKey === idempotencyKey)) return;
    await this.events.append(createFrameworkEvent({
      id: `theta-execution:${identity.runId}:${randomUUID()}`,
      type: THETA_EXECUTION_EVENT_TYPE,
      version: '1.0.0',
      runId: identity.runId,
      sessionId: identity.sessionId,
      userId: identity.userId,
      timestamp: this.now(),
      payload: { kind, idempotencyKey, ...payload },
      metadata: { kind, idempotencyKey },
    }));
  }
}

type ExecutionEventKind =
  | 'theta.execution.canonical_plan.created'
  | 'theta.execution.dry_run.completed'
  | 'theta.execution.training_approval.created'
  | 'theta.execution.dataset_verification.completed'
  | 'theta.execution.training_run.accepted'
  | 'theta.execution.training_progress.observed'
  | 'theta.execution.training_cancellation.recorded'
  | 'theta.execution.artifact_manifest.verified';

type Identity = { runId: string; sessionId: string; userId: string };

export const projectExecution = (events: readonly FrameworkEvent[]): {
  canonicalPlans: CanonicalPlanExecutionRecord[];
  dryRuns: DryRunReceipt[];
  trainingApprovals: HumanTrainingReview[];
  datasetVerifications: DatasetVerificationReceipt[];
  trainingRuns: TrainingRunReceipt[];
  trainingProgress: TrainingProgressSnapshot[];
  cancellations: TrainingCancellationReceipt[];
  artifactManifests: VerifiedArtifactManifest[];
} => {
  const canonicalPlans: CanonicalPlanExecutionRecord[] = [];
  const dryRuns: DryRunReceipt[] = [];
  const trainingApprovals: HumanTrainingReview[] = [];
  const datasetVerifications: DatasetVerificationReceipt[] = [];
  const trainingRuns: TrainingRunReceipt[] = [];
  const trainingProgress: TrainingProgressSnapshot[] = [];
  const cancellations: TrainingCancellationReceipt[] = [];
  const artifactManifests: VerifiedArtifactManifest[] = [];
  for (const event of events) {
    if (event.type !== THETA_EXECUTION_EVENT_TYPE) continue;
    const payload = record(event.payload);
    if (payload.kind === 'theta.execution.canonical_plan.created') {
      canonicalPlans.push(structuredClone({
        canonicalPlanRecord: payload.canonicalPlanRecord,
        planReview: payload.planReview,
        bridgeStateDb: payload.bridgeStateDb,
        recordedAt: payload.recordedAt,
      }) as CanonicalPlanExecutionRecord);
    }
    if (payload.kind === 'theta.execution.dry_run.completed' && isRecord(payload.receipt)) {
      dryRuns.push(structuredClone(payload.receipt) as unknown as DryRunReceipt);
    }
    if (payload.kind === 'theta.execution.training_approval.created' && isRecord(payload.receipt)) trainingApprovals.push(structuredClone(payload.receipt) as unknown as HumanTrainingReview);
    if (payload.kind === 'theta.execution.dataset_verification.completed' && isRecord(payload.receipt)) datasetVerifications.push(structuredClone(payload.receipt) as unknown as DatasetVerificationReceipt);
    if (payload.kind === 'theta.execution.training_run.accepted' && isRecord(payload.receipt)) trainingRuns.push(structuredClone(payload.receipt) as unknown as TrainingRunReceipt);
    if (payload.kind === 'theta.execution.training_progress.observed' && isRecord(payload.snapshot)) trainingProgress.push(structuredClone(payload.snapshot) as unknown as TrainingProgressSnapshot);
    if (payload.kind === 'theta.execution.training_cancellation.recorded' && isRecord(payload.receipt)) cancellations.push(structuredClone(payload.receipt) as unknown as TrainingCancellationReceipt);
    if (payload.kind === 'theta.execution.artifact_manifest.verified' && isRecord(payload.manifest)) artifactManifests.push(structuredClone(payload.manifest) as unknown as VerifiedArtifactManifest);
  }
  return { canonicalPlans, dryRuns, trainingApprovals, datasetVerifications, trainingRuns, trainingProgress, cancellations, artifactManifests };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
