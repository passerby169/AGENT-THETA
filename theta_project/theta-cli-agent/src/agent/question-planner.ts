import type {
  InformationGap,
  PlannedQuestion,
} from './research-contracts.js';

export interface QuestionPlanningContext {
  currentState: string;
  askedCounts?: Readonly<Record<string, number>>;
  recentlyAskedGapId?: string;
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
        (gap.severity === 'blocking' ? 100 : 30) +
        gap.informationGain +
        (context.currentState === 'ResearchClarification' ? 20 : 0) -
        askedCount * 15 -
        (context.recentlyAskedGapId === gap.id ? 10 : 0);
      return {
        gapId: gap.id,
        field: gap.field,
        question: gap.question,
        severity: gap.severity,
        score,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.gapId.localeCompare(right.gapId),
    )
    .slice(0, Math.max(1, Math.min(limit, 3)));
