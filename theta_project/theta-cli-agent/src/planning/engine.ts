import { createHash } from "node:crypto";
import {
  columnConfirmationSchema,
  datasetProfileSchema,
  researchBriefSchema,
} from "../agent/research-contracts.js";
import { recommendationResultSchema } from "../recommendation/contracts.js";
import {
  TRAINING_PLAN_SCHEMA_VERSION,
  approvalReceiptSchema,
  canonicalTrainingPlanSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
  type ApprovalReceipt,
  type DryRunReceipt,
  type TrainingPlanRecord,
} from "./contracts.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { evidenceBundleSchema } from "../rag/evidence-bundle.js";
import { planProposalResultSchema } from "../planner/contracts.js";
import { PLAN_VALIDATOR_VERSION } from "./validator-v2.js";

export interface CreateTrainingPlanRecordInput {
  validatedPlan: Record<string, unknown>;
  researchBrief: unknown;
  datasetProfile: unknown;
  columnConfirmation: unknown;
  recommendation: unknown;
  evidenceBundle?: unknown;
  planProposal?: unknown;
  plannerResolution?: unknown;
  validation?: unknown;
  domainPack: { id: string; version: string };
  createdAt: string;
}

export interface CreateApprovalReceiptInput {
  approvalType: ApprovalReceipt["approvalType"];
  plan: TrainingPlanRecord;
  approvedBy: string;
  approvedAt: string;
  dryRunHash?: string;
}

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON cannot encode a non-finite number.");
  }
  if (value === undefined) {
    throw new Error("Canonical JSON cannot encode undefined.");
  }
  return JSON.stringify(value);
};

export const sha256Canonical = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const createTrainingPlanRecord = (
  input: CreateTrainingPlanRecordInput,
): TrainingPlanRecord => {
  const brief = researchBriefSchema.parse(input.researchBrief);
  const profile = datasetProfileSchema.parse(input.datasetProfile);
  const confirmation = columnConfirmationSchema.parse(input.columnConfirmation);
  const recommendation = recommendationResultSchema.parse(input.recommendation);
  const evidenceBundle = input.evidenceBundle === undefined
    ? undefined
    : evidenceBundleSchema.parse(input.evidenceBundle);
  const planProposal = input.planProposal === undefined
    ? undefined
    : planProposalResultSchema.parse(input.planProposal);
  const plannerResolution = record(input.plannerResolution);
  const validation = record(input.validation);
  const validatorVersion = requiredString(
    validation.validatorVersion ?? PLAN_VALIDATOR_VERSION,
    "validation.validatorVersion",
  );
  const acceptedEvidenceRefs = stringArray(
    plannerResolution.acceptedEvidenceRefs,
  );
  const recommendations = recommendation.recommendations;
  if (recommendations.length === 0)
    throw new Error("TrainingPlan requires one compatible recommendation.");
  if (confirmation.datasetSha256 !== profile.datasetSha256) {
    throw new Error(
      "ColumnConfirmation does not bind the active dataset hash.",
    );
  }

  const raw = input.validatedPlan;
  const modelId = requiredString(raw.modelId, "validatedPlan.modelId");
  const selectedRecommendation = recommendations.find(
    (candidate) => candidate.modelId === modelId,
  );
  if (!selectedRecommendation) {
    throw new Error(
      "Validated plan model does not match a compatible recommendation.",
    );
  }
  const capabilityCard = new CapabilityRegistry().require(modelId);
  const parameters = scalarParameters(
    raw,
    capabilityCard.parameters.flatMap((parameter) =>
      parameter.planField &&
      !["mode", "numTopics", "maxTopics"].includes(parameter.planField)
        ? [parameter.planField]
        : [],
    ),
  );
  const canonicalPlan = canonicalTrainingPlanSchema.parse({
    schemaVersion: TRAINING_PLAN_SCHEMA_VERSION,
    datasetId: requiredString(raw.datasetId, "validatedPlan.datasetId"),
    datasetSha256: profile.datasetSha256,
    model: {
      modelId,
      mode: raw.mode,
      topicCountMode: raw.topicCountMode,
      numTopics: raw.numTopics ?? null,
      maxTopics: raw.maxTopics ?? null,
      parameters,
    },
    columns: {
      textColumns: confirmation.textColumns,
      timeColumn: confirmation.timeColumn,
      idColumn: confirmation.idColumn,
      covariateColumns: confirmation.covariateColumns ?? [],
      metadataColumns: confirmation.metadataColumns,
      groupingColumns: confirmation.groupingColumns,
      evaluationLabelColumns: confirmation.evaluationLabelColumns,
    },
    preprocessing: {
      trimWhitespace: true,
      dropEmptyText: true,
      deduplicate: false,
    },
    resources: {
      device: brief.hardwareLimit.device,
      memoryGb: brief.hardwareLimit.memoryGb ?? null,
      networkAllowed: !brief.offlineOnly,
    },
    experimentProtocol:
      Object.keys(record(raw.experimentProtocol)).length > 0
        ? record(raw.experimentProtocol)
        : {
            mode: "quick",
            primarySeeds: [42],
            baselineModelId: null,
            baselineSeeds: [],
            rationale: "未批准额外比较实验，执行一次主模型快速运行。",
            evidenceRefs: [],
            confidence: "low",
          },
    bindings: {
      researchBriefHash: sha256Canonical(brief),
      datasetProfileHash: sha256Canonical(profile),
      columnConfirmationHash: sha256Canonical(confirmation),
      recommendationHash: sha256Canonical(recommendation),
      evidenceBundleHash:
        evidenceBundle?.bundleHash ?? sha256Canonical(null),
      planProposalHash: sha256Canonical(planProposal ?? null),
      plannerResolutionHash: sha256Canonical(
        input.plannerResolution ?? null,
      ),
      domainPackId: requiredString(input.domainPack.id, "domainPack.id"),
      domainPackVersion: requiredString(
        input.domainPack.version,
        "domainPack.version",
      ),
      recommendationVersion: recommendation.recommendationVersion,
      validatorVersion,
    },
  });
  const planHash = sha256Canonical(canonicalPlan);
  return trainingPlanRecordSchema.parse({
    schemaVersion: TRAINING_PLAN_SCHEMA_VERSION,
    planId: `plan_${planHash.slice(0, 16)}`,
    planHash,
    planVersion: 1,
    status: "draft",
    canonicalPlan,
    review: {
      researchQuestion: brief.researchQuestion,
      datasetFileName: profile.fileName,
      datasetRowCount: profile.rowCount,
      warnings: [
        ...new Set([
          ...recommendation.warnings,
          ...selectedRecommendation.warnings,
        ]),
      ].sort(),
      reasonCodes: [...selectedRecommendation.reasonCodes].sort(),
      evidence: mergedEvidence(
        selectedRecommendation.evidenceRefs,
        evidenceBundle?.evidence ?? [],
        acceptedEvidenceRefs,
      ),
      evidenceBundleHash:
        evidenceBundle?.bundleHash ?? sha256Canonical(null),
      planProposalSource:
        plannerResolution.source === "explicit_user_plan"
          ? "explicit_user_plan"
          : planProposal?.source ?? "deterministic",
      plannerAcceptedEvidenceRefs: acceptedEvidenceRefs,
      evidenceSelectionReceipts: planProposal?.evidenceSelectionReceipts ?? [],
      validatorVersion,
    },
    createdAt: input.createdAt,
  });
};

