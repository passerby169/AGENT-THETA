import type { InformationGap, ResearchBrief } from './research-contracts.js';

type GapRule = (brief: ResearchBrief) => InformationGap | null;

const gap = (
  id: string,
  field: string,
  severity: InformationGap['severity'],
  question: string,
  reason: string,
  informationGain: number,
): InformationGap => ({
  id,
  field,
  severity,
  question,
  reason,
  informationGain,
});

export const detectResearchQuestionGap: GapRule = (brief) =>
  brief.researchQuestion
    ? null
    : gap(
        'gap.research-question',
        'researchQuestion',
        'blocking',
        'What research question should this training run answer?',
        'A model recommendation cannot be evaluated without a research question.',
        100,
      );

export const detectDataSourceGap: GapRule = (brief) =>
  brief.dataSources.length > 0
    ? null
    : gap(
        'gap.data-source',
        'dataSources',
        'blocking',
        'Which local dataset is the source of this analysis?',
        'Dataset provenance is required before inspection.',
        100,
      );

export const detectAnalysisUnitGap: GapRule = (brief) =>
  brief.analysisUnit
    ? null
    : gap(
        'gap.analysis-unit',
        'analysisUnit',
        'blocking',
        'What does one row represent in the dataset?',
        'The analysis unit controls interpretation of rows and model output.',
        90,
      );

export const detectTextFieldIntentGap: GapRule = (brief) =>
  brief.textFieldIntent
    ? null
    : gap(
        'gap.text-field-intent',
        'textFieldIntent',
        'blocking',
        'Which kind of text should be analyzed?',
        'Automatic column detection must not silently define business intent.',
        95,
      );

export const detectTrendTimeGap: GapRule = (brief) =>
  brief.trendAnalysis &&
  !brief.timeRange &&
  brief.candidateTimeColumns.length === 0
    ? gap(
        'gap.trend-time',
        'timeRange',
        'blocking',
        'Trend analysis is requested. What time range or time field should be used?',
        'Trend analysis requires an explicit temporal basis.',
        100,
      )
    : null;

export const detectPrivacyConfirmationGap: GapRule = (brief) =>
  brief.sensitiveData.status === 'unknown'
    ? gap(
        'gap.privacy-confirmation',
        'sensitiveData',
        'blocking',
        'Does the dataset contain personal, confidential, or otherwise sensitive data?',
        'Sensitive-data handling must be confirmed before samples are inspected.',
        100,
      )
    : null;

export const detectSuccessCriteriaGap: GapRule = (brief) =>
  brief.successCriteria.length > 0
    ? null
    : gap(
        'gap.success-criteria',
        'successCriteria',
        'optional',
        'How will you decide whether the analysis is successful?',
        'Explicit success criteria improve deterministic recommendation ranking.',
        70,
      );

export const detectHardwareLimitGap: GapRule = (brief) =>
  brief.hardwareLimit.device !== 'unknown'
    ? null
    : gap(
        'gap.hardware-limit',
        'hardwareLimit',
        'optional',
        'Will this run use CPU only or is a GPU available?',
        'Hardware constraints remove recommendations that cannot run locally.',
        65,
      );

export const researchGapRules: readonly GapRule[] = [
  detectResearchQuestionGap,
  detectDataSourceGap,
  detectAnalysisUnitGap,
  detectTextFieldIntentGap,
  detectTrendTimeGap,
  detectPrivacyConfirmationGap,
  detectSuccessCriteriaGap,
  detectHardwareLimitGap,
];

export const detectResearchGaps = (
  brief: ResearchBrief,
): InformationGap[] =>
  researchGapRules
    .map((rule) => rule(brief))
    .filter((value): value is InformationGap => value !== null);
