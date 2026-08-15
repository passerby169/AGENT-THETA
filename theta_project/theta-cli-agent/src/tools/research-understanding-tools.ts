import { hashCanonicalJson, type JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { ThetaConversationEventRepository } from '../messages/message-event-store.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { emptyResearchWorkspace } from '../workspaces/factories.js';
import type {
  AgentAssumption,
  AgentContradiction,
  AgentDecisionRecord,
  AgentOpenQuestion,
  ResearchBoundary,
  ResearchStatement,
  ResearchWorkspace,
  UserPreference,
  WorkspaceSourceRef,
} from '../workspaces/contracts.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

interface ResearchUpdateInput {
  sourceMessageIds: string[];
  narrative: string;
  statements?: Array<{ semanticLabel: string; statement: string; importance: ResearchStatement['importance']; confidence: number }>;
  questions?: Array<{ question: string; whyItMatters: string; blocking: boolean }>;
  answeredQuestionIds?: string[];
  assumptions?: Array<{ statement: string }>;
  decisions?: Array<{ decision: string; rationale: string }>;
  preferences?: string[];
  boundaries?: string[];
  contradictions?: Array<{ statementRefs: string[]; description: string }>;
  resolvedContradictionIds?: string[];
}

const updateInputSchema: JsonSchema = {
  type: 'object',
  required: ['sourceMessageIds', 'narrative'],
  properties: {
    sourceMessageIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    narrative: { type: 'string', minLength: 1, maxLength: 16_000 },
    statements: { type: 'array', maxItems: 30, items: { type: 'object', required: ['semanticLabel', 'statement', 'importance', 'confidence'], properties: { semanticLabel: { type: 'string' }, statement: { type: 'string' }, importance: { enum: ['blocking', 'important', 'optional'] }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false } },
    questions: { type: 'array', maxItems: 10, items: { type: 'object', required: ['question', 'whyItMatters', 'blocking'], properties: { question: { type: 'string' }, whyItMatters: { type: 'string' }, blocking: { type: 'boolean' } }, additionalProperties: false } },
    answeredQuestionIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    assumptions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['statement'], properties: { statement: { type: 'string' } }, additionalProperties: false } },
    decisions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['decision', 'rationale'], properties: { decision: { type: 'string' }, rationale: { type: 'string' } }, additionalProperties: false } },
    preferences: { type: 'array', maxItems: 20, items: { type: 'string' } },
    boundaries: { type: 'array', maxItems: 20, items: { type: 'string' } },
    contradictions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['statementRefs', 'description'], properties: { statementRefs: { type: 'array', items: { type: 'string' } }, description: { type: 'string' } }, additionalProperties: false } },
    resolvedContradictionIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const thetaResearchReadWorkspaceToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.researchReadWorkspace,
  version: '1.0.0',
  displayName: 'Read current research understanding',
  description: 'Read the current ResearchWorkspace and its unresolved questions. Use this before deciding what the user still needs to clarify.',
  tags: ['theta', 'research', 'memory', 'v7'],
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.researchRead],
  source: 'local',
};

export const thetaResearchReadWorkspaceHandler: ToolHandler<unknown, Record<string, unknown>> = async (_raw, context) => {
  const runtime = await createThetaRuntimeComposition(runtimeDbFrom(context));
  try {
    const workspace = await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'research');
    if (!workspace || workspace.workspaceType !== 'research') throw new Error('ResearchWorkspace was not found.');
    return structuredClone(workspace) as unknown as Record<string, unknown>;
  } finally {
    await runtime.close();
  }
};

export const thetaResearchUpdateUnderstandingToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.researchUpdateUnderstanding,
  version: '1.0.0',
  displayName: 'Update research understanding',
  description: 'Revise the open ResearchWorkspace from one or more actual user messages. A single rich answer may update several research ideas at once; this is not a fixed form.',
  tags: ['theta', 'research', 'workspace', 'v7'],
  inputSchema: updateInputSchema,
  outputSchema: {
    type: 'object',
    required: ['workspaceRef', 'workspaceHash', 'revision', 'openQuestions', 'blockingOpenQuestions'],
    properties: {
      workspaceRef: { type: 'string' },
      workspaceHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      revision: { type: 'integer', minimum: 1 },
      openQuestions: { type: 'integer', minimum: 0 },
      blockingOpenQuestions: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.researchWrite],
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: false, includeOutput: true },
  source: 'local',
};

export const thetaResearchUpdateUnderstandingHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = raw as ResearchUpdateInput;
  const runtime = await createThetaRuntimeComposition(runtimeDbFrom(context));
  try {
    const messages = new ThetaConversationEventRepository(runtime.eventBridge);
    const sources = await Promise.all(input.sourceMessageIds.map((messageId) => messages.require(context.runId, messageId)));
    const userId = context.userId ?? context.principal?.userId ?? 'local_user';
    if (sources.some((source) => source.role !== 'user' || source.userId !== userId)) {
      throw new Error('Research updates must cite messages from the current user.');
    }
    const repository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
    const current = await repository.current(context.runId, 'research');
    if (!current || current.workspaceType !== 'research') throw new Error('ResearchWorkspace was not found.');
    const refs = sources.map((source) => `message-ref:${source.messageId}`);
    const sourceRefs: WorkspaceSourceRef[] = sources.map((source, index) => ({
      id: refs[index], kind: 'user_message', hash: source.contentHash,
    }));
    const draft = mergeResearch(current, input, refs, sourceRefs);
    const revised = await repository.revise({
      runId: context.runId,
      sessionId: context.sessionId,
      userId,
      expectedRevision: current.revision,
      draft,
      reason: `THETA Agent updated research understanding from ${input.sourceMessageIds.join(', ')}.`,
      invalidates: ['checkpoint', 'plan', 'approval', 'dry_run', 'training_approval'],
    });
    if (revised.workspaceType !== 'research') throw new Error('ResearchWorkspace revision returned the wrong type.');
    const open = revised.questions.filter((question) => question.status === 'open');
    return {
      workspaceRef: `workspace:research:${revised.revision}`,
      workspaceHash: revised.workspaceHash,
      revision: revised.revision,
      openQuestions: open.length,
      blockingOpenQuestions: open.filter((question) => question.blocking).length,
    };
  } finally {
    await runtime.close();
  }
};

const mergeResearch = (
  current: ResearchWorkspace,
  input: ResearchUpdateInput,
  refs: string[],
  sourceRefs: WorkspaceSourceRef[],
) => {
  const key = (value: unknown) => hashCanonicalJson(value).slice(-16);
  const statements: ResearchStatement[] = mergeByText(
    current.statements,
    (input.statements ?? []).map((value) => ({
      id: `research-statement:${key(value)}`,
      ...value,
      epistemicStatus: 'user_stated' as const,
      sourceRefs: refs,
    })),
    (value) => value.statement,
  );
  const answered = new Set(input.answeredQuestionIds ?? []);
  const existingQuestions = current.questions.map((question) =>
    answered.has(question.id) ? { ...question, status: 'answered' as const, sourceRefs: unique([...question.sourceRefs, ...refs]) } : question);
  const questions: AgentOpenQuestion[] = mergeByText(
    existingQuestions,
    (input.questions ?? []).map((value) => ({ id: `research-question:${key(value)}`, ...value, status: 'open' as const, sourceRefs: refs })),
    (value) => value.question,
  );
  const assumptions: AgentAssumption[] = mergeByText(
    current.assumptions,
    (input.assumptions ?? []).map((value) => ({ id: `research-assumption:${key(value)}`, statement: value.statement, status: 'proposed' as const, sourceRefs: refs })),
    (value) => value.statement,
  );
  const decisions: AgentDecisionRecord[] = mergeByText(
    current.decisions,
    (input.decisions ?? []).map((value) => ({ id: `research-decision:${key(value)}`, ...value, status: 'proposed' as const, sourceRefs: refs })),
    (value) => value.decision,
  );
  const preferences: UserPreference[] = mergeByText(
    current.preferences,
    (input.preferences ?? []).map((preference) => ({ id: `research-preference:${key(preference)}`, preference, sourceRefs: refs })),
    (value) => value.preference,
  );
  const boundaries: ResearchBoundary[] = mergeByText(
    current.boundaries,
    (input.boundaries ?? []).map((boundary) => ({ id: `research-boundary:${key(boundary)}`, boundary, sourceRefs: refs })),
    (value) => value.boundary,
  );
  const resolvedContradictions = new Set(input.resolvedContradictionIds ?? []);
  const existingContradictions = current.contradictions.map((contradiction) =>
    resolvedContradictions.has(contradiction.id)
      ? { ...contradiction, status: 'resolved' as const }
      : contradiction);
  const contradictions: AgentContradiction[] = mergeByText(
    existingContradictions,
    (input.contradictions ?? []).map((value) => ({ id: `research-contradiction:${key(value)}`, ...value, status: 'open' as const })),
    (value) => value.description,
  );
  return {
    ...emptyResearchWorkspace(current.runId, current.datasetHash),
    narrative: input.narrative.trim(),
    statements,
    questions,
    assumptions,
    contradictions,
    decisions,
    preferences,
    boundaries,
    sourceRefs: mergeByText(current.sourceRefs, sourceRefs, (value) => value.id),
  };
};

const mergeByText = <T>(current: T[], additions: T[], text: (value: T) => string): T[] => {
  const values = new Map(current.map((value) => [text(value).trim().toLowerCase(), structuredClone(value)]));
  for (const value of additions) values.set(text(value).trim().toLowerCase(), structuredClone(value));
  return [...values.values()];
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const runtimeDbFrom = (context: ToolCallContext): string =>
  typeof context.metadata?.thetaRuntimeDb === 'string' ? context.metadata.thetaRuntimeDb : defaultThetaV6RuntimeDb();
