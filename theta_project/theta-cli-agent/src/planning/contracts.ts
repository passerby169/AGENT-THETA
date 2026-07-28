import { z } from "zod";
import { evidenceRefSchema } from "../rag/contracts.js";

export const TRAINING_PLAN_SCHEMA_VERSION = "1.0.0";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const canonicalTrainingPlanSchema = z
  .object({
    schemaVersion: z.literal(TRAINING_PLAN_SCHEMA_VERSION),
    datasetId: z.string().min(1),
    datasetSha256: sha256Schema,
    model: z
      .object({
        modelId: z.string().min(1),
        mode: z.enum(["zero_shot", "finetune", "supervised", "unsupervised"]),
        numTopics: z.number().int().min(2).max(200),
        parameters: z.record(scalarSchema),
      })
      .strict(),
    columns: z
      .object({
        textColumns: z.array(z.string().min(1)).min(1),
        timeColumn: z.string().min(1).nullable(),
        idColumn: z.string().min(1).nullable(),
        metadataColumns: z.array(z.string().min(1)),
      })
      .strict(),
    preprocessing: z
      .object({
        trimWhitespace: z.boolean(),
        dropEmptyText: z.boolean(),
        deduplicate: z.boolean(),
      })
      .strict(),
    resources: z
      .object({
        device: z.enum(["cpu", "gpu", "unknown"]),
        memoryGb: z.number().positive().nullable(),
        networkAllowed: z.boolean(),
      })
      .strict(),
    bindings: z
      .object({
        researchBriefHash: sha256Schema,
        datasetProfileHash: sha256Schema,
        columnConfirmationHash: sha256Schema,
        recommendationHash: sha256Schema,
        domainPackId: z.string().min(1),
        domainPackVersion: z.string().min(1),
        recommendationVersion: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const planReviewSnapshotSchema = z
  .object({
    researchQuestion: z.string().min(1),
    datasetFileName: z.string().min(1),
    datasetRowCount: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    reasonCodes: z.array(z.string().min(1)),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();

export const trainingPlanRecordSchema = z
  .object({
    schemaVersion: z.literal(TRAINING_PLAN_SCHEMA_VERSION),
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    planVersion: z.number().int().positive(),
    status: z.enum(["draft", "superseded"]),
    canonicalPlan: canonicalTrainingPlanSchema,
    review: planReviewSnapshotSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const approvalTypeSchema = z.enum([
  "human_plan_review",
  "human_training_review",
]);

export const approvalReceiptSchema = z
  .object({
    schemaVersion: z.literal(TRAINING_PLAN_SCHEMA_VERSION),
    approvalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    approvalType: approvalTypeSchema,
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    dryRunHash: sha256Schema.nullable(),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.approvalType === "human_plan_review" &&
      value.dryRunHash !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dryRunHash"],
        message: "Plan review must not bind a dry-run hash.",
      });
    }
    if (
      value.approvalType === "human_training_review" &&
      value.dryRunHash === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dryRunHash"],
        message: "Training review must bind a dry-run hash.",
      });
    }
  });

export const dryRunCheckSchema = z
  .object({
    code: z.string().min(1),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string().min(1),
  })
  .strict();

export const trainingCommandSchema = z
  .object({
    step: z.string().min(1),
    cwd: z.string().min(1),
    argv: z.array(z.string()).min(1),
    sideEffect: z.string().min(1),
  })
  .strict();

export const expectedArtifactSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const dryRunReceiptSchema = z
  .object({
    schemaVersion: z.literal(TRAINING_PLAN_SCHEMA_VERSION),
    dryRunId: z.string().regex(/^dryrun_[a-f0-9]{16}$/),
    dryRunHash: sha256Schema,
    planId: z.string().regex(/^plan_[a-f0-9]{16}$/),
    planHash: sha256Schema,
    planReviewApprovalId: z.string().regex(/^approval_[a-f0-9]{20}$/),
    passed: z.boolean(),
    checks: z.array(dryRunCheckSchema).min(1),
    commands: z.array(trainingCommandSchema).min(1),
    expectedArtifacts: z.array(expectedArtifactSchema),
    notes: z.array(z.string()),
    checkedAt: z.string().datetime(),
  })
  .strict();

export type CanonicalTrainingPlan = z.infer<typeof canonicalTrainingPlanSchema>;
export type TrainingPlanRecord = z.infer<typeof trainingPlanRecordSchema>;
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type DryRunCheck = z.infer<typeof dryRunCheckSchema>;
export type DryRunReceipt = z.infer<typeof dryRunReceiptSchema>;
