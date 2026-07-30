import type {
  ColumnConfirmation,
  ResearchBrief,
} from "../agent/research-contracts.js";
import type { EvidenceRef } from "../rag/contracts.js";
import {
  RECOMMENDATION_VERSION,
  recommendationResultSchema,
  type ModelRecommendation,
  type ParameterRecommendation,
  type RecommendationResult,
  type ResourceEstimate,
  type TopicRecommendation,
} from "./contracts.js";
import {
  capabilitiesForModel,
  deriveResearchRequirements,
  unmetResearchCapabilities,
  type ModelCapabilities,
  type ResearchRequirements,
} from './model-capabilities.js';

export interface CatalogModel {
  id: string;
  name: string;
  type: string;
  requires: string[];
  params: Record<string, unknown>;
  runnable?: boolean;
  experimental?: boolean;
}

export interface DeterministicRecommendationInput {
  catalogSource: string;
  models: CatalogModel[];
  dataProfile: Record<string, unknown>;
  columnConfirmation?: ColumnConfirmation;
  researchBrief?: ResearchBrief;
  researchGoal?: string;
  constraints?: Record<string, unknown>;
  evidence?: EvidenceRef[];
}

interface ProfileSummary {
  rowCount: number;
  textColumnCount: number;
  timeColumnCount: number;
  metadataColumnCount: number;
  averageTextLength: number;
}

export const recommendModels = (
  input: DeterministicRecommendationInput,
): RecommendationResult => {
  const summary = summarizeProfile(input);
  const constraints = normalizedConstraints(input.constraints);
  const evidence = input.evidence ?? [];
  const recommendations: ModelRecommendation[] = [];
  const degradedRecommendations: ModelRecommendation[] = [];
  const skipped: RecommendationResult["skipped"] = [];
  const researchRequirements = deriveResearchRequirements(input.researchBrief);

  for (const model of [...input.models].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const modelId = model.id.toLowerCase();
    const hardFailures = hardConstraintFailures(
      model,
      summary,
      input,
      constraints,
    );
    if (hardFailures.length > 0) {
      skipped.push({ modelId, reasonCodes: hardFailures });
      continue;
    }

    const capabilities = capabilitiesForModel(model);
    const unmet = unmetResearchCapabilities(
      capabilities,
      researchRequirements,
    );
    const built = buildRecommendation(
      model,
      summary,
      input,
      constraints,
      evidenceForModel(model, evidence),
      capabilities,
      unmet,
    );
    if (unmet.length === 0) {
      recommendations.push(built);
    } else {
      degradedRecommendations.push({
        ...built,
        score: Math.max(0, built.score - 12 * unmet.length),
        warnings: [
          ...built.warnings,
          ...unmet.map(
            (requirement) => `UNMET_RESEARCH_REQUIREMENT:${requirement}`,
          ),
        ],
      });
    }
  }

  const degradationRequired =
    recommendations.length === 0 && degradedRecommendations.length > 0;
  const selectable = degradationRequired
    ? degradedRecommendations
    : recommendations;
  selectable.sort(
    (a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId),
  );
  const ranked = selectable.slice(0, 5).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const warnings = new Set<string>();
  if (evidence.length === 0) warnings.add("NO_EVIDENCE_AVAILABLE");
  if (summary.rowCount < 100) warnings.add("SMALL_CORPUS");
  if (ranked.length === 0) warnings.add("NO_COMPATIBLE_MODEL");
  if (degradationRequired) warnings.add('EXPLICIT_DEGRADATION_APPROVAL_REQUIRED');
  if (ranked[0] && ranked[0].confidence === "low") {
    warnings.add("LOW_CONFIDENCE_RECOMMENDATION");
  }

  return recommendationResultSchema.parse({
    schemaVersion: RECOMMENDATION_VERSION,
    deterministic: true,
    recommendationVersion: RECOMMENDATION_VERSION,
    catalogSource: input.catalogSource || "theta-model-catalog",
    dataProfileSummary: summary,
    recommendations: ranked,
    skipped,
    warnings: [...warnings],
    constraintsApplied: constraints,
    researchRequirements,
    degradation: {
      required: degradationRequired,
      unmetRequirements: [
        ...new Set(
          ranked.flatMap(
            (item) => item.capabilityAssessment.unmetResearchRequirements,
          ),
        ),
      ],
      message: degradationRequired
        ? '没有模型同时满足全部研究目标与运行约束；继续前必须明确接受列出的能力降级。'
        : null,
    },
    noEvidence: evidence.length === 0,
  });
};

