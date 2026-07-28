import type { ResearchBrief, ResearchConflict } from './research-contracts.js';

type ConflictRule = (brief: ResearchBrief) => ResearchConflict | null;

const conflict = (
  id: string,
  severity: ResearchConflict['severity'],
  fields: string[],
  message: string,
  resolution: string,
): ResearchConflict => ({ id, severity, fields, message, resolution });

const trendWithoutTime: ConflictRule = (brief) =>
  brief.trendAnalysis &&
  !brief.timeRange &&
  brief.candidateTimeColumns.length === 0
    ? conflict(
        'conflict.trend-without-time',
        'blocking',
        ['trendAnalysis', 'timeRange', 'candidateTimeColumns'],
        'Trend analysis is requested without a time range or time column.',
        'Provide a time range or identify a time column.',
      )
    : null;

const comparisonWithoutGroup: ConflictRule = (brief) =>
  brief.comparisonGroups.length > 0 &&
  brief.candidateGroupColumns.length === 0
    ? conflict(
        'conflict.comparison-without-group-column',
        'blocking',
        ['comparisonGroups', 'candidateGroupColumns'],
        'Group comparison is requested without a candidate group column.',
        'Identify the dataset column that assigns rows to comparison groups.',
      )
    : null;

const fineTopicsWithSmallSample: ConflictRule = (brief) =>
  brief.topicGranularity === 'fine' &&
  brief.expectedRowCount !== undefined &&
  brief.expectedRowCount < 100
    ? conflict(
        'conflict.fine-topics-small-sample',
        'warning',
        ['topicGranularity', 'expectedRowCount'],
        'Fine-grained topics were requested for a very small sample.',
        'Use broader topics or provide more rows.',
      )
    : null;

const offlineRemoteEmbedding: ConflictRule = (brief) =>
  brief.offlineOnly && brief.requestedEmbedding === 'remote'
    ? conflict(
        'conflict.offline-remote-embedding',
        'blocking',
        ['offlineOnly', 'requestedEmbedding'],
        'A remote embedding provider conflicts with the offline-only constraint.',
        'Select a local embedding provider or relax the offline-only constraint.',
      )
    : null;

const cpuLargeModel: ConflictRule = (brief) =>
  brief.hardwareLimit.device === 'cpu' &&
  brief.topicGranularity === 'fine' &&
  (brief.expectedRowCount ?? 0) > 100_000
    ? conflict(
        'conflict.cpu-large-workload',
        'warning',
        ['hardwareLimit', 'topicGranularity', 'expectedRowCount'],
        'A large fine-grained workload is unlikely to finish efficiently on CPU only.',
        'Reduce granularity, sample the dataset, or provide a GPU.',
      )
    : null;

const shortDeadlineLargeWorkload: ConflictRule = (brief) =>
  brief.timeLimitHours !== undefined &&
  brief.timeLimitHours < 1 &&
  (brief.expectedRowCount ?? 0) > 100_000
    ? conflict(
        'conflict.short-deadline-large-workload',
        'warning',
        ['timeLimitHours', 'expectedRowCount'],
        'The requested time limit is too short for the expected dataset size.',
        'Increase the time limit or reduce the dataset before training.',
      )
    : null;

export const researchConflictRules: readonly ConflictRule[] = [
  trendWithoutTime,
  comparisonWithoutGroup,
  fineTopicsWithSmallSample,
  offlineRemoteEmbedding,
  cpuLargeModel,
  shortDeadlineLargeWorkload,
];

export const detectResearchConflicts = (
  brief: ResearchBrief,
): ResearchConflict[] =>
  researchConflictRules
    .map((rule) => rule(brief))
    .filter((value): value is ResearchConflict => value !== null);
