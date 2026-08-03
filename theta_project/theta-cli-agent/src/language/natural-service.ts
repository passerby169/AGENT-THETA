import { createHash } from 'node:crypto';
import type {
  InferenceProvider,
  PromptMessage,
} from '@hypha/inference';
import {
  NATURAL_LANGUAGE_CONTRACT_VERSION,
  naturalLanguageProviderOutputSchema,
  naturalLanguageRequestSchema,
  naturalLanguageResultSchema,
  type NaturalLanguageProviderOutput,
  type NaturalLanguageRequest,
  type NaturalLanguageResult,
} from '../conversation/natural-contracts.js';
import { researchBriefSchema } from '../agent/research-contracts.js';
import {
  sanitizeLanguageText,
  sanitizeResearchBrief,
} from './sanitizer.js';

export interface NaturalLanguageServiceOptions {
  provider?: InferenceProvider;
  modelAlias?: string;
}

export class ThetaNaturalLanguageService {
  constructor(private readonly options: NaturalLanguageServiceOptions = {}) {}

  async generate(input: NaturalLanguageRequest): Promise<NaturalLanguageResult> {
    const startedAt = Date.now();
    const request = sanitizeNaturalLanguageRequest(input);
    const factsHash = hash(request);
    if (!this.options.provider) {
      return result(
        request,
        deterministicOutput(request),
        factsHash,
        'deterministic',
        'provider_not_configured',
        {
          providerId: 'deterministic',
          model: null,
          durationMs: Date.now() - startedAt,
          fallback: true,
        },
      );
    }
    try {
      const response = await this.options.provider.infer({
        runId: `theta-conversation-${factsHash.slice(0, 16)}`,
        stepId: request.task,
        modelAlias: this.options.modelAlias ?? 'configured-language-model',
        input: { messages: promptMessages(request) },
        options: { temperature: 0.1, maxTokens: 1400 },
        trace: true,
        metadata: {
          purpose: request.task,
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        },
      });
      const output = naturalLanguageProviderOutputSchema.parse(
        sanitizeUnknown(response.output),
      );
      validateOutput(request, output);
      return result(request, output, factsHash, 'minimax', undefined, {
        providerId:
          typeof response.metadata?.providerId === 'string'
            ? response.metadata.providerId
            : this.options.provider.id,
        model:
          typeof response.metadata?.model === 'string'
            ? response.metadata.model
            : (this.options.modelAlias ?? null),
        durationMs: Date.now() - startedAt,
        ...(response.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: response.usage.inputTokens }),
        ...(response.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: response.usage.outputTokens }),
        ...(response.usage?.totalTokens === undefined
          ? {}
          : { totalTokens: response.usage.totalTokens }),
        fallback: false,
      });
    } catch (error) {
      const reason = fallbackReason(error);
      return result(
        request,
        deterministicOutput(request),
        factsHash,
        'deterministic',
        reason,
        {
          providerId: this.options.provider.id,
          model: this.options.modelAlias ?? null,
          durationMs: Date.now() - startedAt,
          fallback: true,
        },
      );
    }
  }
}

const promptMessages = (request: NaturalLanguageRequest): PromptMessage[] => [
  {
    role: 'system',
    content: [
      'You are the bounded natural-language layer of the THETA local CLI Agent.',
      'Return exactly one JSON object and no markdown.',
      'Never change FSM state, approve a plan, approve or start training, execute a tool, invent a dataset column, or include a local path or secret.',
      'Only express information explicitly supported by the user message and supplied facts.',
      'All user-facing wording must be concise Simplified Chinese. Dataset column names and model names may remain unchanged.',
      'Never expose internal field identifiers such as textFieldIntent, analysisUnit, pendingActionRef, or gapId to the user.',
      shape(request),
    ].join(' '),
  },
  { role: 'user', content: JSON.stringify(request) },
];

