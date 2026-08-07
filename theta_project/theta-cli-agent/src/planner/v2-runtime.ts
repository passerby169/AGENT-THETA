import type { DatasetConfirmation, DatasetFacts, ResearchIntent } from '../dataset-understanding/contracts.js';
import type { PlanProposalResult } from './contracts.js';
import {
  plannerInputV2Hash,
  plannerInputV2Schema,
  plannerDecisionV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
} from './v2-contracts.js';
import type { RecommendationResult } from '../recommendation/contracts.js';
import type { ThetaTrainingPlan } from '../tools/plan-validate-tool.js';

type Scalar = string | number | boolean | null;

export interface PlannerRuntimeV2Context {
  facts: DatasetFacts;
  confirmation: DatasetConfirmation;
  intent: ResearchIntent;
  recommendation: RecommendationResult;
  constraints?: Record<string, unknown>;
  userOverrides?: Record<string, unknown>;
}

export interface PlannerDecisionV2Context {
  input: PlannerInputV2;
  plan: ThetaTrainingPlan;
  proposal: PlanProposalResult;
  recommendation: RecommendationResult;
}

export const buildPlannerInputV2 = (
  context: PlannerRuntimeV2Context,
): PlannerInputV2 => {
  const constraints = context.constraints ?? {};
  return plannerInputV2Schema.parse({
    schemaVersion: '2.0.0',
    facts: context.facts,
    confirmation: context.confirmation,
    intent: context.intent,
    hardware: {
      device: hardwareDevice(constraints.device),
      ...(positiveNumber(constraints.memoryGb) === undefined
        ? {}
        : { memoryGb: positiveNumber(constraints.memoryGb) }),
      offlineOnly: constraints.offlineOnly !== false,
    },
    catalogVersion: `${context.recommendation.catalogSource}@${context.recommendation.recommendationVersion}`,
    candidates: context.recommendation.recommendations.map((candidate) => ({
      modelId: candidate.modelId,
      runnable:
        candidate.maturity !== 'unavailable' &&
        candidate.maturity !== 'incomplete',
      capabilities: candidateCapabilities(candidate.capabilityAssessment),
    })),
    evidenceRefs: unique(
      context.recommendation.recommendations.flatMap((candidate) =>
        candidate.evidenceRefs.map((evidence) => evidence.evidenceId),
      ),
    ).slice(0, 20),
    userOverrides: scalarRecord(context.userOverrides),
  });
};

export const buildPlannerDecisionV2 = (
  context: PlannerDecisionV2Context,
): PlannerDecisionV2 => {
  const selectedRecommendation = context.recommendation.recommendations.find(
    (candidate) => candidate.modelId === context.plan.modelId,
  );
  const selectedDraft = [
    context.proposal.draft.primary,
    context.proposal.draft.baseline,
    ...context.proposal.draft.alternatives,
  ].find((candidate) => candidate?.modelId === context.plan.modelId);
  const evaluation = unique(
    context.proposal.draft.evaluation.map((item) => item.choice),
  );
  const visualizations = unique(context.proposal.draft.visualizations);
  return plannerDecisionV2Schema.parse({
    schemaVersion: '2.0.0',
    inputHash: plannerInputV2Hash(context.input),
    modelId: context.plan.modelId,
    parameters: scalarRecord(context.plan),
    evaluation:
      evaluation.length > 0
        ? evaluation
        : context.input.intent.successCriteria.length > 0
          ? context.input.intent.successCriteria
          : ['人工复核主题质量与研究目标一致性'],
    visualizations:
      visualizations.length > 0 ? visualizations : ['主题分布与关键词摘要'],
    warnings: unique([
      ...context.recommendation.warnings,
      ...(selectedRecommendation?.warnings ?? []),
    ]),
    assumptions: unique(selectedDraft?.assumptions ?? []),
  });
};

const candidateCapabilities = (assessment: {
  temporalTopics: boolean;
  metadataEffects: boolean;
  shortTextOptimized: boolean;
  offlineExecution: boolean;
  cpuExecution: boolean;
  nativeOutputs: string[];
}): string[] => unique([
  ...(assessment.temporalTopics ? ['temporal_topics'] : []),
  ...(assessment.metadataEffects ? ['metadata_effects'] : []),
  ...(assessment.shortTextOptimized ? ['short_text_optimized'] : []),
  ...(assessment.offlineExecution ? ['offline_execution'] : []),
  ...(assessment.cpuExecution ? ['cpu_execution'] : []),
  ...assessment.nativeOutputs,
]);

const hardwareDevice = (value: unknown): 'cpu' | 'gpu' | 'unknown' =>
  value === 'cpu' || value === 'gpu' ? value : 'unknown';

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;

const scalarRecord = (
  value: Record<string, unknown> | undefined,
): Record<string, Scalar> => Object.fromEntries(
  Object.entries(value ?? {}).filter(
    (entry): entry is [string, Scalar] => isScalar(entry[1]),
  ),
);

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const unique = (values: readonly string[]): string[] => [...new Set(values)];
