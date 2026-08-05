import type { InferenceProvider, PromptMessage } from '@hypha/inference';
import { createMiniMaxProviderFromEnv } from '../providers/minimax.js';
import type { ThetaWorkflowService } from '../theta-workflow-service.js';
import type { ThetaResultAnalysisRequest } from '../web-api/contracts.js';
import { ResultService, type RunResultOverview } from './result-service.js';

export interface ResultAnalysisResponse {
  answer: string;
  provider: string;
  model: string;
  selected: {
    topics: number;
    metrics: number;
    visualizations: number;
    goalAssessment: boolean;
    warnings: boolean;
  };
}

interface SelectedContext {
  text: string;
  selected: ResultAnalysisResponse['selected'];
}

export class ResultAnalysisService {
  private readonly resultService: ResultService;

  constructor(
    workflow: ThetaWorkflowService,
    private readonly provider: InferenceProvider | undefined = createMiniMaxProviderFromEnv(),
  ) {
    this.resultService = new ResultService(workflow);
  }

  async analyze(
    runId: string,
    runtimeDb: string,
    request: ThetaResultAnalysisRequest,
  ): Promise<ResultAnalysisResponse> {
    if (!this.provider) {
      throw new Error('MiniMax 尚未配置，无法使用猫咪科学家分析结果。');
    }
    const results = await this.resultService.overview(runId, runtimeDb);
    if (results.status !== 'completed') {
      throw new Error('只有已完成的训练结果可以交给猫咪科学家分析。');
    }
    const context = buildResultAnalysisContext(results, request.selection);
    const messages: PromptMessage[] = [
      {
        role: 'system',
        content: [
          '你是 THETA 的猫咪科学家，只负责解释用户明确选择的研究结果。',
          '不得推断未提供的数据，不得声称查看了原始数据或图像像素。',
          '需要区分观察、解释与限制；优先使用清晰的中文和可执行的研究建议。',
          '输出严格 JSON：{"answer":"完整回答"}，不要输出 Markdown 代码块。',
        ].join('\n'),
      },
      ...request.history.map((message) => ({
        role: message.role,
        content: message.content,
      } satisfies PromptMessage)),
      {
        role: 'user',
        content: `以下是当前 Run 中经过服务器校验的选择结果：\n${context.text}\n\n用户问题：${request.question}`,
      },
    ];
    const response = await this.provider.infer({
      runId,
      stepId: 'explain_selected_results',
      modelAlias: 'configured-result-analysis-model',
      input: { messages },
      options: { temperature: 0.2, maxTokens: 1200 },
      trace: true,
      metadata: {
        purpose: 'explain_selected_results',
        selected: context.selected,
      },
    });
    const output = asRecord(response.output);
    const answer = typeof output.answer === 'string' ? output.answer.trim() : '';
    if (!answer) throw new Error('MiniMax 未返回可展示的分析回答。');
    return {
      answer,
      provider: String(response.metadata?.providerId ?? this.provider.id),
      model: String(response.metadata?.model ?? 'configured-model'),
      selected: context.selected,
    };
  }
}

export const buildResultAnalysisContext = (
  results: RunResultOverview,
  selection: ThetaResultAnalysisRequest['selection'],
): SelectedContext => {
  const topicIds = new Set(selection.topicIds);
  const metricKeys = new Set(selection.metricKeys);
  const visualizationIds = new Set(selection.visualizationIds);
  const topics = results.topics.filter((topic) => topicIds.has(topic.id)).slice(0, 12);
  const metrics = Object.entries(results.metrics)
    .filter(([key]) => metricKeys.has(key))
    .slice(0, 12);
  const visualizations = results.visualizations
    .filter((item) => visualizationIds.has(item.id))
    .slice(0, 12);
  const sections: string[] = [];
  if (topics.length) {
    sections.push(`主题：\n${topics.map((topic) =>
      `- ${topic.name}（ID=${topic.id}${typeof topic.strength === 'number' ? `，强度=${topic.strength}` : ''}）：${topic.keywords.slice(0, 12).join('、')}`,
    ).join('\n')}`);
  }
  if (metrics.length) {
    sections.push(`指标：\n${metrics.map(([key, value]) => `- ${key}: ${boundedValue(value)}`).join('\n')}`);
  }
  if (visualizations.length) {
    sections.push(`图表目录（仅包含标签与类型，不包含图像像素）：\n${visualizations.map((item) =>
      `- ${item.label}（${item.format === 'interactive' ? '交互式' : '图片'}，${item.scope === 'topic' ? `主题 ${item.topicId ?? '未知'}` : '全局'}）`,
    ).join('\n')}`);
  }
  if (selection.includeGoalAssessment && results.goalAssessment.length) {
    sections.push(`研究目标核对：\n${results.goalAssessment.slice(0, 12).map((item) =>
      `- ${item.criterion}: ${item.status}；${item.evidence}`,
    ).join('\n')}`);
  }
  if (selection.includeWarnings && results.warnings.length) {
    sections.push(`结果限制与提醒：\n${results.warnings.slice(0, 10).map((warning) => `- ${warning}`).join('\n')}`);
  }
  if (!sections.length) throw new Error('所选项目在当前 Run 的正式结果中不存在。');
  return {
    text: sections.join('\n\n').slice(0, 16_000),
    selected: {
      topics: topics.length,
      metrics: metrics.length,
      visualizations: visualizations.length,
      goalAssessment: selection.includeGoalAssessment && results.goalAssessment.length > 0,
      warnings: selection.includeWarnings && results.warnings.length > 0,
    },
  };
};

const boundedValue = (value: unknown): string => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return (serialized ?? String(value)).slice(0, 800);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