const summarizeProfile = (
  input: DeterministicRecommendationInput,
): ProfileSummary => {
  const profile = input.dataProfile;
  const columns = input.columnConfirmation;
  const candidates = record(profile.columnCandidates);
  const textProfiles = array(profile.columnProfiles);
  const textColumn = columns?.textColumns[0];
  const matchingProfile = textProfiles
    .map(record)
    .find((item) => item.name === textColumn);
  return {
    rowCount: integer(profile.rowCount),
    textColumnCount:
      columns?.textColumns.length ||
      array(candidates.text).length ||
      array(profile.textColumns).length,
    timeColumnCount:
      (columns?.timeColumn ? 1 : 0) ||
      array(candidates.time).length ||
      array(profile.timeColumns).length,
    metadataColumnCount:
      columns?.metadataColumns.length ||
      array(candidates.metadata).length ||
      array(profile.metadataColumns).length,
    averageTextLength:
      number(matchingProfile?.avgLength) ||
      number(record(profile.textLengthDistribution).average),
  };
};

const normalizedConstraints = (
  value: Record<string, unknown> | undefined,
): RecommendationResult["constraintsApplied"] => ({
  preferredModelIds: strings(value?.preferredModelIds).sort(),
  forbiddenModelIds: strings(value?.forbiddenModelIds).sort(),
  unavailableRequirements: strings(value?.unavailableRequirements).sort(),
  mode: typeof value?.mode === "string" ? value.mode : null,
  maxTopics:
    typeof value?.maxTopics === "number" && Number.isInteger(value.maxTopics)
      ? value.maxTopics
      : null,
});

const hardConstraintFailures = (
  model: CatalogModel,
  summary: ProfileSummary,
  input: DeterministicRecommendationInput,
  constraints: RecommendationResult["constraintsApplied"],
): string[] => {
  const failures = new Set<string>();
  const modelId = model.id.toLowerCase();
  const requirements = model.requires.map((item) => item.toLowerCase());
  if (model.runnable === false) failures.add("MODEL_NOT_RUNNABLE");
  if (constraints.forbiddenModelIds.includes(modelId)) {
    failures.add("MODEL_FORBIDDEN");
  }
  if (summary.textColumnCount === 0) failures.add("TEXT_COLUMN_REQUIRED");
  if (requirements.includes("time") && summary.timeColumnCount === 0) {
    failures.add("TIME_COLUMN_REQUIRED");
  }
  if (
    requirements.includes("covariates") &&
    summary.metadataColumnCount === 0
  ) {
    failures.add("COVARIATE_COLUMN_REQUIRED");
  }
  if (
    requirements.some((requirement) =>
      constraints.unavailableRequirements.includes(requirement),
    )
  ) {
    failures.add("DEPENDENCY_UNAVAILABLE");
  }
  if (
    constraints.mode &&
    modelId !== "theta" &&
    constraints.mode !== "unsupervised"
  ) {
    failures.add("MODE_NOT_SUPPORTED");
  }
  if (summary.rowCount < minimumRows(model)) {
    failures.add("DATASET_BELOW_ABSOLUTE_MINIMUM");
  }
  if (
    input.researchBrief?.hardwareLimit.device === "cpu" &&
    modelId === "theta" &&
    input.constraints?.modelSize === "8B"
  ) {
    failures.add("DEVICE_CANNOT_RUN_MODEL");
  }
  return [...failures].sort();
};

