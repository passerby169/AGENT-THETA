import assert from 'node:assert/strict';
import {
  DEFAULT_NEW_WORKFLOW_VERSION,
  evaluateGoldenTranscripts,
  goldenTranscriptSchema,
  resolveWorkflowVersion,
  type GoldenTranscript,
  type WorkflowMetricsV2,
} from './acceptance/v2-acceptance.js';

const scenarios = [
  scenario('news-quarterly-trends', '新闻数据：行业比较和季度趋势', {
    domain: '行业新闻', columns: ['text', 'published_at', 'industry'], modelId: 'dtm',
    question: '需要按行业比较季度主题变化吗？', revision: '启用行业比较与季度时间趋势。',
  }),
  scenario('product-review-issues', '商品评论：产品问题和情感相关主题', {
    domain: '商品评论', columns: ['review_text', 'rating', 'product'], modelId: 'stm',
    question: '评分是否只用于评价主题与情感的关系？', revision: '将评分作为评价字段，不泄漏到主题训练。',
  }),
  scenario('service-complaints', '客服对话：投诉原因和服务改进', {
    domain: '客服对话', columns: ['dialogue', 'channel', 'created_at'], modelId: 'bertopic',
    question: '是否按渠道比较投诉原因？', revision: '按渠道比较并输出服务改进建议。',
  }),
  scenario('academic-abstracts', '学术摘要：研究方向聚类', {
    domain: '学术摘要', columns: ['title', 'abstract', 'year'], modelId: 'bertopic',
    question: '你更关心细分研究方向还是宽泛学科？', revision: '采用细粒度语义聚类。',
  }),
  scenario('company-notices', '企业公告：时间演变和公司差异', {
    domain: '企业公告', columns: ['notice', 'company', 'date'], modelId: 'dtm',
    question: '是否同时比较公司差异和时间演变？', revision: '公司作为分组维度，日期用于时间演变。',
  }),
  scenario('single-column-txt', '单列 TXT：没有时间和分组字段', {
    domain: '单列文本', columns: ['text'], format: 'txt', modelId: 'btm',
    question: '当前没有时间和分组列，是否接受只做静态主题分析？', revision: '接受静态主题分析。',
    answerMode: 'default', acceptedDefaultCount: 1,
  }),
  scenario('ambiguous-text-columns', '正文列模糊：title 与 body 同时存在', {
    domain: '内容文章', columns: ['title', 'body', 'published_at'], modelId: 'lda',
    question: '我建议合并标题与正文作为分析文本，是否符合你的目标？', revision: '确认标题与正文联合分析。',
  }),
  scenario('held-out-labels', '已有标签：标签只用于评价', {
    domain: '标注语料', columns: ['text', 'label', 'split'], modelId: 'lda',
    question: '标签是否只用于训练后评价？', revision: '标签保持为留出评价字段。',
  }),
  scenario('unknown-and-defaults', '用户回答“不知道”和“按你建议”', {
    domain: '通用文本', columns: ['text', 'source'], modelId: 'hdp',
    question: '主题数量没有先验时，是否采用自动探索方案？', revision: '采用系统默认的自动主题数探索。',
    answerMode: 'unknown', acceptedDefaultCount: 1,
  }),
  scenario('user-correction', '用户纠正 Agent 数据理解', {
    domain: '社交反馈', columns: ['message', 'created_at', 'community'], modelId: 'stm',
    question: '我判断它属于社区运营反馈，这个方向准确吗？', revision: '用户将领域纠正为公共服务反馈。',
    confirmationStatus: 'corrected', userDatasetCorrectionCount: 1,
  }),
].map((value) => goldenTranscriptSchema.parse(value));

assert.equal(new Set(scenarios.map((item) => item.scenarioId)).size, 10);
assert.ok(scenarios.some((item) => item.userConfirmation.status === 'corrected'));
assert.ok(scenarios.some((item) => item.turns.some((turn) => turn.answerMode === 'unknown')));
assert.ok(scenarios.some((item) => item.turns.some((turn) => turn.answerMode === 'default')));
assert.ok(scenarios.every((item) => !containsRawDatasetPayload(item)));

