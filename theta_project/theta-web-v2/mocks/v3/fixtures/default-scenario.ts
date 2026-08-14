import type {
  ConversationMessage,
  ConversationalCheckpointView,
  DatasetCatalogItem,
  PlanCandidateView,
  ProductRunEvent,
  ResearchWorkspaceSummary,
  ResultArtifactSummary,
  TrainingView,
  FailureDescriptor,
  ThetaRunViewV3,
} from '../../../lib/api/v3/contracts.generated';

const now = '2026-08-13T10:00:00.000Z';

export const mockDatasets: DatasetCatalogItem[] = [
  {
    datasetRef: 'dataset_mock_courses',
    fileName: 'course-reviews.csv',
    sizeBytes: 684_320,
    suffix: '.csv',
    createdAt: now,
    source: 'local',
    availability: 'ready',
    rowCount: 1280,
    columnCount: 8,
    languageSummary: '以中文为主',
  },
  {
    datasetRef: 'dataset_mock_news_remote',
    fileName: 'news-corpus.parquet',
    sizeBytes: 48_234_112,
    suffix: '.parquet',
    createdAt: '2026-08-12T08:30:00.000Z',
    source: 'remote',
    availability: 'remote_sample_authorization_required',
    rowCount: 24_600,
    columnCount: 12,
    languageSummary: '中文与英文混合',
  },
];

export const defaultRunView: ThetaRunViewV3 = {
  runId: 'run_mock_dataset_checkpoint',
  revision: 4,
  createdAt: now,
  updatedAt: now,
  lifecycle: 'waiting_user',
  phase: 'dataset_understanding',
  activity: { kind: 'waiting_user', label: '等待确认数据理解' },
  interaction: {
    kind: 'checkpoint',
    prompt: '请确认 Agent 对数据集的理解，或直接说明需要修改的内容。',
    checkpointId: 'checkpoint_dataset_1',
    expectsUserInput: true,
  },
  progress: {
    scope: 'phase',
    stageId: 'dataset_checkpoint',
    label: '数据理解',
    percent: null,
    indeterminate: true,
  },
  checkpoint: {
    checkpointId: 'checkpoint_dataset_1',
    kind: 'dataset',
    revision: 1,
    contentHash: 'sha256:dataset-checkpoint-v1',
    mandatory: false,
    status: 'proposed',
    requestedBy: 'minimax',
    title: '数据理解确认',
    summary: '数据包含课程评价文本，主要分析单位为单条评价。',
    sections: [
      {
        id: 'dataset-facts',
        title: '数据概况',
        kind: 'facts',
        content: { rows: 1280, columns: 8, primaryTextColumn: 'review_text' },
      },
    ],
    assumptions: ['review_text 是主要分析文本。'],
    warnings: ['约 3% 的文本为空。'],
    allowedActions: ['ask', 'revise', 'confirm', 'reject'],
    createdAt: now,
  },
  dataset: {
    datasetRef: 'dataset_mock_courses',
    datasetHash: 'sha256:dataset-mock-courses',
    fileName: 'course-reviews.csv',
    rowCount: 1280,
    columnCount: 8,
    languageSummary: '以中文为主',
    qualityWarnings: ['约 3% 的文本为空。'],
    assumptions: ['review_text 是主要分析文本。'],
  },
  capabilities: {
    canSendMessage: true,
    canConfirmCheckpoint: true,
    canRejectCheckpoint: true,
    canApprovePlan: false,
    canApproveTraining: false,
    canCancelAgentWork: false,
    canCancelTraining: false,
    canRetry: false,
    canResume: false,
    canDeleteRun: true,
    canViewTechnicalEvents: true,
  },
  links: {
    messages: '/api/v3/runs/run_mock_dataset_checkpoint/messages',
    events: '/api/v3/runs/run_mock_dataset_checkpoint/events/stream',
    timeline: '/api/v3/runs/run_mock_dataset_checkpoint/timeline',
    checkpoint: '/api/v3/runs/run_mock_dataset_checkpoint/checkpoints/current',
  },
};