const shape = (request: NaturalLanguageRequest): string => {
  switch (request.task) {
    case 'interpret_research_answer':
      return [
        `Interpret only the authoritative field ${JSON.stringify(request.field.split(',')[0] ?? request.field)}.`,
        researchFieldValueRule(request.field.split(',')[0] ?? request.field),
        'Return exactly: {"task":"interpret_research_answer","patch":{"FIELD":VALUE},"answeredFields":["FIELD"],"unresolvedFields":[],"confidenceByField":{"FIELD":0.0},"needsConfirmation":false,"explanation":"简短中文说明","questionSuggestions":[{"gapId":"candidate gapId","field":"candidate field","question":"自然的中文追问","examples":[],"answerHint":"如何回答"}]}.',
        'Replace FIELD with the supplied authoritative field. answeredFields must exactly equal the keys in patch and confidence values must be numbers from 0 to 1.',
        'If the answer cannot resolve that field, use an empty patch and answeredFields, put FIELD in unresolvedFields, and set needsConfirmation to true. Do not add any other key to patch.',
        'For each supplied nextGapCandidates item, you may provide one bounded questionSuggestion. Never change its gapId or field. These are candidate phrasings only; the FSM decides which one is actually next.',
      ].join(' ');
    case 'generate_grilling_question':
      return `Shape: {"task":"generate_grilling_question","gapId":${JSON.stringify(request.gapId)},"field":${JSON.stringify(request.field)},"question":"...","reason":"...","examples":[],"answerHint":"..."}.`;
    case 'interpret_column_confirmation':
      return 'Shape: {"task":"interpret_column_confirmation","draft":{"textColumns":[],"timeColumn":null,"idColumn":null,"covariateColumns":[],"metadataColumns":[],"groupingColumns":[],"evaluationLabelColumns":[]},"unknownMentions":[],"ambiguousMentions":[],"confidence":0.0,"needsClarification":false,"explanation":"..."}. covariateColumns are training inputs for STM; metadataColumns are descriptive only; groupingColumns are post-hoc display groups; evaluationLabelColumns are held-out labels. Never treat a display group as an STM covariate unless the user explicitly assigns both roles. Omit draft when ambiguous.';
    case 'classify_conversation_intent':
      return 'Shape: {"task":"classify_conversation_intent","intent":"read_status|read_evidence|search_evidence|list_models|explain_current|approve_current|reject_current|help|chat|unknown","response":"..."}.';
    case 'propose_readonly_tool':
      return 'Shape: {"task":"propose_readonly_tool","intent":"...","toolId":"one supplied allowedToolIds or null","arguments":{},"reason":"...","confidence":0.0,"requiresConfirmation":false}. Never propose a write or training tool.';
    case 'compose_grounded_response':
      return 'Shape: {"task":"compose_grounded_response","text":"...","evidenceIds":[]}. Use only supplied facts and evidence; never claim an action was executed unless facts prove it.';
  }
};

const validateOutput = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
): void => {
  if (request.task !== output.task) {
    throw new Error('Provider changed the requested task.');
  }
  if (
    request.task === 'interpret_research_answer' &&
    output.task === 'interpret_research_answer'
  ) {
    const patchedFields = new Set(Object.keys(output.patch));
    if (
      output.answeredFields.some((field) => !patchedFields.has(field)) ||
      (patchedFields.size === 0 &&
        !output.needsConfirmation &&
        output.unresolvedFields.length === 0)
    ) {
      throw new Error(
        'Provider answer metadata is inconsistent with its ResearchBriefPatch.',
      );
    }
    const allowedSuggestions = new Map(
      (request.nextGapCandidates ?? []).map((candidate) => [
        candidate.gapId,
        candidate.field,
      ]),
    );
    if (
      output.questionSuggestions.some(
        (suggestion) =>
          allowedSuggestions.get(suggestion.gapId) !== suggestion.field ||
          !/[\u3400-\u9fff]/u.test(suggestion.question),
      )
    ) {
      throw new Error(
        'Provider question suggestion changed an authoritative gap or failed the Chinese UX quality gate.',
      );
    }
  }
  if (
    request.task === 'generate_grilling_question' &&
    output.task === 'generate_grilling_question'
  ) {
    if (output.gapId !== request.gapId || output.field !== request.field) {
      throw new Error('Provider changed the authoritative gap or field.');
    }
    if (
      !/[\u3400-\u9fff]/u.test(output.question) ||
      /(textFieldIntent|analysisUnit|pendingActionRef|gapId|ResearchBrief)/u.test(
        `${output.question} ${output.answerHint ?? ''}`,
      )
    ) {
      throw new Error('Provider question failed the Chinese UX quality gate.');
    }
  }
  if (
    request.task === 'interpret_column_confirmation' &&
    output.task === 'interpret_column_confirmation' &&
    output.draft
  ) {
    const allowed = new Set(request.columns);
    const selected = [
      ...output.draft.textColumns,
      ...(output.draft.timeColumn ? [output.draft.timeColumn] : []),
      ...(output.draft.idColumn ? [output.draft.idColumn] : []),
      ...(output.draft.covariateColumns ?? []),
      ...output.draft.metadataColumns,
      ...(output.draft.groupingColumns ?? []),
      ...(output.draft.evaluationLabelColumns ?? []),
    ];
    if (selected.some((column) => !allowed.has(column))) {
      throw new Error('Provider invented a dataset column.');
    }
    const roleIssue = validateColumnRoleDraft(
      { ...output.draft, covariateColumns: output.draft.covariateColumns ?? [] },
      request.columnProfiles ?? [],
    );
    if (roleIssue) throw new Error(roleIssue);
  }
  if (
    request.task === 'propose_readonly_tool' &&
    output.task === 'propose_readonly_tool' &&
    output.toolId !== null &&
    !request.allowedToolIds.includes(output.toolId)
  ) {
    throw new Error('Provider proposed a tool outside the state allowlist.');
  }
};