const buildRecommendation = (
  model: CatalogModel,
  summary: ProfileSummary,
  input: DeterministicRecommendationInput,
  constraints: RecommendationResult["constraintsApplied"],
  evidence: EvidenceRef[],
  capabilities: ModelCapabilities,
  unmetRequirements: ResearchRequirements['required'],
): ModelRecommendation => {
  const modelId = model.id.toLowerCase();
  const reasonCodes = new Set<string>(["RUNNABLE_CATALOG_MODEL"]);
  const warnings = new Set<string>();
  const goal = `${input.researchGoal ?? ""} ${
    input.researchBrief?.researchQuestion ?? ""
  }`.toLowerCase();
  let score = model.type === "traditional" ? 58 : 52;

  if (constraints.preferredModelIds.includes(modelId)) {
    score += 12;
    reasonCodes.add("CALLER_PREFERENCE");
  }
  if (modelId === "dtm" && input.researchBrief?.trendAnalysis) {
    score += 24;
    reasonCodes.add("TREND_ANALYSIS_MATCH");
  }
  if (modelId === "btm" && summary.averageTextLength < 80) {
    score += 18;
    reasonCodes.add("SHORT_TEXT_MATCH");
  }
  if (modelId === "stm" && summary.metadataColumnCount > 0) {
    score += 14;
    reasonCodes.add("COVARIATE_MATCH");
  }
  if (modelId === "hdp" && /auto|自动|unknown topic/.test(goal)) {
    score += 12;
    reasonCodes.add("AUTO_TOPIC_COUNT_MATCH");
  }
  if (["lda", "btm"].includes(modelId) && /baseline|基线/.test(goal)) {
    score += 14;
    reasonCodes.add("BASELINE_GOAL_MATCH");
  }
  if (modelId === "theta") {
    score += 10;
    reasonCodes.add("THETA_NATIVE_MODEL");
  }
  if (summary.rowCount < 100 && model.type === "neural") {
    score -= 15;
    warnings.add("NEURAL_MODEL_SMALL_CORPUS");
  }
  if (evidence.length > 0) {
    score += Math.min(10, Math.round(evidence[0].finalScore / 10));
    reasonCodes.add("EVIDENCE_SUPPORTED");
  }

  const topicRecommendation = recommendTopics(summary.rowCount, constraints);
  const mode = recommendMode(modelId, constraints.mode);
  const batchSize = summary.rowCount < 500 ? 32 : 64;
  const epochs =
    model.type === "traditional" ? 100 : summary.rowCount < 500 ? 30 : 50;
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const confidence =
    boundedScore >= 80 && evidence.length > 0
      ? "high"
      : boundedScore >= 60
        ? "medium"
        : "low";

  return {
    rank: 1,
    modelId,
    modelName: model.name || modelId.toUpperCase(),
    score: boundedScore,
    confidence,
    reasonCodes: [...reasonCodes],
    warnings: [...warnings],
    requirements: [...model.requires].sort(),
    topicRecommendation,
    parameters: recommendParameters({
      model,
      topicRecommendation,
      batchSize,
      epochs,
      evidence,
      confidence,
    }),
    resourceEstimate: estimateResources(model),
    evidenceRefs: evidence,
    capabilityAssessment: {
      ...capabilities,
      unmetResearchRequirements: unmetRequirements,
    },
    recommendedPlanPatch: {
      modelId,
      mode,
      numTopics: topicRecommendation.firstRun,
      batchSize,
      epochs,
    },
  };
};

const recommendTopics = (
  rowCount: number,
  constraints: RecommendationResult["constraintsApplied"],
): TopicRecommendation => {
  const naturalMax = rowCount < 100 ? 8 : rowCount < 500 ? 15 : 30;
  const maximum = Math.max(
    2,
    Math.min(200, constraints.maxTopics ?? naturalMax),
  );
  const minimum = Math.min(maximum, rowCount < 50 ? 2 : 5);
  const firstRun = Math.max(
    minimum,
    Math.min(maximum, Math.round((minimum + maximum) / 2)),
  );
  return {
    range: [minimum, maximum],
    firstRun,
    alternatives: [...new Set([minimum, maximum])],
  };
};

