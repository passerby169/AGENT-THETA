import { hashCanonicalJson } from '@hypha/core';
import { z } from 'zod';

export const PLAN_CANDIDATE_SCHEMA_VERSION = '1.0.0' as const;
export const PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH = hashCanonicalJson({
  contract: 'theta.planner-v3.tools',
  version: '3.0.0',
});

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const targetValue = z.union([scalar, z.array(scalar)]);
const configurableValue = z.union([scalar, z.array(scalar)]);

export const intentPlanBindingSchema = z.object({
  researchItemId: z.string().min(1),
  disposition: z.enum([
    'implemented',
    'post_training_only',
    'inherited_workspace',
    'pipeline_managed',
    'intentionally_excluded',
    'needs_user_decision',
  ]),
  planTargets: z.array(z.object({
    path: z.string().min(1),
    value: targetValue,
  }).strict()).default([]),
  rationale: z.string().min(1).max(4_000),
  evidenceRefs: z.array(z.string().min(1)).default([]),
}).strict();

export type IntentPlanBinding = z.infer<typeof intentPlanBindingSchema>;

// This is the only decision surface exposed to the language model. Dataset
// bindings, preprocessing, runtime resources, evaluation and visualization are
// compiled by the backend/Python pipeline and are deliberately absent here.
export const plannerDecisionDraftSchema = z.object({
  datasetRef: z.string().min(1),
  model: z.object({
    modelId: z.string().regex(/^[a-z0-9_-]+$/),
    mode: z.string().min(1),
    parameters: z.record(scalar),
    rationale: z.string().min(1).max(4_000),
    capabilityObservationRefs: z.array(z.string().min(1)).default([]),
  }).strict(),
  seed: z.number().int().min(0).max(2_147_483_647),
  intentBindings: z.array(intentPlanBindingSchema).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1).max(8_000),
}).strict();

export type PlannerDecisionDraft = z.infer<typeof plannerDecisionDraftSchema>;

export const candidatePlanDraftSchema = z.object({
  datasetRef: z.string().min(1),
  model: z.object({
    modelId: z.string().regex(/^[a-z0-9_-]+$/),
    mode: z.string().min(1),
    parameters: z.record(scalar),
    rationale: z.string().min(1).max(4_000),
    capabilityObservationRefs: z.array(z.string().min(1)).default([]),
  }).strict(),
  columns: z.object({
    textColumns: z.array(z.string().min(1)).min(1),
    timeColumn: z.string().min(1).nullable().default(null),
    trainingCovariates: z.array(z.string().min(1)).default([]),
    displayGroups: z.array(z.string().min(1)).default([]),
    idColumn: z.string().min(1).nullable().default(null),
  }).strict(),
  preprocessing: z.record(configurableValue).default({}),
  experimentProtocol: z.object({
    seeds: z.array(z.number().int().min(0).max(2_147_483_647)).length(1),
    baselines: z.array(z.string().regex(/^[a-z0-9_-]+$/)).length(0).default([]),
    estimatedTrainingRuns: z.literal(1),
  }).strict(),
  evaluation: z.object({
    metrics: z.array(z.string().min(1)).min(1),
    stabilityChecks: z.array(z.string().min(1)).default([]),
    interpretationProtocol: z.array(z.string().min(1)).min(1),
  }).strict(),
  visualizations: z.array(z.string().min(1)).default([]),
  resources: z.object({
    cpuLevel: z.enum(['low', 'medium', 'high']),
    memoryLevel: z.enum(['low', 'medium', 'high']),
    timeLevel: z.enum(['minutes', 'hours', 'long_running']),
    offlineRequired: z.boolean(),
  }).strict(),
  intentBindings: z.array(intentPlanBindingSchema).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1).max(8_000),
}).strict();

export type CandidatePlanDraft = z.infer<typeof candidatePlanDraftSchema>;

export interface CandidatePlan extends CandidatePlanDraft {
  schemaVersion: typeof PLAN_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  candidateRef: string;
  revision: number;
  runId: string;
  datasetHash: string;
  datasetWorkspaceHash: string;
  researchWorkspaceHash: string;
  toolContractSnapshotHash: string;
  candidatePlanHash: string;
  createdAt: string;
  supersedesCandidateRef?: string;
}

export type ValidationRepairability =
  | 'agent_can_repair'
  | 'needs_more_observation'
  | 'needs_user_decision'
  | 'not_repairable';

export interface ValidationIssue {
  code: string;
  severity: 'blocking' | 'warning' | 'info';
  target: string;
  message: string;
  evidenceRefs: string[];
  repairability: ValidationRepairability;
  allowedRepairs: string[];
}

export interface EvidenceSelectionReceipt {
  receiptId: string;
  runId: string;
  candidateRef: string;
  candidatePlanHash: string;
  researchWorkspaceHash: string;
  selectedEvidenceIds: string[];
  evidenceBundleHash: string;
  createdAt: string;
}

export interface PlanValidationReceipt {
  receiptId: string;
  runId: string;
  candidateRef: string;
  candidatePlanHash: string;
  evidenceBundleHash: string;
  valid: boolean;
  issues: ValidationIssue[];
  validationReceiptHash: string;
  createdAt: string;
}

export interface PlanApprovalReceipt {
  receiptId: string;
  runId: string;
  checkpointId: string;
  checkpointContentHash: string;
  candidateRef: string;
  candidatePlanHash: string;
  planWorkspaceHash: string;
  validationReceiptHash: string;
  evidenceBundleHash: string;
  principalId: string;
  messageId: string;
  approvedAt: string;
  planApprovalHash: string;
}

export const candidatePlanHash = (
  input: Omit<CandidatePlan, 'candidatePlanHash' | 'createdAt' | 'candidateRef'>,
): string => hashCanonicalJson(input);

export const evidenceBundleHash = (input: {
  candidatePlanHash: string;
  researchWorkspaceHash: string;
  selectedEvidenceIds: string[];
}): string => hashCanonicalJson({
  ...input,
  selectedEvidenceIds: [...new Set(input.selectedEvidenceIds)].sort(),
});

export const validationReceiptHash = (
  input: Omit<PlanValidationReceipt, 'validationReceiptHash' | 'createdAt'>,
): string => hashCanonicalJson(input);

export const planApprovalReceiptHash = (
  input: Omit<PlanApprovalReceipt, 'planApprovalHash' | 'approvedAt'>,
): string => hashCanonicalJson(input);

export const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