const deterministicOutput = (
  request: NaturalLanguageRequest,
): NaturalLanguageProviderOutput => {
  switch (request.task) {
    case 'interpret_research_answer':
      return deterministicResearchAnswer(request);
    case 'generate_grilling_question':
      return {
        task: request.task,
        gapId: request.gapId,
        field: request.field,
        question: normalizeQuestion(request.draftQuestion),
        reason: request.reason,
        examples: deterministicExamples(request.field),
        answerHint:
          request.attempt === 1
            ? '请直接用自然语言回答；如果不确定，也可以说明“不知道”。'
            : '如果这个问题不适用于你的研究，可以回答“不适用”。',
      };
    case 'interpret_column_confirmation':
      return deterministicColumns(request);
    case 'classify_conversation_intent':
      return deterministicIntent(request.text);
    case 'propose_readonly_tool':
      return deterministicToolProposal(request.text, request.allowedToolIds);
    case 'compose_grounded_response':
      return {
        task: request.task,
        text:
          request.evidence.length > 0
            ? `根据本地证据，已找到 ${request.evidence.length} 条相关信息：${request.evidence.map((item) => item.excerpt).join('；')}`
            : `根据当前受治理工具结果：${sanitizeLanguageText(JSON.stringify(request.facts), 1600)}`,
        evidenceIds: request.evidence.map((item) => item.evidenceId),
      };
  }
};

