import type { DatasetWorkspace, ResearchWorkspace } from '../workspaces/contracts.js';
import type { CandidatePlan, PlanValidationReceipt } from './contracts.js';

export interface CandidatePlanPresentation {
  schemaVersion: '3.0.0';
  candidateRef: string;
  candidatePlanHash: string;
  title: string;
  summary: string;
  sections: Array<{ title: string; content: string }>;
  warnings: string[];
  plan: {
    model: {
      modelId: string;
      mode: string;
      rationale: string;
      parameters: Record<string, string | number | boolean | null>;
    };
    seed: number;
    evidenceIds: string[];
    assumptions: string[];
    validation: { valid: boolean; receiptHash: string; issues: PlanValidationReceipt['issues'] };
  };
}

export const presentCandidatePlan = (
  candidate: CandidatePlan,
  validation: PlanValidationReceipt,
  _context: { dataset?: DatasetWorkspace; research?: ResearchWorkspace } = {},
): CandidatePlanPresentation => {
  const warnings = unique([
    ...candidate.warnings,
    ...validation.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
  ]);
  const seed = candidate.experimentProtocol.seeds[0];
  return {
    schemaVersion: '3.0.0',
    candidateRef: candidate.candidateRef,
    candidatePlanHash: candidate.candidatePlanHash,
    title: `训练方案：${candidate.model.modelId}`,
    summary: `使用 ${candidate.model.modelId}（${candidate.model.mode}），随机种子 ${seed}，执行 1 次训练。`,
    sections: [
      { title: '模型', content: `${candidate.model.modelId} / ${candidate.model.mode}` },
      { title: '超参数', content: entries(candidate.model.parameters) },
      { title: '随机种子', content: String(seed) },
      { title: '选择理由', content: `${candidate.model.rationale} ${candidate.rationale}`.trim() },
      { title: '依据', content: candidate.evidenceRefs.join('、') || '仅依据已审计的本地模型能力契约' },
      { title: '自动执行说明', content: '数据列继承已确认的数据理解；预处理、评估指标、质量检查和全部可视化由 Python 训练管线自动执行，不属于本计划的选择项。' },
      { title: '校验', content: `Validator：${validation.valid ? '通过' : '未通过'}；收据：${validation.validationReceiptHash}` },
      ...(warnings.length > 0 ? [{ title: '限制', content: warnings.join('；') }] : []),
    ],
    warnings,
    plan: {
      model: {
        modelId: candidate.model.modelId,
        mode: candidate.model.mode,
        rationale: candidate.model.rationale,
        parameters: candidate.model.parameters,
      },
      seed,
      evidenceIds: candidate.evidenceRefs,
      assumptions: candidate.assumptions,
      validation: { valid: validation.valid, receiptHash: validation.validationReceiptHash, issues: validation.issues },
    },
  };
};

const entries = (values: CandidatePlan['model']['parameters']): string => {
  const rendered = Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
  return rendered.length ? rendered.join('，') : '使用该模型能力契约中的默认超参数。';
};

const unique = (values: string[]): string[] => [...new Set(values)];