export const defaultMessages: ConversationMessage[] = [
  {
    messageId: 'message_1',
    sequence: 1,
    role: 'assistant',
    kind: 'checkpoint_proposed',
    content: defaultRunView.checkpoint?.summary ?? '',
    createdAt: now,
    status: 'completed',
    checkpointId: defaultRunView.checkpoint?.checkpointId,
  },
];

export const createRemoteDatasetRunView = (): ThetaRunViewV3 => ({
  ...structuredClone(defaultRunView),
  runId: 'run_mock_dataset_skipped',
  revision: 1,
  lifecycle: 'active',
  phase: 'research_dialogue',
  activity: {
    kind: 'waiting_user',
    label: '等待研究方向',
    detail: '数据字段和质量信号明确，Agent 已跳过数据确认。',
  },
  interaction: {
    kind: 'conversation',
    prompt: '可以直接描述你的研究目标，或让 Agent 自主提出研究问题。',
    expectsUserInput: true,
  },
  progress: {
    scope: 'phase',
    stageId: 'research_dialogue',
    label: '研究对话',
    detail: '数据理解已完成，无需额外确认。',
    percent: null,
    indeterminate: true,
  },
  checkpoint: undefined,
  dataset: {
    datasetRef: 'dataset_mock_news_remote',
    datasetHash: 'sha256:dataset-mock-news-remote',
    fileName: 'news-corpus.parquet',
    rowCount: 24_600,
    columnCount: 12,
    languageSummary: '中文与英文混合',
    qualityWarnings: ['约 1.2% 的发布时间缺失。'],
    assumptions: ['article_body 是主要分析文本。', 'published_at 可用于时间趋势分析。'],
  },
  capabilities: {
    ...defaultRunView.capabilities,
    canConfirmCheckpoint: false,
    canRejectCheckpoint: false,
  },
  links: {
    ...defaultRunView.links,
    messages: '/api/v3/runs/run_mock_dataset_skipped/messages',
    events: '/api/v3/runs/run_mock_dataset_skipped/events/stream',
    timeline: '/api/v3/runs/run_mock_dataset_skipped/timeline',
    checkpoint: undefined,
  },
});

export const createResearchWorkspace = (
  userDirection: string,
  revision = 1,
): ResearchWorkspaceSummary => ({
  workspaceHash: `sha256:research-workspace-v${revision}`,
  narrative: `研究将围绕“${userDirection}”展开，重点比较核心主题、时间变化及不同来源之间的差异。`,
  statements: [
    {
      id: 'statement_goal',
      text: `主要研究目标：${userDirection}`,
      status: 'confirmed',
    },
    {
      id: 'statement_unit',
      text: '以单篇文本为分析单位，并保留发布时间与来源作为比较维度。',
      status: 'inferred',
    },
    {
      id: 'statement_scope',
      text: '是否需要聚焦特定时间范围尚未明确。',
      status: 'uncertain',
    },
  ],
  assumptions: ['未指定时间范围时使用数据集完整时间跨度。'],
  contradictions: [],
});

export const createResearchCheckpoint = (
  research: ResearchWorkspaceSummary,
  revision = 1,
): ConversationalCheckpointView => ({
  checkpointId: 'checkpoint_research_1',
  kind: 'research',
  revision,
  contentHash: `sha256:research-checkpoint-v${revision}`,
  mandatory: false,
  status: 'proposed',
  requestedBy: 'minimax',
  title: '研究理解确认',
  summary: 'Agent 已将对话整理为研究叙事，请确认当前理解或直接说明修改内容。',
  sections: [
    {
      id: 'research-narrative',
      title: '研究叙事',
      kind: 'text',
      content: research.narrative,
    },
  ],
  assumptions: research.assumptions,
  warnings: research.contradictions,
  allowedActions: ['ask', 'revise', 'confirm', 'return_previous'],
  createdAt: new Date().toISOString(),
});

