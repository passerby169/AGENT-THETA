import { hashCanonicalJson } from '@hypha/core';
import { z } from 'zod';

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime();

export const humanPlanReviewSchema = z.object({
  approvalType: z.literal('human_plan_review'),
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  planHash: sha256,
  candidatePlanHash: sha256,
  planApprovalHash: sha256,
  principalId: z.string().min(1),
  approvedAt: timestamp,
}).strict();

export const dryRunCheckSchema = z.object({
  code: z.string().min(1),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().min(1),
  recoveryTarget: z.enum(['PlanDesign', 'DatasetDiscovery', 'DryRun', 'HumanRecovery']).nullable().default(null),
}).strict();

export const dryRunReceiptSchema = z.object({
  receiptId: z.string().min(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  planHash: sha256,
  planReviewApprovalId: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  passed: z.boolean(),
  checks: z.array(dryRunCheckSchema).min(1),
  commands: z.array(z.object({
    step: z.string().min(1),
    cwd: z.string().min(1),
    argv: z.array(z.string()).min(1),
    sideEffect: z.string().min(1),
  }).strict()),
  expectedArtifacts: z.array(z.object({
    kind: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
  }).strict()).min(1),
  notes: z.array(z.string()),
  checkedAt: timestamp,
  dryRunHash: sha256,
}).strict();

export const humanTrainingReviewSchema = z.object({
  approvalType: z.literal('human_training_review'),
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  planHash: sha256,
  dryRunHash: sha256,
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  principalId: z.string().min(1),
  messageId: z.string().min(1),
  approvedAt: timestamp,
  trainingApprovalHash: sha256,
}).strict();

export const datasetVerificationReceiptSchema = z.object({
  receiptId: z.string().min(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  planHash: sha256,
  dryRunHash: sha256,
  trainingApprovalHash: sha256,
  datasetRef: z.string().min(1),
  expectedDatasetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  actualDatasetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  datasetPath: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  verified: z.boolean(),
  issues: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoveryTarget: z.enum(['PlanDesign', 'DatasetDiscovery', 'HumanRecovery']),
  }).strict()),
  verifiedAt: timestamp,
  verificationHash: sha256,
}).strict();

export const trainingFailureDescriptorSchema = z.object({
  code: z.string().min(1),
  category: z.enum(['plan', 'dataset', 'environment', 'runtime', 'quality', 'cancelled', 'unknown']),
  message: z.string().min(1),
  retryable: z.boolean(),
  recoveryTarget: z.enum(['PlanDesign', 'DatasetDiscovery', 'MonitorTraining', 'HumanRecovery']).nullable(),
  details: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
}).strict();

export const trainingRunReceiptSchema = z.object({
  receiptId: z.string().min(1),
  runId: z.string().min(1),
  trainingRunId: z.string().min(1),
  planId: z.string().min(1),
  planHash: sha256,
  dryRunHash: sha256,
  trainingApprovalHash: sha256,
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().min(1),
  datasetVerificationHash: sha256,
  status: z.enum(['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'quarantined', 'unknown']),
  acceptedAt: timestamp,
}).strict();

export const trainingProgressSnapshotSchema = z.object({
  trainingRunId: z.string().min(1),
  status: z.enum(['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'quarantined', 'unknown']),
  phase: z.enum(['queued', 'preparing_data', 'building_features', 'training', 'evaluating', 'visualizing', 'verifying_artifacts', 'completed', 'failed']),
  phaseLabel: z.string().min(1),
  completedRuns: z.number().int().nonnegative(),
  totalRuns: z.number().int().positive(),
  overallPercent: z.number().min(0).max(100),
  elapsedMs: z.number().int().nonnegative(),
  nextPollAfterMs: z.number().int().positive(),
  activitySummary: z.string().min(1),
  updatedAt: timestamp,
  failure: trainingFailureDescriptorSchema.nullable(),
}).strict();

export const trainingCancellationReceiptSchema = z.object({
  cancellationId: z.string().min(1),
  runId: z.string().min(1),
  trainingRunId: z.string().min(1),
  operator: z.string().min(1),
  reason: z.string().min(1),
  status: z.enum(['cancel_requested', 'cancelled', 'already_terminal']),
  requestedAt: timestamp,
  cancellationHash: sha256,
}).strict();

export const verifiedArtifactManifestSchema = z.object({
  manifestId: z.string().min(1),
  runId: z.string().min(1),
  trainingRunId: z.string().min(1),
  planHash: sha256,
  artifacts: z.array(z.object({
    artifactId: z.string().min(1),
    kind: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.literal(true),
  }).strict()).min(1),
  verifiedAt: timestamp,
  manifestHash: sha256,
}).strict();

export type HumanPlanReview = z.infer<typeof humanPlanReviewSchema>;
export type DryRunCheck = z.infer<typeof dryRunCheckSchema>;
export type DryRunReceipt = z.infer<typeof dryRunReceiptSchema>;
export type HumanTrainingReview = z.infer<typeof humanTrainingReviewSchema>;
export type DatasetVerificationReceipt = z.infer<typeof datasetVerificationReceiptSchema>;
export type TrainingFailureDescriptor = z.infer<typeof trainingFailureDescriptorSchema>;
export type TrainingRunReceipt = z.infer<typeof trainingRunReceiptSchema>;
export type TrainingProgressSnapshot = z.infer<typeof trainingProgressSnapshotSchema>;
export type TrainingCancellationReceipt = z.infer<typeof trainingCancellationReceiptSchema>;
export type VerifiedArtifactManifest = z.infer<typeof verifiedArtifactManifestSchema>;

export const dryRunReceiptHash = (receipt: Omit<DryRunReceipt, 'receiptId' | 'dryRunHash' | 'checkedAt'>): string =>
  hashCanonicalJson(receipt);

export const trainingApprovalReceiptHash = (
  receipt: Omit<HumanTrainingReview, 'trainingApprovalHash' | 'approvedAt'>,
): string => hashCanonicalJson(receipt);

export const datasetVerificationReceiptHash = (
  receipt: Omit<DatasetVerificationReceipt, 'receiptId' | 'verificationHash' | 'verifiedAt'>,
): string => hashCanonicalJson(receipt);

export const trainingRunReceiptHash = (
  receipt: Omit<TrainingRunReceipt, 'receiptId' | 'acceptedAt'>,
): string => hashCanonicalJson(receipt);

export const trainingCancellationReceiptHash = (
  receipt: Omit<TrainingCancellationReceipt, 'cancellationHash' | 'requestedAt'>,
): string => hashCanonicalJson(receipt);

export const artifactManifestHash = (
  manifest: Omit<VerifiedArtifactManifest, 'manifestId' | 'manifestHash' | 'verifiedAt'>,
): string => hashCanonicalJson(manifest);