const deterministicResearchAnswer = (
  request: Extract<
    NaturalLanguageRequest,
    { task: 'interpret_research_answer' }
  >,
): NaturalLanguageProviderOutput => {
  const answer = request.answer.trim();
  const field = request.field.split(',')[0] ?? request.field;
  const patch: Record<string, unknown> = {};
  if (field === 'trendAnalysis') {
    patch.trendAnalysis = !/(不|否|no|不要|无需)/iu.test(answer);
  } else if (field === 'offlineOnly') {
    patch.offlineOnly = !/(联网|远程|online|remote)/iu.test(answer);
  } else if (field === 'topicGranularity') {
    patch.topicGranularity = /细|fine/iu.test(answer)
      ? 'fine'
      : /粗|宽|broad/iu.test(answer)
        ? 'broad'
        : 'medium';
  } else if (field === 'timeRange') {
    const years = answer.match(/(?:19|20)\d{2}/gu) ?? [];
    if (years.length > 0) {
      patch.timeRange = {
        start: years[0],
        ...(years[1] ? { end: years[1] } : {}),
      };
    }
  } else if (field === 'sensitiveData') {
    patch.sensitiveData = {
      status:
        /(不包含|不含|不存在|没有|完全.{0,8}模拟|人工.{0,8}模拟|无|否|\bno\b)/iu.test(
          answer,
        )
          ? 'no'
          : 'yes',
      categories: [],
    };
  } else if (field === 'hardwareLimit') {
    const memory = answer.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)/iu);
    patch.hardwareLimit = {
      device:
        /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*(?:GPU|显卡|CUDA)/iu.test(
          answer,
        )
          ? 'cpu'
          : /GPU|显卡|CUDA/iu.test(answer)
            ? 'gpu'
            : /CPU/iu.test(answer)
              ? 'cpu'
              : 'unknown',
      ...(memory ? { memoryGb: Number(memory[1]) } : {}),
    };
  } else if (
    ['comparisonGroups', 'knownBiases', 'successCriteria'].includes(field)
  ) {
    patch[field] = answer
      .split(/[，,、;；]/u)
      .map((value) => value.trim())
      .filter(Boolean);
  } else if (
    [
      'researchQuestion',
      'collectionMethod',
      'analysisUnit',
      'language',
      'textFieldIntent',
    ].includes(field)
  ) {
    patch[field] = answer;
  }
  const answered = Object.keys(patch);
  return {
    task: request.task,
    patch,
    answeredFields: answered,
    unresolvedFields: answered.length === 0 ? [request.field] : [],
    confidenceByField: Object.fromEntries(
      answered.map((name) => [name, 0.55]),
    ),
    needsConfirmation: answered.length === 0,
    explanation:
      answered.length === 0
        ? '确定性回退无法安全映射这段回答，需要进一步确认。'
        : `已将回答映射到 ${answered.join('、')}。`,
    questionSuggestions: (request.nextGapCandidates ?? []).map((candidate) => ({
      gapId: candidate.gapId,
      field: candidate.field,
      question: normalizeQuestion(candidate.draftQuestion),
      examples: deterministicExamples(candidate.field),
      answerHint: '请直接用自然语言回答；如果不确定，也可以说明“不知道”。',
    })),
  };
};

const deterministicExamples = (field: string): string[] => {
  const examples: Readonly<Record<string, string>> = {
    researchQuestion: '我想比较不同来源的风险主题，并观察它们随时间的变化。',
    analysisUnit: '每一行是一条独立文档，正文位于 text 列。',
    textFieldIntent: '分析 text 列中的正文，不分析编号和时间。',
    sensitiveData: '这是人工模拟数据，不包含个人或机密信息。',
    collectionMethod: '数据由人工模拟生成，用于验证主题分析流程。',
    comparisonGroups: '比较不同 source，并按月份观察变化。',
    successCriteria: '主题应当清晰可解释，并能展示来源之间的差异。',
    topicGranularity: '先使用少量宽泛主题，保证结果稳定。',
    knownBiases: '样本量较小，不能代表真实总体。',
    hardwareLimit: '只使用 CPU，内存约 16GB。',
  };
  return examples[field] ? [examples[field]] : [];
};

