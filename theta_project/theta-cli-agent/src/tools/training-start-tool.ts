import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import {
  approvalReceiptSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
  type ApprovalReceipt,
  type DryRunReceipt,
  type TrainingPlanRecord,
} from "../planning/contracts.js";
import { assertApprovalChain } from "../planning/engine.js";
import { callThetaBridge } from "./bridge.js";
import type {
  ThetaExpectedArtifact,
  ThetaTrainingCommand,
} from "./training-dry-run-tool.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaTrainingStartInput {
  plan: TrainingPlanRecord;
  planReview: ApprovalReceipt;
  dryRun: DryRunReceipt;
  trainingReview: ApprovalReceipt;
  idempotencyKey: string;
}

export interface ThetaTrainingStartOutput {
  trainingRunId: string;
  planId: string;
  planHash: string;
  planReviewApprovalId: string;
  trainingReviewApprovalId: string;
  dryRunHash: string;
  status: string;
  progress: number;
  processStarted: boolean;
  pid?: number | null;
  currentStep: string;
  logPath?: string | null;
  commands: ThetaTrainingCommand[];
  expectedArtifacts?: ThetaExpectedArtifact[];
  artifacts?: ThetaExpectedArtifact[];
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
  message: string;
}

const trainingStartInputSchema: JsonSchema = {
  type: "object",
  required: [
    "plan",
    "planReview",
    "dryRun",
    "trainingReview",
    "idempotencyKey",
  ],
  properties: {
    plan: { type: "object", additionalProperties: true },
    planReview: { type: "object", additionalProperties: true },
    dryRun: { type: "object", additionalProperties: true },
    trainingReview: { type: "object", additionalProperties: true },
    idempotencyKey: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const trainingStartOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "trainingRunId",
    "planId",
    "planHash",
    "planReviewApprovalId",
    "trainingReviewApprovalId",
    "dryRunHash",
    "status",
    "progress",
    "processStarted",
    "currentStep",
    "commands",
    "message",
  ],
  properties: {
    trainingRunId: { type: "string" },
    planId: { type: "string" },
    planHash: { type: "string" },
    planReviewApprovalId: { type: "string" },
    trainingReviewApprovalId: { type: "string" },
    dryRunHash: { type: "string" },
    status: { type: "string" },
    progress: { type: "number" },
    processStarted: { type: "boolean" },
    pid: { anyOf: [{ type: "integer" }, { type: "null" }] },
    currentStep: { type: "string" },
    logPath: { anyOf: [{ type: "string" }, { type: "null" }] },
    commands: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    expectedArtifacts: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    artifacts: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    errorMessage: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    message: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaTrainingStartToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStart,
  version: "2.0.0",
  displayName: "Start Training",
  description:
    "Start THETA only with a canonical plan, HumanPlanReview, successful dry-run, and distinct HumanTrainingReview.",
  tags: ["theta", "training"],
  inputSchema: trainingStartInputSchema,
  outputSchema: trainingStartOutputSchema,
  sideEffectLevel: "external_effect",
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  humanApprovalPolicy: {
    required: true,
    reason:
      "Starting THETA training creates a background process and local model artifacts.",
  },
  idempotencyPolicy: { mode: "required" },
  timeoutPolicy: { timeoutMs: 60000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizeTrainingStartInput = (
  input: unknown,
): ThetaTrainingStartInput => {
  if (!input || typeof input !== "object") {
    throw new Error("training.start input must be an object.");
  }
  const value = input as ThetaTrainingStartInput;
  const normalized = {
    plan: trainingPlanRecordSchema.parse(value.plan),
    planReview: approvalReceiptSchema.parse(value.planReview),
    dryRun: dryRunReceiptSchema.parse(value.dryRun),
    trainingReview: approvalReceiptSchema.parse(value.trainingReview),
    idempotencyKey: value.idempotencyKey,
  };
  if (!normalized.idempotencyKey?.trim())
    throw new Error("idempotencyKey is required.");
  assertApprovalChain(normalized);
  return normalized;
};

export const thetaTrainingStartHandler: ToolHandler<
  unknown,
  ThetaTrainingStartOutput
> = async (input: unknown, context: ToolCallContext) => {
  const value = normalizeTrainingStartInput(input);
  const response = await callThetaBridge("training.start", value, {
    runId: context.runId,
    stepId: context.stepId,
  });
  if (
    response.status !== "ok" ||
    !response.data ||
    typeof response.data !== "object"
  ) {
    throw new Error(
      response.error?.message ?? "training.start bridge command failed.",
    );
  }
  return response.data as unknown as ThetaTrainingStartOutput;
};
