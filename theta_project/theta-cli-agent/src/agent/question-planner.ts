import type {
  DatasetProfile,
  InformationGap,
  PlannedQuestion,
} from './research-contracts.js';

export interface QuestionPlanningContext {
  currentState: string;
  askedCounts?: Readonly<Record<string, number>>;
  recentlyAskedGapId?: string;
  datasetProfile?: DatasetProfile;
}

export const planResearchQuestions = (
  gaps: readonly InformationGap[],
  context: QuestionPlanningContext,
  limit = 3,
): PlannedQuestion[] =>
  gaps
    .map((gap) => {
      const askedCount = context.askedCounts?.[gap.id] ?? 0;
      const score =
        (gap.severity === 'blocking' ? 1000 : 100) +
        gap.informationGain +
        (context.currentState === 'ResearchClarification' ? 20 : 0) -
        askedCount * 25 -
        (context.recentlyAskedGapId === gap.id ? 10 : 0);
      return {
        gapId: gap.id,
        field: gap.field,
        question: dataAwareQuestion(gap, context.datasetProfile),
        severity: gap.severity,
        score,
      };
    })
    .sort(
      (left, right) =>
        (left.severity === right.severity
          ? 0
          : left.severity === 'blocking'
            ? -1
            : 1) ||
        right.score - left.score ||
        left.gapId.localeCompare(right.gapId),
    )
    .slice(0, Math.max(1, Math.min(limit, 3)));

const dataAwareQuestion = (
  gap: InformationGap,
  profile?: DatasetProfile,
): string => {
  if (!profile) return gap.question;
  const names = (values: readonly { name: string }[]): string =>
    values
      .slice(0, 4)
      .map((item) => item.name)
      .join('、');
  switch (gap.field.split(',')[0] ?? gap.field) {
    case 'analysisUnit':
      return `系统已读取到 ${profile.rowCount} 行数据。每一行在你的研究中代表什么？`;
    case 'textFieldIntent': {
      const candidates = names(profile.columnCandidates.text);
      return candidates
        ? `系统检测到可能的正文列：${candidates}。你真正希望分析的是哪类文本内容？`
        : gap.question;
    }
    case 'timeRange': {
      const candidates = names(profile.columnCandidates.time);
      return candidates
        ? `系统检测到可能的时间列：${candidates}。你希望依据哪个时间字段或范围分析变化？`
        : gap.question;
    }
    case 'comparisonGroups': {
      const candidates = names(profile.columnCandidates.metadata);
      return candidates
        ? `系统检测到可能的分组列：${candidates}。你希望比较其中哪些来源、群体或阶段？如果不比较也可以明确说明。`
        : gap.question;
    }
    default:
      return gap.question;
  }
};
