import type { PlanProposalResult } from './contracts.js';
import type {
  PlannerDecisionV2,
  PlannerInputV2,
  PlannerValidationResultV2,
} from './v2-contracts.js';

type Scalar = string | number | boolean | null;

export interface PresentedPlanParameterV2 {
  field: string;
  value: Scalar;
  rationale: string;
  source: 'user_override' | 'planner_recommendation' | 'validated_default';
}

export interface PresentedPlanModelV2 {
  modelId: string;
  rationale: string;
}

export interface PresentedPlanV2 {
  title: string;
  summary: string;
  researchGoal: string;
  model: string;
  primaryModel: PresentedPlanModelV2;
  baselineModel: PresentedPlanModelV2 | null;
  dataBasis: string[];
  keyParameters: PresentedPlanParameterV2[];
  experiment: {
    mode: 'quick' | 'comparative' | 'stability';
    primarySeeds: number[];
    baselineSeeds: number[];
    rationale: string;
  } | null;
  preprocessing: Array<{ choice: string; rationale: string }>;
  evaluation: string[];
  visualizations: string[];
  outputs: string[];
  cautions: string[];
  assumptions: string[];
  openQuestions: string[];
  plannerSource: 'minimax' | 'deterministic' | 'unknown';
  approvalRequired: boolean;
}

export interface PresentPlanV2Details {
  proposal?: PlanProposalResult;
}

export const presentPlanV2 = (
  input: PlannerInputV2,
  decision: PlannerDecisionV2,
  validation: PlannerValidationResultV2,
  details: PresentPlanV2Details = {},
): PresentedPlanV2 => {
  const proposal = details.proposal;
  const selected = proposal
    ? [proposal.draft.primary, proposal.draft.baseline, ...proposal.draft.alternatives]
        .find((candidate) => candidate?.modelId === decision.modelId)
    : undefined;
  const primary = proposal?.draft.primary;
  const baseline = proposal?.draft.baseline;
  const parameterRationales = new Map(
    (selected?.parameterCandidates ?? primary?.parameterCandidates ?? [])
      .map((parameter) => [parameter.field, parameter.rationale]),
  );
  const keyParameters = Object.entries(decision.parameters)
    .filter(([field]) => field !== 'modelId')
    .slice(0, 16)
    .map(([field, value]) => ({
      field,
      value,
      rationale: parameterRationales.get(field)
        ?? '该值已经通过模型参数 Schema 与执行 Validator 校验。',
      source: Object.prototype.hasOwnProperty.call(input.userOverrides, field)
        ? 'user_override' as const
        : parameterRationales.has(field)
          ? 'planner_recommendation' as const
          : 'validated_default' as const,
    }));
  const validationCautions = validation.valid
    ? validation.warnings
    : [...validation.errors, ...validation.warnings];
  const cautions = unique([
    ...validationCautions,
    ...decision.warnings,
    ...(selected?.risks ?? []),
  ]);
  const assumptions = unique([
    ...decision.assumptions,
    ...(selected?.assumptions ?? []),
  ]);

  return {
    title: validation.valid ? '候选分析方案已通过规则校验' : '候选分析方案需要修正',
    summary: validation.valid
      ? proposal?.draft.summary
        ?? `系统建议使用 ${decision.modelId}；在你批准前不会启动训练。`
      : `当前方案有 ${validation.errors.length} 项必须修正的问题，尚不能进入审批。`,
    researchGoal: input.intent.researchQuestion,
    model: decision.modelId,
    primaryModel: {
      modelId: decision.modelId,
      rationale: selected?.choice
        ?? primary?.choice
        ?? '该模型来自受能力目录约束的候选集合，并已通过执行校验。',
    },
    baselineModel: baseline
      ? { modelId: baseline.modelId, rationale: baseline.choice }
      : null,
    dataBasis: [
      `${input.facts.rowCount} 行、${input.facts.columns.length} 列`,
      `正文列：${input.confirmation.textColumns.join('、')}`,
      input.intent.temporalAnalysis
        ? `时间分析：${input.confirmation.timeColumns.join('、') || '缺少时间列'}`
        : '时间分析：本轮不作为硬性要求',
      input.confirmation.metadataColumns.length > 0
        ? `分组与描述字段：${input.confirmation.metadataColumns.join('、')}`
        : '分组与描述字段：本轮未使用',
    ],
    keyParameters,
    experiment: proposal
      ? {
          mode: proposal.draft.experimentProtocol.mode,
          primarySeeds: proposal.draft.experimentProtocol.primarySeeds,
          baselineSeeds: proposal.draft.experimentProtocol.baselineSeeds,
          rationale: proposal.draft.experimentProtocol.rationale,
        }
      : null,
    preprocessing: (proposal?.draft.preprocessing ?? []).map((item) => ({
      choice: item.choice,
      rationale: explanation(item.assumptions, item.risks),
    })),
    evaluation: [...decision.evaluation],
    visualizations: [...decision.visualizations],
    outputs: [...decision.evaluation, ...decision.visualizations],
    cautions,
    assumptions,
    openQuestions: unique(proposal?.draft.openQuestions ?? []),
    plannerSource: proposal?.source ?? 'unknown',
    approvalRequired: validation.valid,
  };
};

const explanation = (assumptions: readonly string[], risks: readonly string[]): string =>
  [...assumptions, ...risks].join('；') || '该步骤已通过本地执行边界与方案校验。';

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))];
