import type { InferenceRequest, InferenceResponse, InferenceToolDescriptor } from '@hypha/inference';
import {
  BasicReActAgentRuntime,
  type ReActAction,
  type ReActAgentRuntime,
  type ReActObservation,
  type ReActRunContext,
} from '@hypha/kernel';
import type { ToolRegistry } from '@hypha/tools';
import { validateThetaAgentAction } from './contracts.js';
import { openAiToolFunctionName } from '../providers/openai-tool-name.js';
import { isThetaPhaseOutcome } from './contracts.js';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { THETA_TOOL_IDS } from '../tools/tool-ids.js';
import { ThetaPlannerEventRepository } from '../planner-v3/event-store.js';
import { ThetaActivityEventRepository } from '../activities/activity-event-store.js';
import { toolActivityCopy } from '../activities/activity-copy.js';

const FINISH_PHASE_FUNCTION = 'theta_finish_phase';
const REQUEST_INTAKE_QUESTION_FUNCTION = 'theta_request_intake_question';
const REQUEST_RESEARCH_QUESTION_FUNCTION = 'theta_request_research_question';

export class ThetaReActAgentRuntime implements ReActAgentRuntime {
  private readonly base = new BasicReActAgentRuntime();
  private readonly toolIdByFunctionName: ReadonlyMap<string, string>;
  private currentContext?: ReActRunContext;

  constructor(private readonly registry: ToolRegistry) {
    const entries = registry.list().map((tool) => [openAiToolFunctionName(tool.id), tool.id] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new Error('Tool ids collide after conversion to MiniMax-compatible function names.');
    }
    this.toolIdByFunctionName = new Map(entries);
  }