export const createPlanCandidate = (
  research: ResearchWorkspaceSummary,
  revision = 1,
  userFeedback?: string,
  datasetHash = 'sha256:dataset-mock-news-remote',
): PlanCandidateView => ({
  candidateId: 'plan_candidate_1',
  revision,
  candidatePlanHash: `sha256:plan-candidate-v${revision}`,
  boundDatasetHash: datasetHash,
  boundResearchWorkspaceHash: research.workspaceHash,
  status: 'valid',
  summary: userFeedback
    ? `根据用户反馈“${userFeedback}”修订后的主题建模与来源对比方案。`
    : '使用 BERTopic 识别新闻议题，并通过 NMF 对照实验评估主题稳定性。',
  primaryModel: {
    modelId: 'bertopic-multilingual',
    displayName: 'BERTopic Multilingual',
    rationale: '适合中英文混合语料，并能利用语义嵌入识别相近议题。',
  },
  baselineModel: {
    modelId: 'nmf-tfidf',
    displayName: 'NMF + TF-IDF',
    rationale: '提供可解释、计算成本较低的非神经主题模型基线。',
  },
  parameters: [
    {
      field: 'num_topics',
      value: userFeedback ? 12 : 10,
      rationale: userFeedback ? '根据用户修订要求调整。' : 'Validator 将初稿的 30 个主题收敛到 10 个。',
      source: userFeedback ? 'user' : 'validator_default',
    },
    {
      field: 'min_document_frequency',
      value: 8,
      rationale: '过滤低频噪声词，同时保留小众监管议题。',
      source: 'validator_default',
    },
    {
      field: 'iterations',
      value: 500,
      rationale: '满足 NMF 基线收敛要求。',
      source: 'agent',
    },
  ],
  experiment: {
    mode: 'primary_with_baseline',
    runCount: 6,
    seeds: [11, 23, 47],
    rationale: '两个模型分别使用三个随机种子，以评估主题稳定性。',
  },
  preprocessing: ['语言识别与统一清洗', '保留来源和发布时间字段', '短文本与重复文本过滤'],
  evaluation: ['主题一致性', '跨随机种子稳定性', '来源区分度', '人工可解释性抽查'],
  visualizations: ['主题占比', '来源对比', '时间趋势', '主题相似度图'],
  expectedOutputs: ['候选主题与关键词', '文档主题分配', '来源差异报告', '可复现实验清单'],
  resources: {
    estimatedMinutes: 18,
    cpuCores: 4,
    memoryGb: 8,
    accelerator: 'CPU',
    notes: ['基于 24,600 篇文本的 Mock 估算。'],
  },
  alternatives: [
    {
      modelId: 'lda-gensim',
      displayName: 'LDA',
      tradeoff: '资源消耗更低，但对中英文语义相似表达的聚合能力较弱。',
    },
    {
      modelId: 'stm',
      displayName: 'Structural Topic Model',
      tradeoff: '更适合协变量解释，但当前运行环境需要额外依赖。',
    },
  ],
  evidence: [
    {
      refId: 'evidence_dataset_language',
      label: '数据语言观察',
      summary: '语料包含中文和英文，语义嵌入模型能减少分词差异。',
      type: 'dataset_observation',
    },
    {
      refId: 'evidence_validator_runtime',
      label: '运行条件检查',
      summary: '候选模型与参数在当前 CPU 和内存预算内可执行。',
      type: 'validator',
    },
  ],
  assumptions: ['发布时间和来源字段可用于分组评价。'],
  warnings: ['跨语言主题命名仍需要人工抽查。'],
  validation: {
    valid: true,
    receiptHash: `sha256:plan-validation-v${revision}`,
    issues: [
      ...(!userFeedback ? [{
        code: 'AUTO_REVISED_TOPIC_COUNT',
        severity: 'warning' as const,
        message: 'Validator 拒绝了初稿中的 30 个主题，Agent 已自动修订为 10 个。',
        field: 'num_topics',
      }] : []),
      {
        code: 'CROSS_LANGUAGE_LABEL_REVIEW',
        severity: 'warning',
        message: '建议在结果阶段抽查跨语言主题标签。',
      },
    ],
  },
});

export const createPlanCheckpoint = (
  plan: PlanCandidateView,
): ConversationalCheckpointView => ({
  checkpointId: 'checkpoint_plan_1',
  kind: 'plan',
  revision: plan.revision,
  contentHash: plan.candidatePlanHash,
  mandatory: true,
  status: 'proposed',
  requestedBy: 'fsm',
  title: '研究方案审批',
  summary: plan.summary,
  sections: [],
  assumptions: plan.assumptions,
  warnings: plan.warnings,
  allowedActions: ['ask', 'revise', 'confirm', 'return_previous'],
  createdAt: new Date().toISOString(),
});

