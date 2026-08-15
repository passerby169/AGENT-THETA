import { canonicalizeJson, hashCanonicalJson } from '@hypha/core';
import { z } from 'zod';

export const CANONICAL_PLAN_SCHEMA_VERSION = '3.0.0' as const;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const fileSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const configurableValueSchema = z.union([scalarSchema, z.array(scalarSchema)]);

export const executableModelSchema = z.object({
  modelId: z.string().regex(/^[a-z0-9_-]+$/u),
  mode: z.enum(['zero_shot', 'supervised', 'unsupervised']),
  topicCountMode: z.enum(['fixed', 'auto', 'target_reduction']),
  numTopics: z.number().int().min(2).max(200).nullable(),
  maxTopics: z.number().int().min(2).max(1_000).nullable(),
  parameters: z.record(scalarSchema),
}).strict();

export const canonicalPlanSchema = z.object({
  schemaVersion: z.literal(CANONICAL_PLAN_SCHEMA_VERSION),
  runId: z.string().min(1),
  datasetId: z.string().min(1),
  datasetRef: z.string().min(1),
  datasetSha256: fileSha256Schema,
  researchIntentSummary: z.string().min(1).max(12_000),
  model: executableModelSchema,
  columns: z.object({
    textColumns: z.array(z.string().min(1)).min(1),
    timeColumn: z.string().min(1).nullable(),
    idColumn: z.string().min(1).nullable(),
    covariateColumns: z.array(z.string().min(1)),
    metadataColumns: z.array(z.string().min(1)),
    groupingColumns: z.array(z.string().min(1)),
    evaluationLabelColumns: z.array(z.string().min(1)),
  }).strict(),
  preprocessing: z.record(configurableValueSchema),
  experimentProtocol: z.object({
    mode: z.literal('quick'),
    primarySeeds: z.array(z.number().int().min(0).max(2_147_483_647)).length(1),
    baselines: z.array(z.object({
      model: executableModelSchema,
      seeds: z.array(z.number().int().min(0).max(2_147_483_647)).min(1).max(10),
    }).strict()).length(0),
    estimatedTrainingRuns: z.literal(1),
    rationale: z.string().min(1).max(8_000),
    evidenceRefs: z.array(z.string().min(1)),
    confidence: z.enum(['low', 'medium', 'high']),
  }).strict(),
  evaluation: z.object({
    metrics: z.array(z.string().min(1)).min(1),
    stabilityChecks: z.array(z.string().min(1)),
    interpretationProtocol: z.array(z.string().min(1)).min(1),
  }).strict(),
  visualizations: z.array(z.string().min(1)),
  artifactRequirements: z.array(z.object({
    modelId: z.string().regex(/^[a-z0-9_-]+$/u),
    artifactId: z.string().min(1),
    pathPattern: z.string().min(1),
    required: z.boolean(),
    description: z.string().min(1),
  }).strict()).min(1),
  resources: z.object({
    device: z.literal('cpu'),
    cpuLevel: z.enum(['low', 'medium', 'high']),
    memoryLevel: z.enum(['low', 'medium', 'high']),
    timeLevel: z.enum(['minutes', 'hours', 'long_running']),
    networkAllowed: z.boolean(),
  }).strict(),
  provenance: z.object({
    candidateRef: z.string().min(1),
    candidatePlanHash: sha256Schema,
    datasetWorkspaceHash: sha256Schema,
    researchWorkspaceHash: sha256Schema,
    toolContractSnapshotHash: sha256Schema,
    evidenceBundleHash: sha256Schema,
    validationReceiptHash: sha256Schema,
    planWorkspaceHash: sha256Schema,
    planApprovalHash: sha256Schema,
    approvalPrincipalId: z.string().min(1),
  }).strict(),
  assumptions: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
  rationale: z.string().min(1).max(8_000),
}).strict();

export type ExecutableModel = z.infer<typeof executableModelSchema>;
export type CanonicalPlan = z.infer<typeof canonicalPlanSchema>;

export interface CanonicalPlanRecord {
  planId: string;
  planHash: string;
  canonicalPlan: CanonicalPlan;
  canonicalJson: string;
  createdAt: string;
}

export interface CanonicalPlanIssue {
  code: string;
  target: string;
  message: string;
}

export const canonicalPlanJson = (plan: CanonicalPlan): string =>
  canonicalizeJson(canonicalPlanSchema.parse(plan));

export const canonicalPlanHash = (plan: CanonicalPlan): string =>
  hashCanonicalJson(canonicalPlanSchema.parse(plan));

export const canonicalPlanRecord = (
  plan: CanonicalPlan,
  createdAt = new Date().toISOString(),
): CanonicalPlanRecord => {
  const canonicalPlan = canonicalPlanSchema.parse(plan);
  const planHash = canonicalPlanHash(canonicalPlan);
  return {
    planId: `plan_${planHash.slice('sha256:'.length, 'sha256:'.length + 20)}`,
    planHash,
    canonicalPlan,
    canonicalJson: canonicalPlanJson(canonicalPlan),
    createdAt,
  };
};