const deterministicColumns = (
  request: Extract<
    NaturalLanguageRequest,
    { task: 'interpret_column_confirmation' }
  >,
): NaturalLanguageProviderOutput => {
  const mentioned = request.columns.filter((column) =>
    request.answer.toLowerCase().includes(column.toLowerCase()),
  );
  const linked = (column: string, labels: string): boolean => {
    const columnName = column.toLowerCase();
    const roleLabels = labels.split('|').map((label) => label.toLowerCase());
    return request.answer
      .toLowerCase()
      .split(/[，,；;。\n]/u)
      .some(
        (clause) =>
          clause.includes(columnName) &&
          roleLabels.some((label) => clause.includes(label)),
      );
  };
  const text = mentioned.find((column) => linked(column, '正文|文本内容|待分析文本|语料'));
  const time = mentioned.find((column) => linked(column, '时间列|日期列|时间戳')) ?? null;
  const id = mentioned.find((column) => linked(column, 'ID列|标识列|编号列|唯一标识')) ?? null;
  const covariates = mentioned.filter((column) =>
    linked(column, '训练协变量|协变量列|STM协变量|模型协变量'),
  );
  const groups = mentioned.filter((column) =>
    linked(column, '展示分组|分组列|对比分组|分组展示'),
  );
  const labels = mentioned.filter((column) =>
    linked(column, '评估标签|标签列|Golden标签|真值标签'),
  );
  if (!text) {
    return {
      task: request.task,
      unknownMentions: [],
      ambiguousMentions: mentioned,
      confidence: 0,
      needsClarification: true,
      explanation: '无法确定唯一文本列，请明确说明正文列名称。',
    };
  }
  const draft = {
    textColumns: [text],
    timeColumn: time,
    idColumn: id,
    covariateColumns: covariates,
    metadataColumns: [],
    groupingColumns: groups,
    evaluationLabelColumns: labels,
  };
  const roleIssue = validateColumnRoleDraft(draft, request.columnProfiles ?? []);
  if (roleIssue) {
    return {
      task: request.task,
      draft,
      unknownMentions: [],
      ambiguousMentions: mentioned,
      confidence: 0,
      needsClarification: true,
      explanation: `${roleIssue} 请重新明确各列角色。`,
    };
  }
  const explicitlyReviewed = /(?:^|[：:\s])(?:我)?确认(?:无误)?|confirm/iu.test(request.answer);
  return {
    task: request.task,
    draft,
    unknownMentions: [],
    ambiguousMentions: explicitlyReviewed ? [] : mentioned,
    confidence: explicitlyReviewed ? 0.9 : 0.6,
    needsClarification: !explicitlyReviewed,
    explanation: explicitlyReviewed
      ? '已通过列类型校验并记录显式确认。'
      : `请复核后再次提交“确认：${columnDraftSummary(draft)}”。确定性模式不会直接采用首次解析结果。`,
  };
};

type ColumnRoleDraft = {
  textColumns: string[];
  timeColumn: string | null;
  idColumn: string | null;
  covariateColumns: string[];
  metadataColumns: string[];
  groupingColumns?: string[];
  evaluationLabelColumns?: string[];
};

const validateColumnRoleDraft = (
  draft: ColumnRoleDraft,
  profiles: ReadonlyArray<{
    name: string;
    inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
    nonEmptySampleCount: number;
    uniqueSampleCount: number;
    avgLength: number;
    maxLength: number;
  }>,
): string | undefined => {
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const profile = (name: string) => byName.get(name);
  const idLike = (name: string) => /(?:^|_)(?:id|uuid|key|index|record_id)(?:$|_)/iu.test(name);
  for (const column of draft.textColumns) {
    const item = profile(column);
    if (idLike(column) || item?.inferredType === 'number' || item?.inferredType === 'datetime' || item?.inferredType === 'empty') {
      return `列 ${column} 的类型不适合作为正文`;
    }
    if (item && item.avgLength < 8 && item.inferredType !== 'text') {
      return `列 ${column} 的样本文本过短，不足以安全认定为正文`;
    }
  }
  if (draft.timeColumn) {
    const item = profile(draft.timeColumn);
    if (item && item.inferredType !== 'datetime') return `列 ${draft.timeColumn} 不能稳定解析为时间`;
  }
  if (draft.idColumn) {
    const item = profile(draft.idColumn);
    const uniqueRatio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (!idLike(draft.idColumn) && item && uniqueRatio < 0.8) {
      return `列 ${draft.idColumn} 不具备唯一标识特征`;
    }
  }
  const roles = [
    ...draft.textColumns.map((name) => [name, '正文'] as const),
    ...(draft.timeColumn ? [[draft.timeColumn, '时间'] as const] : []),
    ...(draft.idColumn ? [[draft.idColumn, 'ID'] as const] : []),
    ...draft.covariateColumns.map((name) => [name, '训练协变量'] as const),
    ...draft.metadataColumns.map((name) => [name, '描述元数据'] as const),
    ...(draft.groupingColumns ?? []).map((name) => [name, '展示分组'] as const),
    ...(draft.evaluationLabelColumns ?? []).map((name) => [name, '评估标签'] as const),
  ];
  const assigned = new Map<string, string[]>();
  for (const [name, role] of roles) assigned.set(name, [...(assigned.get(name) ?? []), role]);
  const overlap = [...assigned].find(([, values]) => {
    const roles = new Set(values);
    return values.length > 1 && !(
      roles.size === 2 &&
      roles.has('训练协变量') &&
      roles.has('展示分组')
    );
  });
  if (overlap) return `列 ${overlap[0]} 同时被绑定为 ${overlap[1].join('、')}`;
  for (const column of [...draft.covariateColumns, ...(draft.groupingColumns ?? [])]) {
    const item = profile(column);
    const uniqueRatio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (item && (item.inferredType === 'text' || uniqueRatio > 0.8)) {
      return `列 ${column} 不适合作为低基数协变量或展示分组`;
    }
  }
  return undefined;
};

