import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResearchService } from './agent/research-service.js';
import { detectResearchGaps } from './agent/gap-rules.js';
import { ThetaNaturalLanguageService } from './language/natural-service.js';
import { guardCriticalResearchPatch } from './language/research-answer-guards.js';
import {
  NATURAL_LANGUAGE_CONTRACT_VERSION,
  type NaturalLanguageRequest,
} from './conversation/natural-contracts.js';
import { ThetaConversationWorkflowExecutor } from './conversation/workflow-executor.js';
import { buildHumanResponse } from './presentation/human-response-builder.js';
import { SQLiteConversationStore } from './storage/sqlite-conversation-store.js';

const noRun = await new ThetaConversationWorkflowExecutor().execute(
  { kind: 'status' },
  {},
);
const noRunResponse = buildHumanResponse(noRun.value);
if (
  noRunResponse.kind !== 'run.required' ||
  noRunResponse.nextActions[0]?.command !== '/start <数据文件>'
) {
  throw new Error('No-Run status did not produce executable start guidance.');
}

const consentResponse = buildHumanResponse({
  kind: 'language.consent',
  enabled: true,
  providerMode: 'minimax',
  hasActiveRun: false,
});
if (
  consentResponse.nextActions[0]?.command !== '/start <数据文件>' ||
  consentResponse.nextActions.some((item) => item.command === '/status')
) {
  throw new Error('No-Run language consent still recommended /status.');
}

const decision = {
  recommendedValue: 10,
  effectiveValue: 8,
  source: 'user_override',
};
const planResponse = buildHumanResponse({
  kind: 'plan.review',
  currentState: 'AwaitPlanCreationApproval',
  candidatePlan: {
    modelId: 'lda',
    mode: 'unsupervised',
    topicCountMode: 'fixed',
    numTopics: 8,
  },
  plannerResolution: {
    parameterDecisions: { numTopics: decision },
  },
  recommendation: {
    recommendations: [
      {
        modelId: 'lda',
        parameters: [
          {
            name: 'numTopics',
            recommended: 10,
            effectIfHigher: 'more granular topics',
            effectIfLower: 'broader topics',
          },
        ],
      },
    ],
  },
});
const planDecisionLine = (planResponse.sections ?? [])
  .find((section) => section.title === '参数采用值')
  ?.lines.join('\n') ?? '';
for (const expected of ['当前采用：8', '系统原建议：10', '调整来源：用户修改']) {
  if (!planDecisionLine.includes(expected)) {
    throw new Error(`Plan Review did not distinguish parameter decision: ${expected}`);
  }
}

const resultResponse = buildHumanResponse({
  kind: 'run.summary',
  status: 'completed',
  metrics: { num_topics: 8 },
  artifacts: [],
  topics: [],
  parameterDecisions: { numTopics: decision },
});
const resultDecisionLine = (resultResponse.sections ?? [])
  .find((section) => section.title === '本次执行参数')
  ?.lines.join('\n') ?? '';
for (const expected of ['当前采用：8', '系统原建议：10', '调整来源：用户修改']) {
  if (!resultDecisionLine.includes(expected)) {
    throw new Error(`Run summary did not retain parameter decision: ${expected}`);
  }
}