export const createApprovalReceipt = (
  input: CreateApprovalReceiptInput,
): ApprovalReceipt => {
  const plan = trainingPlanRecordSchema.parse(input.plan);
  const approvedBy = requiredString(input.approvedBy, "approvedBy");
  const approvedAt = new Date(input.approvedAt).toISOString();
  const dryRunHash = input.dryRunHash ?? null;
  const identity = {
    approvalType: input.approvalType,
    planId: plan.planId,
    planHash: plan.planHash,
    dryRunHash,
    approvedBy,
    approvedAt,
  };
  return approvalReceiptSchema.parse({
    schemaVersion: TRAINING_PLAN_SCHEMA_VERSION,
    approvalId: `approval_${sha256Canonical(identity).slice(0, 20)}`,
    ...identity,
  });
};

export const createDryRunReceipt = (
  value: Omit<DryRunReceipt, "schemaVersion" | "dryRunId" | "dryRunHash">,
): DryRunReceipt => {
  const material = {
    planId: value.planId,
    planHash: value.planHash,
    planReviewApprovalId: value.planReviewApprovalId,
    passed: value.passed,
    checks: value.checks,
    commands: value.commands,
    expectedArtifacts: value.expectedArtifacts,
    notes: value.notes,
  };
  const dryRunHash = sha256Canonical(material);
  return dryRunReceiptSchema.parse({
    schemaVersion: TRAINING_PLAN_SCHEMA_VERSION,
    dryRunId: `dryrun_${dryRunHash.slice(0, 16)}`,
    dryRunHash,
    ...value,
  });
};

export const assertApprovalChain = (input: {
  plan: TrainingPlanRecord;
  planReview: ApprovalReceipt;
  dryRun: DryRunReceipt;
  trainingReview: ApprovalReceipt;
}): void => {
  const plan = trainingPlanRecordSchema.parse(input.plan);
  const planReview = approvalReceiptSchema.parse(input.planReview);
  const dryRun = dryRunReceiptSchema.parse(input.dryRun);
  const trainingReview = approvalReceiptSchema.parse(input.trainingReview);
  if (planReview.approvalType !== "human_plan_review") {
    throw new Error("First approval must be HumanPlanReview.");
  }
  if (trainingReview.approvalType !== "human_training_review") {
    throw new Error("Second approval must be HumanTrainingReview.");
  }
  if (planReview.approvalId === trainingReview.approvalId) {
    throw new Error("Plan and training approval IDs must be different.");
  }
  for (const value of [planReview, dryRun, trainingReview]) {
    if (value.planId !== plan.planId || value.planHash !== plan.planHash) {
      throw new Error("Approval chain does not bind the canonical plan hash.");
    }
  }
  if (!dryRun.passed)
    throw new Error("Training cannot start after a failed dry-run.");
  if (dryRun.planReviewApprovalId !== planReview.approvalId) {
    throw new Error("Dry-run does not bind the HumanPlanReview receipt.");
  }
  if (trainingReview.dryRunHash !== dryRun.dryRunHash) {
    throw new Error(
      "HumanTrainingReview does not bind the current dry-run hash.",
    );
  }
};

const scalarParameters = (
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string | number | boolean> =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const item = value[key];
      return typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
        ? [[key, item] as const]
        : [];
    }),
  );

const mergedEvidence = <T extends { evidenceId: string }>(
  recommendationEvidence: readonly T[],
  bundleEvidence: readonly T[],
  acceptedEvidenceRefs: readonly string[],
): T[] => {
  const accepted = new Set(acceptedEvidenceRefs);
  const values = [
    ...bundleEvidence.filter((item) => accepted.has(item.evidenceId)),
    ...recommendationEvidence,
  ];
  return values.filter(
    (item, index) =>
      values.findIndex((candidate) => candidate.evidenceId === item.evidenceId) === index,
  );
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required.`);
  return value;
};