const acceptance = evaluateGoldenTranscripts(scenarios);
assert.equal(acceptance.passed, true);
assert.equal(acceptance.scenarioCount, 10);
assert.ok(acceptance.automaticTextSelectionRate > 0.9);
assert.ok(acceptance.medianGrillingTurns <= 4);
assert.equal(acceptance.repeatedQuestionRate, 0);
assert.equal(acceptance.invalidEvidenceCount, 0);

assert.equal(
  resolveWorkflowVersion({ isNewRun: true }),
  DEFAULT_NEW_WORKFLOW_VERSION,
);
assert.equal(
  resolveWorkflowVersion({ isNewRun: false }),
  '1.0.0',
);
assert.equal(
  resolveWorkflowVersion({ isNewRun: false, storedVersion: '2.0.0' }),
  '2.0.0',
);
assert.equal(
  resolveWorkflowVersion({ isNewRun: true, requestedVersion: '1.0.0' }),
  '1.0.0',
);

console.log(JSON.stringify({
  status: 'ok',
  ...acceptance,
  newRunDefault: DEFAULT_NEW_WORKFLOW_VERSION,
  legacyUnversionedRun: '1.0.0',
  rawDatasetPayloadsPersisted: 0,
}));

interface ScenarioOptions {
  domain: string;
  columns: string[];
  format?: 'csv' | 'txt';
  modelId: string;
  question: string;
  revision: string;
  answerMode?: 'explicit' | 'unknown' | 'default';
  confirmationStatus?: 'confirmed' | 'corrected';
  acceptedDefaultCount?: number;
  userDatasetCorrectionCount?: number;
}

function scenario(
  scenarioId: string,
  title: string,
  options: ScenarioOptions,
): GoldenTranscript {
  const metrics: WorkflowMetricsV2 = {
    schemaVersion: '2.0.0',
    workflowVersion: '2.0.0',
    datasetInspectionDurationMs: 120,
    datasetExploreToolCalls: 1,
    datasetUnderstandingDurationMs: 180,
    datasetUnderstandingSource: 'hybrid',
    datasetUnderstandingValidationFailures: 0,
    minimaxFallbackCount: 0,
    userDatasetCorrectionCount: options.userDatasetCorrectionCount ?? 0,
    textColumnCorrectionCount: 0,
    grillingTurnCount: 1,
    repeatedQuestionBlockCount: 0,
    acceptedDefaultCount: options.acceptedDefaultCount ?? 0,
    plannerDurationMs: 160,
    plannerRepairCount: 0,
    plannerFallbackCount: 0,
    planAdjustmentCount: 0,
    timeToTrainingApprovalMs: 1200,
  };
  return {
    schemaVersion: '2.0.0',
    scenarioId,
    title,
    dataset: {
      format: options.format ?? 'csv',
      rowCount: 240,
      columns: options.columns,
      inferredDomain: options.domain,
    },
    toolCalls: ['theta.dataset.explore'],
    factsDigest: `${options.columns.length} 列、240 条记录，结构检查完成。`,
    initialUnderstanding: `初步识别为${options.domain}，已生成列角色建议。`,
    userConfirmation: {
      status: options.confirmationStatus ?? 'confirmed',
      summary: options.confirmationStatus === 'corrected'
        ? options.revision
        : '确认数据理解与列角色。',
    },
    turns: [{
      gapId: `${scenarioId}.decision`,
      question: options.question,
      answerMode: options.answerMode ?? 'explicit',
      informationGain: 80,
    }],
    researchIntentRevisions: [options.revision],
    finalPlan: {
      modelId: options.modelId,
      parameters: { numTopics: 7, device: 'cpu' },
      evaluation: ['topic_coherence', 'representative_text_review'],
      visualizations: ['topic_distribution', 'topic_keywords'],
    },
    validatorReceipt: {
      valid: true,
      evidenceRefsValid: true,
      columnRolesValid: true,
    },
    ux: {
      automaticTextSelection: true,
      naturalQuestions: true,
      noMeaninglessQuestions: true,
      clearNextStep: true,
      progressVisible: true,
    },
    metrics,
  };
}

function containsRawDatasetPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRawDatasetPayload);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      ['rawRows', 'sampleRows', 'datasetContent', 'providerPayload'].includes(key) ||
      containsRawDatasetPayload(nested),
  );
}
