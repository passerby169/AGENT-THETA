import type { CandidatePlanPresentation } from '../planner-v3/candidate-presenter.js';

export const renderValue = (value: unknown): string => JSON.stringify(value, null, 2);

export const renderUserError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `操作未完成\n${message}\n请运行 theta status --run-id <id> 查看当前 V6 状态。`;
};

export const renderActivityLine = (activity: {
  status: string;
  userMessage: string;
  progress: { completedGates: number; totalGates: number; percent: number; label: string };
}): string => {
  const marker = activity.status === 'completed' ? '✓' : activity.status === 'failed' ? '✗' : '→';
  return `${marker} ${activity.userMessage}\n  ${activity.progress.label}：${activity.progress.completedGates}/${activity.progress.totalGates}（${activity.progress.percent}%）`;
};

export const renderPlanPresentation = (presentation: CandidatePlanPresentation): string => [
  presentation.title,
  presentation.summary,
  '',
  ...presentation.sections.flatMap((section) => [section.title, `  ${section.content}`, '']),
  ...(presentation.warnings.length
    ? ['需要留意', ...presentation.warnings.map((warning) => `  - ${warning}`), '']
    : []),
  '下一步',
  '  → 直接用自然语言询问或修改这份方案',
  '  → 确认无误后明确回复“我确认当前计划”',
].join('\n').trim();