const columnDraftSummary = (draft: ColumnRoleDraft): string =>
  `正文 ${draft.textColumns.join('、')}；时间 ${draft.timeColumn ?? '无'}；ID ${draft.idColumn ?? '无'}；训练协变量 ${draft.covariateColumns.join('、') || '无'}；展示分组 ${(draft.groupingColumns ?? []).join('、') || '无'}`;

const deterministicIntent = (
  text: string,
): NaturalLanguageProviderOutput => {
  const normalized = text.toLowerCase();
  const intent = /状态|进度|status|progress/u.test(normalized)
    ? 'read_status'
    : /证据|依据|evidence/u.test(normalized)
      ? 'read_evidence'
      : /搜索|检索|search/u.test(normalized)
        ? 'search_evidence'
        : /模型|models?/u.test(normalized)
          ? 'list_models'
          : /为什么|解释|why|explain/u.test(normalized)
            ? 'explain_current'
            : /同意|批准|approve/u.test(normalized)
              ? 'approve_current'
              : /拒绝|不同意|reject/u.test(normalized)
                ? 'reject_current'
                : /帮助|help|怎么用/u.test(normalized)
                  ? 'help'
                  : 'chat';
  return {
    task: 'classify_conversation_intent',
    intent,
    response: `已识别为 ${intent}。`,
  };
};

const deterministicToolProposal = (
  text: string,
  allowed: readonly string[],
): NaturalLanguageProviderOutput => {
  const classified = deterministicIntent(text);
  const intent =
    classified.task === 'classify_conversation_intent'
      ? classified.intent
      : 'unknown';
  const preferred: Partial<Record<typeof intent, string>> = {
    read_status: 'theta.status.read',
    read_evidence: 'theta.evidence.read',
    search_evidence: 'theta.rag.search',
    list_models: 'theta.model.catalog',
  };
  const candidate = preferred[intent];
  const toolId =
    candidate && allowed.includes(candidate as never)
      ? (candidate as (typeof allowed)[number])
      : null;
  return {
    task: 'propose_readonly_tool',
    intent,
    toolId: toolId as
      | 'theta.status.read'
      | 'theta.evidence.read'
      | 'theta.rag.search'
      | 'theta.model.catalog'
      | null,
    arguments:
      toolId === 'theta.rag.search' ? { query: sanitizeLanguageText(text) } : {},
    reason: toolId
      ? '该只读工具与用户意图匹配。'
      : '没有允许的工具与当前意图安全匹配。',
    confidence: toolId ? 0.8 : 0.3,
    requiresConfirmation: false,
  };
};

const result = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
  factsHash: string,
  source: 'minimax' | 'deterministic',
  fallbackReason?: string,
  telemetry: {
    providerId: string;
    model: string | null;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    fallback: boolean;
  } = {
    providerId: source,
    model: null,
    durationMs: 0,
    fallback: Boolean(fallbackReason),
  },
): NaturalLanguageResult =>
  naturalLanguageResultSchema.parse({
    schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
    source,
    ...(fallbackReason ? { fallbackReason } : {}),
    factsHash,
    telemetry,
    output,
  });