  async reason(context: ReActRunContext): Promise<InferenceRequest> {
    this.currentContext = context;
    await this.recordThinking('running');
    const request = await this.base.reason(context);
    const allowed = new Set(context.toolExecutionScope?.allowedToolIds ?? context.agent.toolRefs ?? []);
    return {
      ...request,
      tools: [...this.registry
        .list()
        .filter((tool) => allowed.has(tool.id) && tool.id !== THETA_TOOL_IDS.agentProtocolFeedback)
        .map<InferenceToolDescriptor>((tool) => ({
          id: tool.id,
          name: openAiToolFunctionName(tool.id),
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
        ...(context.metadata?.phase === 'Intake' ? [intakeQuestionDescriptor()] : []),
        ...(context.metadata?.phase === 'ResearchDialogue' ? [researchQuestionDescriptor()] : []),
        finishPhaseDescriptor(typeof context.metadata?.phase === 'string' ? context.metadata.phase : undefined)],
      options: {
        ...request.options,
        responseFormat: 'json_object',
        extra: { ...request.options?.extra, toolChoice: 'required' },
      },
    };
  }

  async selectAction(response: InferenceResponse): Promise<ReActAction> {
    await this.recordThinking('completed');
    const selected = await this.base.selectAction(response);
    if (selected.type === 'tool' && selected.target === FINISH_PHASE_FUNCTION) {
      const normalizedInput = normalizeFinishInput(selected.input);
      let finish: ReActAction;
      try {
        finish = validateThetaAgentAction({ type: 'finish', input: normalizedInput });
      } catch (error) {
        const priorRepairs = this.currentContext?.messages.filter((message) => message.name === THETA_TOOL_IDS.agentProtocolFeedback).length ?? 0;
        if (priorRepairs >= 2) {
          throw new Error(`THETA finish action remained invalid after two bounded protocol repairs. ${error instanceof Error ? error.message : String(error)} Payload: ${JSON.stringify(normalizedInput)}`);
        }
        return {
          type: 'tool',
          target: THETA_TOOL_IDS.agentProtocolFeedback,
          input: {
            phase: String(this.currentContext?.metadata?.phase ?? 'unknown'),
            code: 'INVALID_PHASE_ACTION',
            message: error instanceof Error ? error.message : String(error),
            invalidOutput: normalizedInput && typeof normalizedInput === 'object' && !Array.isArray(normalizedInput)
              ? normalizedInput as Record<string, unknown>
              : { value: normalizedInput ?? null },
          },
          ...(selected.toolCallId === undefined ? {} : { toolCallId: selected.toolCallId }),
          reason: 'The native phase action violated the strict contract and must be repaired before the FSM can evaluate it.',
        };
      }
      if (await this.researchCompletionRequiresRevision(finish.input)) {
        return validateThetaAgentAction({
          type: 'tool',
          target: THETA_TOOL_IDS.researchReadWorkspace,
          input: {},
          ...(selected.toolCallId === undefined ? {} : { toolCallId: selected.toolCallId }),
          reason: 'FSM preflight rejected phase completion. Read the current workspace, close only items actually resolved by evidence, then propose completion again.',
        });
      }
      const planFeedback = await this.planCompletionFeedback(finish.input);
      if (planFeedback) {
        return validateThetaAgentAction({
          type: 'tool',
          target: THETA_TOOL_IDS.agentProtocolFeedback,
          input: planFeedback,
          ...(selected.toolCallId === undefined ? {} : { toolCallId: selected.toolCallId }),
          reason: 'FSM preflight rejected the PlanDesign completion binding and returned the exact governed binding required for a corrected Agent action.',
        });
      }
      return finish;
    }
    if (selected.type === 'tool' && selected.target === REQUEST_RESEARCH_QUESTION_FUNCTION) {
      return validateThetaAgentAction({
        type: 'human_review',
        input: { purpose: 'research_question', ...(selected.input as Record<string, unknown>) },
        reason: typeof (selected.input as Record<string, unknown>)?.whyItMatters === 'string'
          ? String((selected.input as Record<string, unknown>).whyItMatters)
          : undefined,
      });
    }
    if (selected.type === 'tool' && selected.target === REQUEST_INTAKE_QUESTION_FUNCTION) {
      return validateThetaAgentAction({
        type: 'human_review',
        input: { purpose: 'intake_question', ...(selected.input as Record<string, unknown>) },
        reason: typeof (selected.input as Record<string, unknown>)?.whyItMatters === 'string'
          ? String((selected.input as Record<string, unknown>).whyItMatters)
          : undefined,
      });
    }
    const target = selected.target === undefined
      ? undefined
      : this.toolIdByFunctionName.get(selected.target) ?? selected.target;
    const mapped = {
      ...selected,
      ...(target === undefined ? {} : { target }),
    };
    try {
      const action = validateThetaAgentAction(mapped);
      if (action.type === 'tool' && action.target) await this.recordToolStarted(action);
      return action;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Selected action: ${JSON.stringify(mapped)}`,
      );
    }
  }

  async verify(context: ReActRunContext, observation: ReActObservation): Promise<ReActAction> {
    if (observation.source === 'tool') return { type: 'model', input: observation.value };
    return validateThetaAgentAction(await this.base.verify(context, observation));
  }

  private async researchCompletionRequiresRevision(value: unknown): Promise<boolean> {
    if (
      !isThetaPhaseOutcome(value) ||
      value.kind !== 'phase_completion_proposed' ||
      value.phase !== 'ResearchDialogue'
    ) return false;
    const context = this.currentContext;
    if (!context) throw new Error('Research completion preflight has no active ReAct context.');
    const runtimeDb = typeof context.metadata?.thetaRuntimeDb === 'string'
      ? context.metadata.thetaRuntimeDb
      : defaultThetaV6RuntimeDb();
    const runtime = await createThetaRuntimeComposition(runtimeDb);
    try {
      const workspace = await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'research');
      return workspace?.workspaceType !== 'research' ||
        workspace.workspaceHash !== value.artifactHash ||
        workspace.questions.some((question) => question.status === 'open' && question.blocking) ||
        workspace.contradictions.some((contradiction) => contradiction.status === 'open');
    } finally {
      await runtime.close();
    }
  }

  private async planCompletionFeedback(value: unknown): Promise<Record<string, unknown> | undefined> {
    if (
      !isThetaPhaseOutcome(value) ||
      value.kind !== 'phase_completion_proposed' ||
      value.phase !== 'PlanDesign'
    ) return undefined;
    const context = this.currentContext;
    if (!context) throw new Error('Plan completion preflight has no active ReAct context.');
    const runtimeDb = typeof context.metadata?.thetaRuntimeDb === 'string'
      ? context.metadata.thetaRuntimeDb
      : defaultThetaV6RuntimeDb();
    const runtime = await createThetaRuntimeComposition(runtimeDb);
    try {
      const workspace = await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'plan');
      if (workspace?.workspaceType !== 'plan' || !workspace.activeCandidateRef) {
        return {
          phase: 'PlanDesign',
          code: 'PLAN_WORKSPACE_NOT_READY',
          message: 'PlanDesign cannot finish because there is no active PlanWorkspace candidate. Continue using governed planning tools.',
          invalidOutput: value as unknown as Record<string, unknown>,
        };
      }
      const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
      const candidate = await planner.candidate(context.runId, workspace.activeCandidateRef);
      if (!candidate) {
        return {
          phase: 'PlanDesign',
          code: 'ACTIVE_CANDIDATE_NOT_FOUND',
          message: 'The active PlanWorkspace candidate cannot be resolved. Read the current candidate and continue planning.',
          invalidOutput: value as unknown as Record<string, unknown>,
        };
      }
      const evidence = await planner.evidenceReceipt(context.runId, candidate.candidatePlanHash);
      const validation = await planner.validationReceipt(context.runId, candidate.candidatePlanHash);
      const receiptsInvalid = !evidence || !validation?.valid ||
        evidence.candidatePlanHash !== candidate.candidatePlanHash ||
        validation.candidatePlanHash !== candidate.candidatePlanHash ||
        validation.evidenceBundleHash !== evidence.evidenceBundleHash;
      const requiredArtifactRef = `workspace:plan:${workspace.revision}`;
      const bindingInvalid = value.artifactRef !== requiredArtifactRef ||
        value.artifactHash !== workspace.workspaceHash || value.checkpointDecision !== 'request';
      if (!receiptsInvalid && !bindingInvalid) return undefined;
      return {
        phase: 'PlanDesign',
        code: receiptsInvalid ? 'PLAN_RECEIPTS_NOT_READY' : 'PLAN_COMPLETION_BINDING_MISMATCH',
        message: receiptsInvalid
          ? 'PlanDesign cannot finish until the active candidate has an optional-citation audit receipt (an empty set is legal) and a valid PlanValidationReceipt for the same candidate hash.'
          : `Your completion payload used the wrong plan artifact binding. Resubmit theta_finish_phase yourself with artifactRef=${requiredArtifactRef}, artifactHash=${workspace.workspaceHash}, checkpointDecision=request. Do not use candidatePlanHash (${candidate.candidatePlanHash}) as artifactHash.`,
        invalidOutput: {
          received: value as unknown as Record<string, unknown>,
          required: {
            artifactRef: requiredArtifactRef,
            artifactHash: workspace.workspaceHash,
            checkpointDecision: 'request',
            activeCandidateRef: candidate.candidateRef,
            candidatePlanHash: candidate.candidatePlanHash,
          },
        },
      };
    } finally {
      await runtime.close();
    }
  }

  private async recordThinking(status: 'running' | 'completed'): Promise<void> {
    const context = this.currentContext;
    if (!context) return;
    const identity = activityIdentity(context);
    const runtime = await createThetaRuntimeComposition(identity.runtimeDb);
    try {
      await new ThetaActivityEventRepository(runtime.eventBridge).record({
        runId: context.runId,
        sessionId: identity.sessionId,
        userId: identity.userId,
        activityId: `thinking:${context.runId}:${context.stepId}:${context.messages.length}`,
        phase: identity.phase,
        kind: 'thinking',
        displayName: 'MiniMax 决策',
        userMessage: status === 'running' ? 'MiniMax 正在判断下一步行动' : 'MiniMax 已完成下一步工具决策',
        status,
        ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      });
    } finally {
      await runtime.close();
    }
  }

  private async recordToolStarted(action: ReActAction): Promise<void> {
    if (action.type !== 'tool' || !action.target) return;
    const context = this.currentContext;
    if (!context) return;
    const identity = activityIdentity(context);
    const runtime = await createThetaRuntimeComposition(identity.runtimeDb);
    try {
      const copy = toolActivityCopy(action.target, this.registry.getSpec(action.target)?.displayName);
      await new ThetaActivityEventRepository(runtime.eventBridge).record({
        runId: context.runId,
        sessionId: identity.sessionId,
        userId: identity.userId,
        activityId: toolActivityId(context.runId, context.stepId, action),
        phase: identity.phase,
        kind: 'tool_started',
        toolId: action.target,
        displayName: copy.displayName,
        userMessage: copy.running,
        status: 'running',
        safeInputSummary: safeToolInputSummary(action.target, action.input),
      });
    } finally {
      await runtime.close();
    }
  }
}

const activityIdentity = (context: ReActRunContext): { runtimeDb: string; sessionId: string; userId: string; phase: string } => ({
  runtimeDb: typeof context.metadata?.thetaRuntimeDb === 'string' ? context.metadata.thetaRuntimeDb : defaultThetaV6RuntimeDb(),
  sessionId: context.memoryScope?.sessionId ?? `session:${context.runId}`,
  userId: context.memoryScope?.userId ?? 'local_user',
  phase: typeof context.metadata?.phase === 'string' ? context.metadata.phase : 'unknown',
});

const toolActivityId = (runId: string, stepId: string, action: ReActAction): string =>
  `tool:${runId}:${stepId}:${action.type === 'tool' ? action.toolCallId ?? action.target : 'unknown'}`;

const safeToolInputSummary = (toolId: string, input: unknown): string => {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (typeof value.modelId === 'string') return `模型：${value.modelId}`;
  if (Array.isArray(value.modelIds)) return `模型：${value.modelIds.map(String).join('、')}`;
  if (typeof value.candidateRef === 'string') return `候选：${value.candidateRef}`;
  if (typeof value.column === 'string') return `列：${value.column}`;
  if (toolId === THETA_TOOL_IDS.datasetRequestUpload) return `原因：${String(value.reason ?? '需要研究数据')}`;
  if (toolId === THETA_TOOL_IDS.datasetIngestAttachment && typeof value.attachmentRef === 'string') return `附件：${value.attachmentRef}`;
  if (toolId === THETA_TOOL_IDS.datasetSample) return '最多 10 条已授权脱敏样本';
  return '输入已按隐私策略隐藏';
};

const finishPhaseDescriptor = (phase?: string): InferenceToolDescriptor => ({
  id: FINISH_PHASE_FUNCTION,
  name: FINISH_PHASE_FUNCTION,
  description: 'Propose completion of the current intelligent phase. This is not a business-state transition; the FSM independently validates the artifact hash and guard.',
  inputSchema: {
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'phase', 'artifactRef', 'artifactHash', 'rationale', 'confidence', 'checkpointDecision'],
        properties: {
          kind: { const: 'phase_completion_proposed' },
          phase: { enum: ['Intake', 'DatasetDiscovery', 'ResearchDialogue', 'PlanDesign'] },
          artifactRef: { type: 'string', minLength: 1 },
          artifactHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          rationale: { type: 'string', minLength: 1, maxLength: 2000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          checkpointDecision: {
            enum: phase === 'Intake' ? ['skip'] : ['request'],
            description: phase === 'Intake'
              ? 'Intake hands off after governed ingestion.'
              : 'Dataset, research and plan final confirmation boundaries are mandatory and owned by the FSM.',
          },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['kind', 'targetPhase', 'reason'],
        properties: {
          kind: { const: 'return_to_phase_requested' },
          targetPhase: { enum: ['DatasetDiscovery', 'ResearchDialogue', 'PlanDesign'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['kind', 'reason'],
        properties: {
          kind: { const: 'phase_blocked' },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
          requiredUserDecision: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['kind', 'action', 'responseToUser'],
        properties: {
          kind: { const: 'plan_confirmation_decision' },
          action: { enum: ['ask_about_checkpoint', 'revise_checkpoint', 'confirm_checkpoint', 'reject_checkpoint', 'return_to_phase'] },
          responseToUser: { type: 'string', minLength: 1, maxLength: 4000 },
          question: { type: 'string', minLength: 1, maxLength: 2000 },
          requestedChanges: { type: 'string', minLength: 1, maxLength: 4000 },
          targetHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
          phase: { const: 'PlanDesign' },
        },
        additionalProperties: false,
      },
    ],
  },
});

const researchQuestionDescriptor = (): InferenceToolDescriptor => ({
  id: REQUEST_RESEARCH_QUESTION_FUNCTION,
  name: REQUEST_RESEARCH_QUESTION_FUNCTION,
  description: 'Ask the user one consequential, dataset-grounded research question and pause the current ResearchDialogue turn.',
  inputSchema: {
    type: 'object',
    required: ['question', 'whyItMatters'],
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000 },
      whyItMatters: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    additionalProperties: false,
  },
});

const intakeQuestionDescriptor = (): InferenceToolDescriptor => ({
  id: REQUEST_INTAKE_QUESTION_FUNCTION,
  name: REQUEST_INTAKE_QUESTION_FUNCTION,
  description: 'Continue the natural Intake conversation with the user. Use this to introduce THETA, explain how collaboration works, answer uncertainty, or ask one open next-step question without forcing a dataset upload.',
  inputSchema: {
    type: 'object',
    required: ['message', 'question', 'whyItMatters'],
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 4000 },
      question: { type: 'string', minLength: 1, maxLength: 2000 },
      whyItMatters: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    additionalProperties: false,
  },
});

const normalizeFinishInput = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const candidate = { ...(value as Record<string, unknown>) };
  if (candidate.kind === 'phase_completion_proposed' && typeof candidate.confidence === 'string') {
    const parsed = Number(candidate.confidence);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) candidate.confidence = parsed;
  }
  return candidate;
};
