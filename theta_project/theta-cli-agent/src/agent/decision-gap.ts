import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  researchIntentSchema,
  type DatasetConfirmation,
  type DatasetUnderstandingDraft,
  type ResearchIntent,
} from '../dataset-understanding/contracts.js';

export const decisionGapSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['research_goal', 'comparison', 'temporal', 'granularity', 'success', 'constraint']),
  question: z.string().min(1),
  whyItMatters: z.string().min(1),
  planImpact: z.string().min(1),
  blocking: z.boolean(),
  defaultResolution: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(8),
});

export const interviewMemorySchema = z.object({
  askedQuestionHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  resolvedGapIds: z.array(z.string().min(1)),
  defaultedGapIds: z.array(z.string().min(1)),
  lastQuestionByGap: z.record(z.string()),
});

export type DecisionGap = z.infer<typeof decisionGapSchema>;
export type InterviewMemory = z.infer<typeof interviewMemorySchema>;

export interface DecisionGapTurn {
  intent: ResearchIntent;
  memory: InterviewMemory;
  nextGap?: DecisionGap;
  appliedDefaults: string[];
  extractedFields: string[];
}

export const emptyInterviewMemory = (): InterviewMemory => ({
  askedQuestionHashes: [],
  resolvedGapIds: [],
  defaultedGapIds: [],
  lastQuestionByGap: {},
});

export const createInitialResearchIntent = (): ResearchIntent =>
  researchIntentSchema.parse({
    schemaVersion: '2.0.0',
    researchQuestion: '探索数据中的主要结构与可解释模式',
    comparisonDimensions: [],
    temporalAnalysis: false,
    topicGranularity: 'medium',
    successCriteria: [],
    constraints: [],
    unknowns: ['research_goal', 'comparison', 'temporal', 'success'],
  });

export const deriveDecisionGaps = (
  understanding: DatasetUnderstandingDraft,
  confirmation: DatasetConfirmation,
  intent: ResearchIntent,
): DecisionGap[] => {
  const gaps: DecisionGap[] = [];
  const hasUnknown = (id: string): boolean => intent.unknowns.includes(id);
  if (hasUnknown('research_goal')) {
    gaps.push(gap('research_goal', 'research_goal',
      `我已确认主要分析 ${confirmation.textColumns.join('、')}。你最希望从这些记录中得到什么结论？`,
      '研究目标决定模型、评价方式和最终结果结构。',
      '影响模型候选、指标和图表。', true,
      '识别主要主题、关键词与代表文本。', [understanding.domain.label]));
  }
  if (hasUnknown('comparison')) {
    const candidates = confirmation.metadataColumns.join('、');
    gaps.push(gap('comparison', 'comparison',
      candidates
        ? `数据中可用于分组的列包括 ${candidates}。需要比较哪些来源、群体或阶段？不需要比较也可以直接说明。`
        : '你需要比较不同来源、群体或阶段吗？不需要时可以直接说“不比较”。',
      '比较需求决定是否需要协变量、分组评价或额外图表。',
      '影响模型能力约束和分组输出。', false,
      '本轮不做分组比较。', confirmation.metadataColumns));
  }
  if (hasUnknown('temporal')) {
    const candidates = confirmation.timeColumns.join('、');
    gaps.push(gap('temporal', 'temporal',
      candidates
        ? `我检测到时间列 ${candidates}。这次需要观察主题随时间变化吗？`
        : '当前没有可靠时间列。这次是否仍把时间趋势作为硬性目标？',
      '时间趋势要求可用时间列和支持时间建模的方案。',
      '影响 DTM 等模型候选与时间切片。', false,
      candidates ? '启用时间趋势分析。' : '不启用原生时间趋势分析。', confirmation.timeColumns));
  }
  if (hasUnknown('success')) {
    gaps.push(gap('success', 'success',
      '什么样的结果会让你认为这次分析是成功的？例如主题清晰、代表文本可信，或趋势能够解释。',
      '成功标准用于选择评价指标和人工审核点。',
      '影响评价门槛和交付内容。', false,
      '主题含义清晰、关键词和代表文本可解释。', []));
  }
  return gaps;
};

