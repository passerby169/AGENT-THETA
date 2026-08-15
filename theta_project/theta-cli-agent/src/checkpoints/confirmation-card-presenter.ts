import type { ConfirmationCardView, ConversationalCheckpoint } from './contracts.js';
import type { CandidatePlanPresentation } from '../planner-v3/candidate-presenter.js';

export const presentConfirmationCard = (
  checkpoint: ConversationalCheckpoint,
): ConfirmationCardView => {
  const base = {
    kind: checkpoint.kind as ConfirmationCardView['kind'],
    checkpointId: checkpoint.checkpointId,
    contentHash: checkpoint.contentHash,
    targetHash: checkpoint.targetHash,
    revision: checkpoint.revision,
    status: checkpoint.status,
    warnings: unique(checkpoint.warnings),
    actions: [
      { id: 'approve', label: '是，进入下一阶段' },
      { id: 'revise', label: '否，说明原因' },
    ] as ConfirmationCardView['actions'],
  };
  if (checkpoint.kind === 'dataset') {
    const content = object(checkpoint.content);
    const roles = array(content.columnRoles).map(object);
    return {
      ...base,
      kind: 'dataset',
      title: '数据理解确认',
      summary: checkpoint.summaryForUser,
      sections: roles.length === 0 ? [] : [{
        id: 'column_roles',
        title: '列角色建议',
        content: roles.map((role) => `${text(role.column, '未知列')}：${text(role.proposedRole, '待判断')}（置信度 ${numberText(role.confidence)}）`),
      }],
    };
  }
  if (checkpoint.kind === 'research') {
    const content = object(checkpoint.content);
    const sections = [
      listSection('research_focus', '研究重点', array(content.statements).map((item) => text(object(item).statement)).filter(Boolean)),
      listSection('decisions', '已确认决定', array(content.decisions).map((item) => text(object(item).decision)).filter(Boolean)),
      listSection('preferences', '分析偏好', array(content.preferences).map((item) => text(object(item).preference)).filter(Boolean)),
      listSection('boundaries', '范围与约束', array(content.boundaries).map((item) => text(object(item).boundary)).filter(Boolean)),
      listSection('assumptions', '当前假设', array(content.assumptions).map((item) => text(object(item).statement)).filter(Boolean)),
    ].filter((section): section is NonNullable<typeof section> => section !== undefined);
    return {
      ...base,
      kind: 'research',
      title: '研究意图确认',
      summary: checkpoint.summaryForUser,
      sections,
    };
  }
  if (checkpoint.kind === 'plan') {
    const presentation = object(object(checkpoint.content).presentation) as unknown as CandidatePlanPresentation;
    return {
      ...base,
      kind: 'plan',
      title: '训练计划确认',
      summary: typeof presentation.summary === 'string' ? presentation.summary : checkpoint.summaryForUser,
      sections: Array.isArray(presentation.sections)
        ? presentation.sections.map((section, index) => ({
            id: `plan_${index + 1}`,
            title: section.title,
            content: section.content,
          }))
        : [],
    };
  }
  return {
    ...base,
    kind: 'training',
    title: '训练启动确认',
    summary: checkpoint.summaryForUser,
    sections: [],
    actions: [],
  };
};

const listSection = (id: string, title: string, values: string[]) => values.length === 0
  ? undefined
  : { id, title, content: unique(values) };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const numberText = (value: unknown): string => typeof value === 'number' && Number.isFinite(value)
  ? value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')
  : '未知';

const unique = (values: string[]): string[] => [...new Set(values.map((item) => item.trim()).filter(Boolean))];