export const sanitizeNaturalLanguageRequest = (
  input: NaturalLanguageRequest,
): NaturalLanguageRequest => {
  const parsed = naturalLanguageRequestSchema.parse(input);
  const cleanMessages = 'recentMessages' in parsed
    ? parsed.recentMessages.map((message) => ({
        ...message,
        content: sanitizeLanguageText(message.content, 2000),
      }))
    : undefined;
  if (parsed.task === 'interpret_research_answer') {
    return {
      ...parsed,
      answer: sanitizeLanguageText(parsed.answer, 2000),
      question: sanitizeLanguageText(parsed.question, 2000),
      currentBrief: sanitizeBriefRecord(parsed.currentBrief),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'generate_grilling_question') {
    return {
      ...parsed,
      reason: sanitizeLanguageText(parsed.reason, 2000),
      draftQuestion: sanitizeLanguageText(parsed.draftQuestion, 2000),
      currentBrief: sanitizeBriefRecord(parsed.currentBrief),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'interpret_column_confirmation') {
    return {
      ...parsed,
      answer: sanitizeLanguageText(parsed.answer, 2000),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'compose_grounded_response') {
    return {
      ...parsed,
      userText: sanitizeLanguageText(parsed.userText, 2000),
      facts: sanitizeUnknownRecord(parsed.facts),
      evidence: parsed.evidence.map((item) => ({
        evidenceId: sanitizeLanguageText(item.evidenceId, 160),
        excerpt: sanitizeLanguageText(item.excerpt, 1200),
      })),
      recentMessages: cleanMessages ?? [],
    };
  }
  return { ...parsed, text: sanitizeLanguageText(parsed.text, 2000) };
};

const sanitizeBriefRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const brief = researchBriefSchema.safeParse(value);
  return brief.success
    ? sanitizeResearchBrief(brief.data)
    : sanitizeUnknownRecord(value);
};

const sanitizeUnknownRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, nested]) => [
        sanitizeLanguageText(key, 120),
        sanitizeUnknown(nested),
      ]),
  );

const sanitizeUnknown = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeLanguageText(value, 1200);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeUnknown);
  if (value && typeof value === 'object') {
    return sanitizeUnknownRecord(value as Record<string, unknown>);
  }
  return undefined;
};

const normalizeQuestion = (value: string): string =>
  `${value.trim().replace(/[。.!！?？]+$/u, '')}？`;

const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(sortValue(value)))
    .digest('hex');

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
};

const fallbackReason = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return String((error as { code: string }).code);
  }
  if (error instanceof Error) {
    if (error.name === 'ZodError') return 'schema_validation_error';
    if (/metadata is inconsistent/iu.test(error.message)) {
      return 'answer_metadata_inconsistent';
    }
    if (/question failed the Chinese UX quality gate/iu.test(error.message)) {
      return 'question_quality_rejected';
    }
    if (/changed the authoritative gap or field/iu.test(error.message)) {
      return 'question_authority_violation';
    }
    if (/changed the requested task/iu.test(error.message)) {
      return 'task_mismatch';
    }
  }
  return 'schema_or_provider_error';
};

const researchFieldValueRule = (field: string): string => {
  const rules: Readonly<Record<string, string>> = {
    researchQuestion: 'VALUE must be a non-empty string.',
    collectionMethod: 'VALUE must be a non-empty string.',
    analysisUnit: 'VALUE must be a non-empty string.',
    language: 'VALUE must be a non-empty string.',
    textFieldIntent: 'VALUE must be a non-empty string.',
    comparisonGroups: 'VALUE must be an array of non-empty strings.',
    comparisonIntent: 'VALUE must be exactly "unknown", "none", or "groups".',
    knownBiases: 'VALUE must be an array of non-empty strings.',
    successCriteria: 'VALUE must be an array of non-empty strings.',
    topicGranularity:
      'VALUE must be exactly "broad", "medium", or "fine".',
    sensitiveData:
      'VALUE must be {"status":"yes"|"no"|"unknown","categories":[]} with categories as an array of strings.',
    hardwareLimit:
      'VALUE must be {"device":"cpu"|"gpu"|"unknown"} and may include a positive numeric memoryGb.',
    trendAnalysis: 'VALUE must be a boolean.',
    offlineOnly: 'VALUE must be a boolean.',
    requestedEmbedding:
      'VALUE must be exactly "local", "remote", "none", or "unknown".',
    timeRange:
      'VALUE must be an object with optional non-empty string start and end.',
    timeLimitHours: 'VALUE must be a positive number.',
  };
  return rules[field] ?? 'VALUE must follow the supplied ResearchBrief field type.';
};
