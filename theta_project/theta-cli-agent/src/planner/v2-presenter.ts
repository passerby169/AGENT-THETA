import type { PlannerDecisionV2, PlannerInputV2, PlannerValidationResultV2 } from './v2-contracts.js';

export interface PresentedPlanV2 {
  title: string;
  summary: string;
  model: string;
  dataBasis: string[];
  outputs: string[];
  cautions: string[];
  approvalRequired: boolean;
}

export const presentPlanV2 = (
  input: PlannerInputV2,
  decision: PlannerDecisionV2,
  validation: PlannerValidationResultV2,
): PresentedPlanV2 => ({
  title: validation.valid ? '候选分析方案已通过规则校验' : '候选分析方案需要修正',
  summary: validation.valid
    ? `系统建议使用 ${decision.modelId} 分析 ${input.confirmation.textColumns.join('、')}，计划不会在你批准前启动训练。`
    : `当前方案有 ${validation.errors.length} 项必须修正的问题，尚不能进入审批。`,
  model: decision.modelId,
  dataBasis: [
    `${input.facts.rowCount} 行、${input.facts.columns.length} 列`,
    `正文列：${input.confirmation.textColumns.join('、')}`,
    input.intent.temporalAnalysis
      ? `时间分析：${input.confirmation.timeColumns.join('、') || '缺少时间列'}`
      : '时间分析：本轮不作为硬性要求',
  ],
  outputs: [...decision.evaluation, ...decision.visualizations],
  cautions: validation.valid ? validation.warnings : [...validation.errors, ...validation.warnings],
  approvalRequired: validation.valid,
});