const recommendParameters = (input: {
  model: CatalogModel;
  topicRecommendation: TopicRecommendation;
  batchSize: number;
  epochs: number;
  evidence: EvidenceRef[];
  confidence: "low" | "medium" | "high";
}): ParameterRecommendation[] => {
  const evidenceRefs = input.evidence.map((item) => item.evidenceId);
  return [
    {
      name: "numTopics",
      recommended: input.topicRecommendation.firstRun,
      range: input.topicRecommendation.range,
      default: catalogDefault(input.model, "num_topics", 20),
      reasonCodes: ["CORPUS_SIZE_TOPIC_RANGE"],
      evidenceRefs,
      confidence: input.confidence,
      effectIfHigher: "Increases topic granularity and fragmentation risk.",
      effectIfLower: "Produces broader topics and may merge distinct themes.",
    },
    {
      name: "batchSize",
      recommended: input.batchSize,
      range: [16, 128],
      default: catalogDefault(input.model, "batch_size", 64),
      reasonCodes: ["RESOURCE_AWARE_BATCH_SIZE"],
      evidenceRefs,
      confidence: input.confidence,
      effectIfHigher: "Uses more memory and may improve throughput.",
      effectIfLower: "Uses less memory with potentially noisier updates.",
    },
    {
      name: "epochs",
      recommended: input.epochs,
      range: [10, 100],
      default: catalogDefault(input.model, "epochs", 100),
      reasonCodes: ["MODEL_TYPE_EPOCH_BUDGET"],
      evidenceRefs,
      confidence: input.confidence,
      effectIfHigher: "Increases runtime and overfitting risk.",
      effectIfLower: "Reduces runtime but may underfit.",
    },
  ];
};

const catalogDefault = (
  model: CatalogModel,
  key: string,
  fallback: string | number | boolean | null,
): string | number | boolean | null => {
  const value = record(model.params[key]).default;
  return ["string", "number", "boolean"].includes(typeof value) ||
    value === null
    ? (value as string | number | boolean | null)
    : fallback;
};

const estimateResources = (model: CatalogModel): ResourceEstimate => {
  const requirements = model.requires.map((item) => item.toLowerCase());
  const neural = model.type === "neural";
  const embedding = requirements.some((item) =>
    ["sbert", "qwen", "word2vec"].includes(item),
  );
  return {
    cpu: neural ? "high" : "medium",
    gpu: neural ? "optional" : "none",
    memory: neural ? "high" : "medium",
    disk: embedding ? "high" : "low",
    relativeRuntime: neural ? "long" : "medium",
    network: embedding ? "optional" : "none",
  };
};

const evidenceForModel = (
  model: CatalogModel,
  evidence: readonly EvidenceRef[],
): EvidenceRef[] => {
  const terms = [model.id, model.name, ...model.requires].map((item) =>
    item.toLowerCase(),
  );
  const matching = evidence.filter((item) => {
    const text = `${item.symbol ?? ""} ${item.excerpt}`.toLowerCase();
    return terms.some((term) => text.includes(term));
  });
  return (matching.length > 0 ? matching : evidence).slice(0, 3);
};

const minimumRows = (model: CatalogModel): number => {
  if (model.id.toLowerCase() === "dtm") return 30;
  if (model.id.toLowerCase() === "bertopic") return 30;
  return model.type === "neural" ? 20 : 10;
};

const recommendMode = (
  modelId: string,
  requested: string | null,
): ModelRecommendation["recommendedPlanPatch"]["mode"] => {
  if (
    modelId === "theta" &&
    requested &&
    ["zero_shot", "finetune", "supervised", "unsupervised"].includes(requested)
  ) {
    return requested as ModelRecommendation["recommendedPlanPatch"]["mode"];
  }
  return modelId === "theta" ? "zero_shot" : "unsupervised";
};

const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  array(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const integer = (value: unknown): number =>
  Math.max(0, Math.trunc(number(value)));
