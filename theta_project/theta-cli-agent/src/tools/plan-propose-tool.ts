import type { JsonSchema } from "@hypha/core";
import type { ToolHandler, ToolSpec } from "@hypha/tools";
import { createMiniMaxProviderFromEnv } from "../providers/minimax.js";
import { evidenceBundleSchema, type EvidenceBundle } from "../rag/evidence-bundle.js";
import { recommendationResultSchema } from "../recommendation/contracts.js";
import { planProposalResultSchema, type PlanProposalResult } from "../planner/contracts.js";
import { ThetaPlannerService } from "../planner/service.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaPlanProposeInput {
  enabled: boolean;
  researchBrief: Record<string, unknown>;
  datasetProfile: Record<string, unknown>;
  columnConfirmation: Record<string, unknown>;
  recommendation: Record<string, unknown>;
  evidenceBundle: EvidenceBundle;
}
export type ThetaPlanProposeOutput = PlanProposalResult;

const inputSchema: JsonSchema = {
  type: "object",
  required: ["enabled", "researchBrief", "datasetProfile", "columnConfirmation", "recommendation", "evidenceBundle"],
  properties: {
    enabled: { type: "boolean" },
    researchBrief: { type: "object", additionalProperties: true },
    datasetProfile: { type: "object", additionalProperties: true },
    columnConfirmation: { type: "object", additionalProperties: true },
    recommendation: { type: "object", additionalProperties: true },
    evidenceBundle: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: "object",
  required: ["schemaVersion", "source", "factsHash", "inputSnapshot", "plannerProgress", "draft"],
  properties: {
    schemaVersion: { const: "1.0.0" },
    source: { enum: ["minimax", "deterministic"] },
    fallbackReason: { type: "string" },
    fallbackDetail: { type: "string", maxLength: 500 },
    boundaryAdjustments: { type: "array", items: { type: "string" }, maxItems: 12 },
    factsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    inputSnapshot: {
      type: "object",
      required: [
        "schemaVersion",
        "researchBriefHash",
        "datasetProfileHash",
        "columnConfirmationHash",
        "recommendationHash",
        "evidenceBundleHash",
        "factsHash",
        "snapshotHash",
      ],
      properties: {
        schemaVersion: { const: "1.0.0" },
        researchBriefHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        datasetProfileHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        columnConfirmationHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        recommendationHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        evidenceBundleHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        factsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        snapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      additionalProperties: false,
    },
    plannerProgress: { type: "array", items: { type: "object", additionalProperties: true } },
    evidenceSelectionReceipts: {
      type: "array",
      items: {
        type: "object",
        required: [
          "schemaVersion",
          "receiptId",
          "evidenceBundleHash",
          "factsHash",
          "attempt",
          "provider",
          "model",
          "outcome",
          "availableEvidenceIds",
          "acceptedEvidenceIds",
          "rejectedEvidence",
          "bindings",
          "issues",
          "createdAt",
        ],
        properties: {
          schemaVersion: { const: "1.0.0" },
          receiptId: { type: "string", pattern: "^evidence_selection_[a-f0-9]{20}$" },
          evidenceBundleHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          factsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          attempt: { type: "integer", minimum: 1 },
          provider: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          outcome: { enum: ["accepted", "rejected"] },
          availableEvidenceIds: { type: "array", items: { type: "string" } },
          acceptedEvidenceIds: { type: "array", items: { type: "string" } },
          rejectedEvidence: { type: "array", items: { type: "object", additionalProperties: true } },
          bindings: {
            type: "array",
            items: {
              type: "object",
              required: ["targetId", "evidenceIds", "compatible"],
              properties: {
                targetId: { type: "string", minLength: 1 },
                evidenceIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                compatible: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
          issues: {
            type: "array",
            items: {
              type: "object",
              required: ["targetId", "evidenceId", "code", "message"],
              properties: {
                targetId: { type: "string", minLength: 1 },
                evidenceId: { anyOf: [{ type: "string" }, { type: "null" }] },
                code: { type: "string", minLength: 1 },
                message: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          },
          createdAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
    },
    draft: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaPlanProposeToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planPropose,
  version: "1.3.0",
  displayName: "Propose Evidence-Grounded Training Plan",
  description: "Ask the bounded MiniMax Planner for a research-plan draft; deterministic fallback is mandatory.",
  tags: ["theta", "plan", "planner", "minimax"],
  inputSchema,
  outputSchema,
  sideEffectLevel: "read",
  permissionScope: [THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.ragRead, THETA_PERMISSION_SCOPES.inferenceUse],
  timeoutPolicy: { timeoutMs: 180_000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: true },
  source: "local",
};

export const thetaPlanProposeHandler: ToolHandler<unknown, ThetaPlanProposeOutput> = async (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("plan.propose input must be an object.");
  const value = input as ThetaPlanProposeInput;
  const service = new ThetaPlannerService({
    enabled: value.enabled,
    provider: value.enabled
      ? createMiniMaxProviderFromEnv({ timeoutMs: plannerTimeoutMs() })
      : undefined,
    modelAlias: process.env.MINIMAX_MODEL,
  });
  return planProposalResultSchema.parse(await service.propose({
    researchBrief: value.researchBrief,
    datasetProfile: value.datasetProfile,
    columnConfirmation: value.columnConfirmation,
    recommendation: recommendationResultSchema.parse(value.recommendation),
    evidenceBundle: evidenceBundleSchema.parse(value.evidenceBundle),
  }));
};

const plannerTimeoutMs = (): number => {
  const configured = Number(process.env.MINIMAX_PLANNER_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 180_000
    ? configured
    : 150_000;
};
