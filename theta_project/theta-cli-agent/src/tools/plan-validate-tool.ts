import type { JsonSchema } from "@hypha/core";
import type { ToolCallContext, ToolHandler, ToolSpec } from "@hypha/tools";
import { callThetaBridge } from "./bridge.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaTrainingPlan {
  datasetId: string;
  modelId: string;
  mode: "zero_shot" | "finetune" | "supervised" | "unsupervised";
  numTopics: number;
  [key: string]: unknown;
}

export interface ThetaPlanValidateInput {
  plan: ThetaTrainingPlan;
  dataProfile?: Record<string, unknown>;
}

export interface ThetaPlanValidateOutput {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalizedPlan: Record<string, unknown>;
  catalogSource: string;
}

const trainingPlanSchema: JsonSchema = {
  type: "object",
  required: ["datasetId", "modelId", "mode", "numTopics"],
  properties: {
    datasetId: { type: "string" },
    modelId: { type: "string" },
    modelSize: { type: "string" },
    mode: { enum: ["zero_shot", "finetune", "supervised", "unsupervised"] },
    numTopics: { type: "number" },
    batchSize: { type: "number" },
    epochs: { type: "number" },
    learningRate: { type: "number" },
    textColumn: { type: "string" },
    metadataColumns: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const planValidateInputSchema: JsonSchema = {
  type: "object",
  required: ["plan"],
  properties: {
    plan: trainingPlanSchema,
    dataProfile: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

const planValidateOutputSchema: JsonSchema = {
  type: "object",
  required: ["valid", "errors", "warnings", "normalizedPlan", "catalogSource"],
  properties: {
    valid: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    normalizedPlan: {
      type: "object",
      additionalProperties: true,
    },
    catalogSource: { type: "string" },
  },
  additionalProperties: false,
};

export const thetaPlanValidateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planValidate,
  version: "1.0.0",
  displayName: "Validate Training Plan",
  description:
    "Validate a THETA training plan against model catalog and runtime constraints through Hypha governance.",
  tags: ["theta", "plan"],
  inputSchema: planValidateInputSchema,
  outputSchema: planValidateOutputSchema,
  sideEffectLevel: "read",
  permissionScope: [
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.modelRead,
  ],
  timeoutPolicy: {
    timeoutMs: 30000,
    onTimeout: "fail",
  },
  retryPolicy: {
    maxAttempts: 1,
  },
  auditPolicy: {
    enabled: true,
    includeInput: false,
    includeOutput: true,
  },
  source: "local",
};

const normalizePlanValidateInput = (input: unknown): ThetaPlanValidateInput => {
  if (!input || typeof input !== "object" || !("plan" in input)) {
    throw new Error("plan.validate input must include plan.");
  }
  return input as ThetaPlanValidateInput;
};

const ensurePlanValidateOutput = (data: unknown): ThetaPlanValidateOutput => {
  if (!data || typeof data !== "object") {
    throw new Error("plan.validate bridge returned a non-object payload.");
  }
  return data as ThetaPlanValidateOutput;
};

export const thetaPlanValidateHandler: ToolHandler<
  unknown,
  ThetaPlanValidateOutput
> = async (input: unknown, context: ToolCallContext) => {
  const response = await callThetaBridge(
    "plan.validate",
    normalizePlanValidateInput(input),
    {
      runId: context.runId,
      stepId: context.stepId,
    },
  );

  if (response.status !== "ok") {
    throw new Error(
      response.error?.message ?? "plan.validate bridge command failed.",
    );
  }

  const output = ensurePlanValidateOutput(response.data);
  return {
    ...output,
    catalogSource: "theta-model-catalog",
  };
};