export const createTrainingApprovalView = (plan: PlanCandidateView): TrainingView => ({
  status: 'not_started',
  stage: {
    id: 'dry_run_completed',
    label: '训练前检查已通过',
    detail: '数据路径、模型依赖和资源条件均已验证。',
  },
  progress: {
    scope: 'training',
    stageId: 'training_approval',
    label: '等待训练批准',
    detail: '训练尚未开始。',
    percent: null,
    indeterminate: true,
  },
  experiments: plan.experiment?.seeds.flatMap((seed, index) => [
    {
      experimentId: `experiment_primary_${index + 1}`,
      modelId: plan.primaryModel?.modelId ?? 'primary',
      seed,
      status: 'pending',
      percent: null,
    },
    {
      experimentId: `experiment_baseline_${index + 1}`,
      modelId: plan.baselineModel?.modelId ?? 'baseline',
      seed,
      status: 'pending',
      percent: null,
    },
  ]) ?? [],
  updatedAt: new Date().toISOString(),
  recentNotices: ['Dry Run 已完成，尚未启动任何训练进程。'],
  canonicalPlanHash: plan.candidatePlanHash,
  dryRunHash: `sha256:dry-run-${plan.candidatePlanHash.split(':').at(-1)}`,
});

export const createToolPermissionFailure = (): FailureDescriptor => ({
  failureId: 'failure_tool_permission_1',
  code: 'TOOL_PERMISSION_DENIED',
  category: 'permission',
  stage: 'plan_validation',
  title: '模型环境检查被拒绝',
  userMessage: 'Agent 无权读取所选模型的运行环境信息，当前方案未被修改。',
  technicalMessageRef: 'technical-event://failure_tool_permission_1',
  retryable: true,
  recoverable: true,
  suggestedActions: [
    {
      id: 'retry_plan_validation',
      label: '重试环境检查',
      description: '重新执行当前方案的只读环境检查。',
      type: 'retry',
    },
    {
      id: 'return_plan',
      label: '返回方案修改',
      description: '保留当前研究理解并返回方案确认。',
      type: 'return_plan',
    },
    {
      id: 'cancel_run',
      label: '取消研究',
      description: '终止当前 Run，不启动训练。',
      type: 'cancel',
    },
  ],
  occurredAt: new Date().toISOString(),
});

export const mockResultArtifacts: ResultArtifactSummary[] = [
  {
    artifactId: 'artifact_overview_report',
    name: '研究结果概览.html',
    kind: 'report',
    mimeType: 'text/html',
    sizeBytes: 184_320,
    createdAt: new Date().toISOString(),
    contentUrl: '/api/agent-v3/runs/run_mock_dataset_skipped/results/artifacts/artifact_overview_report/content',
  },
  {
    artifactId: 'artifact_topic_table',
    name: '主题关键词.csv',
    kind: 'table',
    mimeType: 'text/csv',
    sizeBytes: 42_180,
    createdAt: new Date().toISOString(),
    contentUrl: '/api/agent-v3/runs/run_mock_dataset_skipped/results/artifacts/artifact_topic_table/content',
    experimentId: 'experiment_1',
  },
  {
    artifactId: 'artifact_topic_share',
    name: '主题占比.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 326_400,
    createdAt: new Date().toISOString(),
    contentUrl: '/api/agent-v3/runs/run_mock_dataset_skipped/results/artifacts/artifact_topic_share/content',
    experimentId: 'experiment_1',
  },
  {
    artifactId: 'artifact_model_bundle',
    name: '可复现实验清单.json',
    kind: 'model',
    mimeType: 'application/json',
    sizeBytes: 18_720,
    createdAt: new Date().toISOString(),
    contentUrl: '/api/agent-v3/runs/run_mock_dataset_skipped/results/artifacts/artifact_model_bundle/content',
  },
];

export const defaultEvents: ProductRunEvent[] = [
  {
    eventId: 'event_1',
    sequence: 1,
    type: 'checkpoint.proposed',
    runId: defaultRunView.runId,
    runRevision: defaultRunView.revision,
    occurredAt: now,
    payload: { view: { checkpoint: defaultRunView.checkpoint } },
  },
];