const answer = [
  '这批数据不包含个人信息、机密内容或其他敏感数据。',
  '我的研究问题是识别主要主题，并分析主题随时间的变化趋势。',
  '每一行代表一条独立的历史文本记录。',
  '正文是每条记录中的完整自然语言内容。',
  '成功标准是主题含义清晰，并提供关键词、代表文本和时间趋势。',
  '只使用 CPU，内存约 16GB。',
].join('');
const request: NaturalLanguageRequest = {
  schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
  task: 'interpret_research_answer',
  gapId: 'gap.privacy-confirmation',
  field: 'sensitiveData',
  question: '这批数据是否包含个人信息、机密内容或其他敏感数据？',
  answer,
  currentBrief: new ResearchService().createBrief({
    filePath: 'dataset.csv',
  }),
  nextGapCandidates: [],
  recentMessages: [],
};
const interpreted = await new ThetaNaturalLanguageService().generate(request);
if (interpreted.output.task !== 'interpret_research_answer') {
  throw new Error('Research answer did not return a ResearchBriefPatch.');
}
const requiredFields = [
  'sensitiveData',
  'researchQuestion',
  'analysisUnit',
  'textFieldIntent',
  'successCriteria',
  'hardwareLimit',
  'trendAnalysis',
];
for (const field of requiredFields) {
  if (!(field in interpreted.output.patch)) {
    throw new Error(`Multi-field research extraction missed ${field}.`);
  }
  if (!interpreted.output.evidenceSpans[field]?.length) {
    throw new Error(`Research extraction did not retain evidence for ${field}.`);
  }
}
const guarded = guardCriticalResearchPatch(
  request.field,
  answer,
  interpreted.output.patch,
  interpreted.output.confidenceByField,
);
if (
  guarded.patch.sensitiveData?.status !== 'no' ||
  Object.keys(guarded.patch).length < requiredFields.length
) {
  throw new Error('Multi-field patch guard rejected explicit safe fields.');
}

const unrelatedRequest: NaturalLanguageRequest = {
  ...request,
  answer: '我的研究问题是识别主要主题，并比较不同月份的变化。',
};
const unrelated = await new ThetaNaturalLanguageService().generate(
  unrelatedRequest,
);
if (
  unrelated.output.task !== 'interpret_research_answer' ||
  unrelated.output.patch.sensitiveData !== undefined ||
  !unrelated.output.unresolvedFields.includes('sensitiveData')
) {
  throw new Error('An unrelated research objective was mistaken for privacy consent.');
}

const columns = await new ThetaNaturalLanguageService().generate({
  schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
  task: 'interpret_column_confirmation',
  answer: 'text 是正文列，timestamp 是时间列，id 是 ID 列，source 作为分组元数据',
  datasetSha256: 'a'.repeat(64),
  columns: ['id', 'text', 'timestamp', 'source'],
  candidates: {
    text: ['text'],
    time: ['timestamp'],
    metadata: ['source'],
  },
  columnProfiles: [
    { name: 'id', inferredType: 'string', nonEmptySampleCount: 10, uniqueSampleCount: 10, avgLength: 8, maxLength: 8 },
    { name: 'text', inferredType: 'text', nonEmptySampleCount: 10, uniqueSampleCount: 10, avgLength: 64, maxLength: 120 },
    { name: 'timestamp', inferredType: 'datetime', nonEmptySampleCount: 10, uniqueSampleCount: 10, avgLength: 10, maxLength: 10 },
    { name: 'source', inferredType: 'string', nonEmptySampleCount: 10, uniqueSampleCount: 2, avgLength: 5, maxLength: 8 },
  ],
  recentMessages: [],
});
if (
  columns.output.task !== 'interpret_column_confirmation' ||
  columns.output.needsClarification ||
  columns.output.draft?.textColumns[0] !== 'text' ||
  columns.output.draft.timeColumn !== 'timestamp' ||
  columns.output.draft.idColumn !== 'id' ||
  columns.output.draft.groupingColumns?.[0] !== 'source'
) {
  throw new Error('A clear column assignment did not pass in one submission.');
}
const biasAnswer = '目前没有发现其他明确偏差，但样本量可能较小。';
const biasGuard = guardCriticalResearchPatch(
  'sensitiveData',
  biasAnswer,
  { sensitiveData: { status: 'no', categories: [] } },
  { sensitiveData: 0.99 },
);
if (biasGuard.patch.sensitiveData !== undefined) {
  throw new Error('A statement about missing biases was mistaken for privacy consent.');
}

