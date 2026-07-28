import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import {
  createTrainingPlanRecord,
  type CreateTrainingPlanRecordInput,
} from "../planning/engine.js";
import type { TrainingPlanRecord } from "../planning/contracts.js";
import type { ThetaTrainingPlan } from "./plan-validate-tool.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaPlanCreateInput extends Omit<
  CreateTrainingPlanRecordInput,
  "validatedPlan" | "createdAt"
> {
  validatedPlan: ThetaTrainingPlan;
  createdAt?: string;
}

export type ThetaPlanCreateOutput = TrainingPlanRecord;

const planCreateInputSchema: JsonSchema = {
  type: "object",
  required: [
    "validatedPlan",
    "researchBrief",
    "datasetProfile",
    "columnConfirmation",
    "recommendation",
    "domainPack",
  ],
  properties: {
    validatedPlan: {
      type: "object",
      required: ["datasetId", "modelId", "mode", "numTopics"],
      additionalProperties: true,
    },
    researchBrief: { type: "object", additionalProperties: true },
    datasetProfile: { type: "object", additionalProperties: true },
    columnConfirmation: { type: "object", additionalProperties: true },
    recommendation: { type: "object", additionalProperties: true },
    domainPack: {
      type: "object",
      required: ["id", "version"],
      properties: {
        id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

const planCreateOutputSchema: JsonSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "planId",
    "planHash",
    "planVersion",
    "status",
    "canonicalPlan",
    "review",
    "createdAt",
  ],
  properties: {
    schemaVersion: { const: "1.0.0" },
    planId: { type: "string" },
    planHash: { type: "string" },
    planVersion: { type: "integer", minimum: 1 },
    status: { enum: ["draft", "superseded"] },
    canonicalPlan: { type: "object", additionalProperties: true },
    review: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaPlanCreateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planCreate,
  version: "2.0.0",
  displayName: "Create Training Plan",
  description:
    "Create the TypeScript-authoritative canonical THETA plan after Hypha HumanPlanReview.",
  tags: ["theta", "plan"],
  inputSchema: planCreateInputSchema,
  outputSchema: planCreateOutputSchema,
  sideEffectLevel: "write",
  permissionScope: [THETA_PERMISSION_SCOPES.planWrite],
  humanApprovalPolicy: {
    required: true,
    reason:
      "Creating the canonical plan requires the HumanPlanReview decision recorded by Hypha.",
  },
  idempotencyPolicy: { mode: "required" },
  timeoutPolicy: { timeoutMs: 30000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizePlanCreateInput = (input: unknown): ThetaPlanCreateInput => {
  if (!input || typeof input !== "object" || !("validatedPlan" in input)) {
    throw new Error(
      "plan.create input must include validatedPlan and binding snapshots.",
    );
  }
  return input as ThetaPlanCreateInput;
};

export const thetaPlanCreateHandler: ToolHandler<
  unknown,
  ThetaPlanCreateOutput
> = async (input: unknown, _context: ToolCallContext) => {
  const value = normalizePlanCreateInput(input);
  return createTrainingPlanRecord({
    ...value,
    createdAt: value.createdAt ?? new Date().toISOString(),
  });
};
