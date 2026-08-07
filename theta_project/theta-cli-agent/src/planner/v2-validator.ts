import {
  plannerDecisionV2Schema,
  plannerInputV2Hash,
  plannerInputV2Schema,
  plannerValidationResultV2Schema,
  type PlannerDecisionV2,
  type PlannerInputV2,
  type PlannerValidationResultV2,
} from './v2-contracts.js';

export const validatePlannerDecisionV2 = (
  rawInput: PlannerInputV2,
  rawDecision: PlannerDecisionV2,
): PlannerValidationResultV2 => {
  const input = plannerInputV2Schema.parse(rawInput);
  const decision = plannerDecisionV2Schema.parse(rawDecision);
  const errors: string[] = [];
  const warnings: string[] = [...decision.warnings];
  if (decision.inputHash !== plannerInputV2Hash(input)) {
    errors.push('计划使用的输入快照已经变化，必须重新生成并重新审批。');
  }
  if (input.facts.datasetHash !== input.confirmation.datasetHash) {
    errors.push('数据事实与用户确认指向不同的数据版本。');
  }
  const columnNames = new Set(input.facts.columns.map((item) => item.name));
  for (const column of input.confirmation.textColumns) {
    if (!columnNames.has(column)) errors.push(`正文列不存在：${column}`);
  }
  for (const column of input.confirmation.timeColumns) {
    if (!columnNames.has(column)) errors.push(`时间列不存在：${column}`);
  }
  const candidate = input.candidates.find((item) => item.modelId === decision.modelId);
  if (!candidate) errors.push(`模型不在当前候选目录中：${decision.modelId}`);
  else {
    if (!candidate.runnable) errors.push(`模型当前不可运行：${decision.modelId}`);
    if (input.intent.temporalAnalysis && !candidate.capabilities.includes('temporal_topics')) {
      errors.push('研究要求时间趋势，但所选模型不支持 temporal_topics。');
    }
    if (candidate.estimatedMemoryGb && input.hardware.memoryGb && candidate.estimatedMemoryGb > input.hardware.memoryGb) {
      errors.push(`模型预计需要 ${candidate.estimatedMemoryGb}GB 内存，超过可用 ${input.hardware.memoryGb}GB。`);
    }
  }
  if (input.intent.temporalAnalysis && input.confirmation.timeColumns.length === 0) {
    errors.push('研究要求时间趋势，但没有确认可用的时间列。');
  }
  if (input.facts.rowCount < 100) warnings.push('样本量较小，结果应作为探索性结论并进行人工复核。');
  return plannerValidationResultV2Schema.parse({ valid: errors.length === 0, errors, warnings: [...new Set(warnings)] });
};