export const applyDecisionGapAnswer = (
  current: ResearchIntent,
  gap: DecisionGap,
  answer: string,
  memory: InterviewMemory,
): DecisionGapTurn => {
  const normalized = answer.trim();
  const useDefault = isUnknownAnswer(normalized) || requestsProposalFirst(normalized);
  const patch = useDefault ? defaultPatch(gap) : answerPatch(gap, normalized);
  const resolved = new Set([...memory.resolvedGapIds, gap.id]);
  const defaulted = new Set(memory.defaultedGapIds);
  if (useDefault) defaulted.add(gap.id);
  const unknowns = current.unknowns.filter((item) => item !== gap.id);
  const intent = researchIntentSchema.parse({ ...current, ...patch, unknowns });
  const updatedMemory = interviewMemorySchema.parse({
    ...memory,
    askedQuestionHashes: unique([...memory.askedQuestionHashes, questionHash(gap.question)]),
    resolvedGapIds: [...resolved],
    defaultedGapIds: [...defaulted],
    lastQuestionByGap: { ...memory.lastQuestionByGap, [gap.id]: gap.question },
  });
  return {
    intent,
    memory: updatedMemory,
    appliedDefaults: useDefault ? [gap.defaultResolution] : [],
    extractedFields: Object.keys(patch),
  };
};

export const selectNextDecisionGap = (
  gaps: readonly DecisionGap[],
  memory: InterviewMemory,
): DecisionGap | undefined =>
  gaps.find((item) =>
    !memory.resolvedGapIds.includes(item.id) &&
    !memory.askedQuestionHashes.includes(questionHash(item.question)));

const answerPatch = (gap: DecisionGap, answer: string): Partial<ResearchIntent> => {
  switch (gap.category) {
    case 'research_goal':
      return { researchQuestion: answer };
    case 'comparison':
      return { comparisonDimensions: isNoComparison(answer) ? [] : splitValues(answer) };
    case 'temporal':
      return { temporalAnalysis: isAffirmative(answer) };
    case 'granularity':
      return { topicGranularity: /细|具体|fine/iu.test(answer) ? 'fine' : /粗|概括|coarse/iu.test(answer) ? 'coarse' : 'medium' };
    case 'success':
      return { successCriteria: splitValues(answer) };
    case 'constraint':
      return { constraints: splitValues(answer) };
  }
};

const defaultPatch = (gap: DecisionGap): Partial<ResearchIntent> => {
  switch (gap.category) {
    case 'research_goal': return { researchQuestion: gap.defaultResolution };
    case 'comparison': return { comparisonDimensions: [] };
    case 'temporal': return { temporalAnalysis: /启用/iu.test(gap.defaultResolution) };
    case 'granularity': return { topicGranularity: 'medium' };
    case 'success': return { successCriteria: [gap.defaultResolution] };
    case 'constraint': return { constraints: [gap.defaultResolution] };
  }
};

const gap = (
  id: string,
  category: DecisionGap['category'],
  question: string,
  whyItMatters: string,
  planImpact: string,
  blocking: boolean,
  defaultResolution: string,
  evidence: string[],
): DecisionGap => decisionGapSchema.parse({ id, category, question, whyItMatters, planImpact, blocking, defaultResolution, evidence });

const splitValues = (value: string): string[] =>
  value.split(/[，,；;、\n]/u).map((item) => item.trim()).filter(Boolean).slice(0, 12);
const isUnknownAnswer = (value: string): boolean => /^(?:不知道|不清楚|不确定|unknown|由你判断|采用系统建议)$/iu.test(value);
const requestsProposalFirst = (value: string): boolean => /先.{0,4}(?:方案|建议|分析)|你先决定|按默认/iu.test(value);
const isNoComparison = (value: string): boolean => /不比较|无需比较|没有比较/iu.test(value);
const isAffirmative = (value: string): boolean => /^(?:是|需要|要|启用|分析|yes|true)$/iu.test(value) || /时间|趋势/iu.test(value);
const questionHash = (value: string): string => createHash('sha256').update(value.trim()).digest('hex');
const unique = <T>(values: T[]): T[] => [...new Set(values)];