const noComparisonAnswer = '不需要比较任何来源、群体或时间阶段。';
const noComparisonRequest: NaturalLanguageRequest = {
  ...request,
  gapId: 'gap.comparison-groups',
  field: 'comparisonGroups',
  question: '你希望比较哪些来源、群体或时间阶段？',
  answer: noComparisonAnswer,
};
const noComparison = await new ThetaNaturalLanguageService().generate(noComparisonRequest);
if (noComparison.output.task !== 'interpret_research_answer') {
  throw new Error('No-comparison answer did not return a research patch.');
}
const noComparisonGuard = guardCriticalResearchPatch(
  noComparisonRequest.field,
  noComparisonAnswer,
  noComparison.output.patch,
  noComparison.output.confidenceByField,
);
if (
  noComparisonGuard.patch.comparisonIntent !== 'none' ||
  noComparisonGuard.patch.comparisonGroups?.length !== 0
) {
  throw new Error('Explicit no-comparison intent was not retained by the guard.');
}
const noComparisonBrief = new ResearchService().createBrief({
  filePath: 'dataset.csv',
  research: noComparisonGuard.patch,
});
if (detectResearchGaps(noComparisonBrief).some((gap) => gap.field === 'comparisonGroups')) {
  throw new Error('Explicit no-comparison intent still produced a repeated question.');
}

const irrelevantComparison = await new ThetaNaturalLanguageService().generate({
  ...noComparisonRequest,
  answer: '今天天气很好。',
});
if (
  irrelevantComparison.output.task !== 'interpret_research_answer' ||
  irrelevantComparison.output.patch.comparisonGroups !== undefined ||
  !irrelevantComparison.output.unresolvedFields.includes('comparisonGroups')
) {
  throw new Error('An unrelated answer was accepted as comparison intent.');
}

const irrelevantGoal = await new ThetaNaturalLanguageService().generate({
  ...request,
  gapId: 'gap.research-question',
  field: 'researchQuestion',
  question: '你希望通过这批数据回答什么研究问题？',
  answer: '随便。',
});
if (
  irrelevantGoal.output.task !== 'interpret_research_answer' ||
  irrelevantGoal.output.patch.researchQuestion !== undefined ||
  !irrelevantGoal.output.unresolvedFields.includes('researchQuestion')
) {
  throw new Error('A meaningless answer was accepted as a research question.');
}

const root = mkdtempSync(path.join(tmpdir(), 'theta-conversation-ux-'));
const store = new SQLiteConversationStore(path.join(root, 'conversation.sqlite'));
try {
  store.getOrCreateSession('session.ux');
  const brief = new ResearchService().createBrief({
    filePath: 'dataset.csv',
    research: guarded.patch,
  });
  store.appendBriefRevision({
    revisionId: 'brief.ux.1',
    runId: 'run.ux',
    sessionId: 'session.ux',
    patch: guarded.patch,
    brief,
    briefHash: 'brief-hash',
    interpretationHash: interpreted.factsHash,
    fieldEvidence: Object.fromEntries(
      Object.keys(guarded.patch).map((field) => [
        field,
        {
          sourceText: answer,
          confidence: interpreted.output.task === 'interpret_research_answer'
            ? (interpreted.output.confidenceByField[field] ?? 1)
            : 1,
          evidenceSpans:
            interpreted.output.task === 'interpret_research_answer'
              ? (interpreted.output.evidenceSpans[field] ?? [answer])
              : [answer],
        },
      ]),
    ),
    createdAt: new Date().toISOString(),
  });
  const revision = store.getLatestBrief('run.ux');
  if (!revision?.fieldEvidence?.researchQuestion?.evidenceSpans.length) {
    throw new Error('Research revision did not persist field-level evidence.');
  }
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    status: 'ok',
    noRunNavigation: 'start',
    extractedFields: Object.keys(guarded.patch).length,
    privacyFalsePositive: 'blocked',
    unrelatedAnswers: 'blocked',
    noComparisonProgression: 'verified',
    parameterDecisionUx: 'verified',
    singleSubmitColumnConfirmation: 'verified',
    revisionEvidence: 'persisted',
  }),
);
