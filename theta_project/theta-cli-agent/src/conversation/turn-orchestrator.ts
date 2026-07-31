import { createHash, randomUUID } from 'node:crypto';
import {
  researchBriefSchema,
  type InformationGap,
  type PlannedQuestion,
} from '../agent/research-contracts.js';
import { ResearchBriefMerger } from '../agent/research-brief-merger.js';
import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
} from '../theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowConversationContext,
} from '../theta-workflow-service.js';
import { ThetaNaturalLanguageService } from '../language/natural-service.js';
import { guardCriticalResearchPatch } from '../language/research-answer-guards.js';
import { sanitizeLanguageText } from '../language/sanitizer.js';
import {
  NATURAL_LANGUAGE_CONTRACT_VERSION,
  naturalLanguageResultSchema,
  type NaturalLanguageRequest,
  type NaturalLanguageResult,
} from './natural-contracts.js';
import type {
  ConversationMessage,
  ConversationStore,
} from './message-store.js';
import type { ConversationCommand } from './contracts.js';
import {
  runApprovedThetaConversationLanguage,
  runThetaModelCatalog,
  runThetaRagSearch,
} from '../tools/hypha-runner.js';
import { ThetaConversationWorkflowExecutor } from './workflow-executor.js';

export interface TurnContext {
  sessionId: string;
  activeRunId?: string;
  runtimeDb: string;
}

export interface TurnResult {
  value: unknown;
  activeRunId?: string;
}

export class ThetaTurnOrchestrator {
  private readonly merger = new ResearchBriefMerger();

  constructor(
    private readonly store: ConversationStore,
    private readonly workflow = new ThetaWorkflowService(),
    private readonly deterministicLanguage = new ThetaNaturalLanguageService(),
    private readonly deterministicExecutor = new ThetaConversationWorkflowExecutor(
      workflow,
    ),
  ) {}

  async execute(
    command: ConversationCommand,
    context: TurnContext,
  ): Promise<TurnResult> {
    const session = this.store.getOrCreateSession(context.sessionId, {
      activeRunId: context.activeRunId,
    });
    const activeRunId = context.activeRunId ?? session.activeRunId;

    if (command.kind === 'llm') {
      const updated = this.store.updateSession(context.sessionId, {
        languageConsent: command.enabled,
        providerMode: command.enabled ? 'minimax' : 'deterministic',
      });
      return {
        value: {
          kind: 'language.consent',
          enabled: updated.languageConsent,
          providerMode: updated.providerMode,
          scope: [
            'interpret_research_answer',
            'generate_grilling_question',
            'interpret_column_confirmation',
            'classify_conversation_intent',
            'propose_readonly_tool',
            'compose_grounded_response',
          ],
          trainingApprovalGranted: false,
        },
        activeRunId,
      };
    }
    if (command.kind === 'history') {
      const messages = this.store.listRecentMessages(context.sessionId, 100);
      const recoverableTurns = this.store.listRecoverableTurns(context.sessionId);
      return {
        value: {
          kind: 'conversation.history',
          sessionId: context.sessionId,
          messages: activeRunId
            ? messages.filter((message) => message.runId === activeRunId)
            : messages,
          recoverableTurns: activeRunId
            ? recoverableTurns.filter((turn) => turn.runId === activeRunId)
            : recoverableTurns,
        },
        activeRunId,
      };
    }
    if (command.kind === 'brief') {
      const runId = requiredRun(activeRunId);
      const workflowContext = await this.workflow.conversationContext(
        runId,
        context.runtimeDb,
      );
      return {
        value: {
          kind: 'research.brief',
          current: workflowContext.researchBrief,
          currentState: workflowContext.status.currentState,
          status: workflowContext.status.status,
          revisions: this.store.listBriefRevisions(runId),
        },
        activeRunId: runId,
      };
    }
    if (command.kind === 'done') {
      return this.finishResearchInterview({
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'adjust') {
      return this.adjustPlan(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'answer') {
      return this.answer(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'columns') {
      return this.columns(command.text, {
        ...context,
        activeRunId: requiredRun(activeRunId),
      });
    }
    if (command.kind === 'natural') {
      if (activeRunId) {
        const current = await this.workflow.conversationContext(
          activeRunId,
          context.runtimeDb,
        );
        if (
          current.status.pendingActionRef ===
          THETA_APPROVAL_KEYS.researchClarification
        ) {
          return this.answer(command.text, { ...context, activeRunId });
        }
        if (
          current.status.pendingActionRef ===
          THETA_APPROVAL_KEYS.columnConfirmation
        ) {
          return this.columns(command.text, { ...context, activeRunId });
        }
      }
      return this.freeText(command.text, { ...context, activeRunId });
    }

    const result = await this.deterministicExecutor.execute(command, {
      activeRunId,
      runtimeDb: context.runtimeDb,
    });
    if (result.activeRunId) {
      this.store.updateSession(context.sessionId, {
        activeRunId: result.activeRunId,
      });
    }
    return result;
  }

  private async answer(text: string, context: TurnContext): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !==
      THETA_APPROVAL_KEYS.researchClarification
    ) {
      throw new Error('The active Run is not waiting for a research answer.');
    }
    const brief = researchBriefSchema.parse(current.researchBrief);
    const { gap, question } = activeResearchQuestion(current);
    const message = this.userMessage(context, runId, 'research.answer', text);
    const turn = this.startTurn(context, runId, message);
    try {
      const language = await this.language(
        {
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
          task: 'interpret_research_answer',
          gapId: gap.id,
          field: gap.field,
          question: question.question,
          answer: text,
          currentBrief: brief,
          nextGapCandidates: researchGapCandidates(current, gap.id),
          recentMessages: recent(this.store, context.sessionId, runId),
        },
        context.sessionId,
        runId,
        message.messageId,
      );
      this.store.updateTurn(turn.turnId, 'interpreted');
      if (language.output.task !== 'interpret_research_answer') {
        throw new Error('Unexpected language result for research answer.');
      }
      const guarded = guardCriticalResearchPatch(
        gap.field,
        text,
        language.output.patch,
      );
      const merged = this.merger.merge(brief, guarded.patch);
      if (merged.changedFields.length === 0) {
        const response = `${language.output.explanation} 请补充回答：${question.question}`;
        this.assistantMessage(
          context,
          runId,
          'research.clarification',
          response,
        );
        this.store.updateTurn(turn.turnId, 'responded');
        return {
          value: {
            kind: 'research.answer.unresolved',
            explanation: language.output.explanation,
            activeQuestion: question.question,
          },
          activeRunId: runId,
        };
      }
      const parent = this.store.getLatestBrief(runId);
      this.store.appendBriefRevision({
        revisionId: `brief.${randomUUID()}`,
        runId,
        sessionId: context.sessionId,
        ...(parent ? { parentRevisionId: parent.revisionId } : {}),
        sourceMessageId: message.messageId,
        patch: merged.patch,
        brief: merged.brief,
        briefHash: merged.briefHash,
        interpretationHash: language.factsHash,
        createdAt: new Date().toISOString(),
      });
      this.store.updateTurn(turn.turnId, 'brief_applied');
      const resumed = await this.workflow.resume({
        runId,
        runtimeDb: context.runtimeDb,
        researchAnswers: merged.patch as Record<string, unknown>,
        approvedBy: 'local_user',
      });
      this.store.updateTurn(turn.turnId, 'fsm_resumed');
      const next = await this.workflow.conversationContext(
        runId,
        context.runtimeDb,
      );
      const nextQuestion = this.questionAfterAnswer(
        next,
        language.output.questionSuggestions,
      );
      const response = [
        `已记录：${merged.changedFields.map(researchFieldLabel).join('、')}。`,
        guarded.correctedFields.length > 0
          ? `我按你的明确表述校正了${guarded.correctedFields
              .map(researchFieldLabel)
              .join('、')}，避免模型误读否定句。`
          : '',
        merged.conflictingFields.length > 0
          ? `本次回答更新了之前的${merged.conflictingFields
              .map(researchFieldLabel)
              .join('、')}。`
          : '',
        nextQuestion,
      ]
        .filter(Boolean)
        .join(' ');
      this.assistantMessage(context, runId, 'research.progress', response);
      this.store.updateTurn(turn.turnId, 'responded');
      return {
        value: {
          kind: 'research.answer.applied',
          patch: merged.patch,
          changedFields: merged.changedFields,
          conflictingFields: merged.conflictingFields,
          briefHash: merged.briefHash,
          workflow: resumed,
          languageTelemetry: language.telemetry,
          response,
        },
        activeRunId: runId,
      };
    } catch (error) {
      this.store.updateTurn(turn.turnId, 'failed', errorRecord(error));
      throw error;
    }
  }

  private async finishResearchInterview(
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !==
      THETA_APPROVAL_KEYS.researchClarification
    ) {
      throw new Error('当前没有可以结束的研究访谈。');
    }
    const brief = researchBriefSchema.parse(current.researchBrief);
    const blocking = Array.isArray(current.researchAssessment?.gaps)
      ? current.researchAssessment.gaps
          .map(safeGap)
          .filter(
            (item): item is InformationGap =>
              item !== undefined && item.severity === 'blocking',
          )
      : [];
    if (blocking.length > 0) {
      throw new Error(
        `还有 ${blocking.length} 项必填信息未确认，暂时不能结束访谈。`,
      );
    }
    const message = this.userMessage(
      context,
      runId,
      'research.interview.done',
      '结束扩展访谈并开始分析',
    );
    const merged = this.merger.merge(brief, { interviewComplete: true });
    const parent = this.store.getLatestBrief(runId);
    this.store.appendBriefRevision({
      revisionId: `brief.${randomUUID()}`,
      runId,
      sessionId: context.sessionId,
      ...(parent ? { parentRevisionId: parent.revisionId } : {}),
      sourceMessageId: message.messageId,
      patch: merged.patch,
      brief: merged.brief,
      briefHash: merged.briefHash,
      interpretationHash: hash({ command: 'done', runId }),
      createdAt: new Date().toISOString(),
    });
    const resumed = await this.workflow.resume({
      runId,
      runtimeDb: context.runtimeDb,
      researchAnswers: { interviewComplete: true },
      approvedBy: 'local_user',
    });
    const response =
      '扩展研究访谈已结束。系统会保留已确认的信息，并开始检查数据集。';
    this.assistantMessage(
      context,
      runId,
      'research.interview.completed',
      response,
    );
    return {
      value: {
        kind: 'research.answer.applied',
        changedFields: ['interviewComplete'],
        patch: { interviewComplete: true },
        workflow: resumed,
        response,
      },
      activeRunId: runId,
    };
  }

  private async adjustPlan(
    text: string,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.status(runId, context.runtimeDb);
    if (current.pendingActionRef !== THETA_APPROVAL_KEYS.planReview) {
      throw new Error('只有在训练方案审批阶段才能调整模型或参数。');
    }
    const adjustment = parsePlanAdjustment(text);
    const message = this.userMessage(
      context,
      runId,
      'plan.adjustment',
      text,
    );
    const resumed = await this.workflow.resume({
      runId,
      runtimeDb: context.runtimeDb,
      planAdjustment: adjustment,
    });
    const changed = Object.entries(adjustment)
      .map(([field, value]) => `${planFieldLabel(field)}=${String(value)}`)
      .join('，');
    const response = `已应用方案调整：${changed}。系统已重新验证候选计划，旧的待审批方案不会被直接复用。`;
    this.assistantMessage(context, runId, 'plan.adjusted', response);
    return {
      value: {
        kind: 'plan.adjusted',
        adjustment,
        sourceMessageId: message.messageId,
        workflow: resumed,
        response,
      },
      activeRunId: runId,
    };
  }

  private async columns(
    text: string,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = requiredRun(context.activeRunId);
    const current = await this.workflow.conversationContext(
      runId,
      context.runtimeDb,
    );
    if (
      current.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.columnConfirmation ||
      !current.datasetProfile
    ) {
      throw new Error('The active Run is not waiting for column confirmation.');
    }
    const profile = current.datasetProfile;
    const message = this.userMessage(context, runId, 'columns.answer', text);
    const turn = this.startTurn(context, runId, message);
    try {
      const language = await this.language(
        {
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
          task: 'interpret_column_confirmation',
          answer: text,
          datasetSha256: profile.datasetSha256,
          columns: profile.columns,
          candidates: {
            text: profile.columnCandidates.text.map((item) => item.name),
            time: profile.columnCandidates.time.map((item) => item.name),
            metadata: profile.columnCandidates.metadata.map((item) => item.name),
          },
          recentMessages: recent(this.store, context.sessionId, runId),
        },
        context.sessionId,
        runId,
        message.messageId,
      );
      this.store.updateTurn(turn.turnId, 'interpreted');
      if (
        language.output.task !== 'interpret_column_confirmation' ||
        language.output.needsClarification ||
        !language.output.draft
      ) {
        const explanation =
          language.output.task === 'interpret_column_confirmation'
            ? language.output.explanation
            : '无法解释列确认。';
        this.assistantMessage(
          context,
          runId,
          'columns.clarification',
          explanation,
        );
        this.store.updateTurn(turn.turnId, 'responded');
        return {
          value: {
            kind: 'columns.unresolved',
            explanation,
            columns: profile.columns,
          },
          activeRunId: runId,
        };
      }
      const resumed = await this.workflow.resume({
        runId,
        runtimeDb: context.runtimeDb,
        columnConfirmation: language.output.draft,
        approvedBy: 'local_user',
      });
      this.store.updateTurn(turn.turnId, 'fsm_resumed');
      const response = `数据列已经确认：正文列 ${language.output.draft.textColumns.join('、')}，时间列 ${language.output.draft.timeColumn ?? '无'}，ID 列 ${language.output.draft.idColumn ?? '无'}，元数据列 ${language.output.draft.metadataColumns.join('、') || '无'}。`;
      this.assistantMessage(context, runId, 'columns.confirmed', response);
      this.store.updateTurn(turn.turnId, 'responded');
      return {
        value: {
          kind: 'columns.confirmed',
          draft: language.output.draft,
          datasetSha256: profile.datasetSha256,
          workflow: resumed,
          languageTelemetry: language.telemetry,
          response,
        },
        activeRunId: runId,
      };
    } catch (error) {
      this.store.updateTurn(turn.turnId, 'failed', errorRecord(error));
      throw error;
    }
  }

  private async freeText(
    text: string,
    context: TurnContext,
  ): Promise<TurnResult> {
    const runId = context.activeRunId;
    const workflowContext = runId
      ? await this.workflow.conversationContext(runId, context.runtimeDb)
      : undefined;
    const message = this.userMessage(context, runId, 'conversation.text', text);
    const allowedToolIds = [
      ...(runId
        ? (['theta.status.read', 'theta.evidence.read'] as const)
        : []),
      'theta.rag.search' as const,
      'theta.model.catalog' as const,
    ];
    const proposal = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'propose_readonly_tool',
        text,
        ...(workflowContext?.status.currentState
          ? { currentState: workflowContext.status.currentState }
          : {}),
        allowedToolIds,
      },
      context.sessionId,
      runId,
      message.messageId,
    );
    if (proposal.output.task !== 'propose_readonly_tool') {
      throw new Error('Unexpected language result for free-form turn.');
    }
    let toolResult: unknown;
    switch (proposal.output.toolId) {
      case 'theta.status.read':
        toolResult = await this.workflow.status(
          requiredRun(runId),
          context.runtimeDb,
        );
        break;
      case 'theta.evidence.read':
        toolResult = await this.workflow.evidence(
          requiredRun(runId),
          context.runtimeDb,
        );
        break;
      case 'theta.rag.search': {
        const result = await runThetaRagSearch({ query: text, limit: 5 });
        toolResult =
          result.status === 'completed'
            ? result.output
            : { status: result.status, error: result.error };
        break;
      }
      case 'theta.model.catalog': {
        const result = await runThetaModelCatalog({});
        toolResult =
          result.status === 'completed'
            ? result.output
            : { status: result.status, error: result.error };
        break;
      }
      default:
        toolResult = {
          message:
            proposal.output.intent === 'approve_current' ||
            proposal.output.intent === 'reject_current'
              ? '审批不会由 LLM 自动执行，请使用显式审批命令。'
              : '当前没有需要执行的安全只读工具。可使用 /help。',
        };
    }
    const grounding = safeGrounding(proposal.output.toolId, toolResult);
    const composed = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'compose_grounded_response',
        userText: text,
        toolId: proposal.output.toolId,
        facts: grounding.facts,
        evidence: grounding.evidence,
        recentMessages: recent(this.store, context.sessionId, runId),
      },
      context.sessionId,
      runId,
      message.messageId,
    );
    const response =
      composed.output.task === 'compose_grounded_response'
        ? composed.output.text
        : '无法生成受事实约束的回复。';
    this.assistantMessage(context, runId, 'conversation.response', response);
    return {
      value: {
        kind: 'conversation.turn',
        proposal: proposal.output,
        result: toolResult,
        response,
        evidenceRefs:
          composed.output.task === 'compose_grounded_response'
            ? composed.output.evidenceIds
            : [],
      },
      activeRunId: runId,
    };
  }

  private async dynamicQuestion(
    context: ThetaWorkflowConversationContext,
    sessionId: string,
    runId: string,
  ): Promise<string> {
    if (
      context.status.currentState !==
        THETA_WORKFLOW_STATES.awaitResearchClarification ||
      context.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.researchClarification
    ) {
      if (
        context.status.currentState ===
        THETA_WORKFLOW_STATES.awaitColumnConfirmation
      ) {
        return '接下来请确认正文列、时间列、ID 列和元数据列。';
      }
      return context.status.pendingReason
        ? `下一步：${context.status.pendingReason}`
        : '研究信息已经满足当前要求，系统正在进入下一步。使用 /status 可以查看进度。';
    }
    const { gap, question } = activeResearchQuestion(context);
    const generated = await this.language(
      {
        schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        task: 'generate_grilling_question',
        gapId: gap.id,
        field: gap.field,
        reason: gap.reason,
        draftQuestion: question.question,
        attempt: Math.min(8, questionAttempt(this.store, sessionId, runId)),
        currentBrief: context.researchBrief ?? {},
        recentMessages: recent(this.store, sessionId, runId),
      },
      sessionId,
      runId,
    );
    if (generated.output.task !== 'generate_grilling_question') {
      return question.question;
    }
    return [
      generated.output.question,
      generated.output.examples.length > 0
        ? `例如：${generated.output.examples.join('；')}`
        : '',
      generated.output.answerHint ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private questionAfterAnswer(
    context: ThetaWorkflowConversationContext,
    suggestions: Array<{
      gapId: string;
      field: string;
      question: string;
      examples: string[];
      answerHint?: string;
    }>,
  ): string {
    if (
      context.status.currentState !==
        THETA_WORKFLOW_STATES.awaitResearchClarification ||
      context.status.pendingActionRef !==
        THETA_APPROVAL_KEYS.researchClarification
    ) {
      if (
        context.status.currentState ===
        THETA_WORKFLOW_STATES.awaitColumnConfirmation
      ) {
        return '接下来请确认正文列、时间列、ID 列和元数据列。';
      }
      return context.status.pendingReason
        ? `下一步：${context.status.pendingReason}`
        : '研究信息已经满足当前要求，系统正在进入下一步。使用 /status 可以查看进度。';
    }
    const { gap, question } = activeResearchQuestion(context);
    const suggestion = suggestions.find(
      (item) => item.gapId === gap.id && item.field === gap.field,
    );
    return [
      suggestion?.question ?? question.question,
      suggestion?.examples.length
        ? `例如：${suggestion.examples.join('；')}`
        : '',
      suggestion?.answerHint ?? '请直接用自然语言回答。',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private async language(
    request: NaturalLanguageRequest,
    sessionId: string,
    runId?: string,
    sourceMessageId?: string,
  ): Promise<NaturalLanguageResult> {
    const session = this.store.getOrCreateSession(sessionId, {
      activeRunId: runId,
    });
    const generated = session.languageConsent
      ? await runApprovedThetaConversationLanguage(request, {
          userId: 'local_user',
        }).then((value) => {
          if (value.status !== 'completed' || !value.output) {
            throw new Error(
              typeof value.error === 'string'
                ? value.error
                : (value.error?.message ?? `Language status=${value.status}`),
            );
          }
          return naturalLanguageResultSchema.parse(value.output);
        })
      : await this.deterministicLanguage.generate(request);
    this.store.recordLanguageInterpretation({
      interpretationId: `interpretation.${randomUUID()}`,
      sessionId,
      ...(runId ? { runId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      task: request.task,
      provider: generated.source,
      requestHash: generated.factsHash,
      responseHash: hash(generated.output),
      structuredOutput: generated,
      status: generated.fallbackReason ? 'fallback' : 'completed',
      ...(generated.fallbackReason
        ? { fallbackReason: generated.fallbackReason }
        : {}),
      createdAt: new Date().toISOString(),
    });
    return generated;
  }

  private userMessage(
    context: TurnContext,
    runId: string | undefined,
    messageKind: string,
    content: string,
  ): ConversationMessage {
    return this.store.appendMessage({
      messageId: `message.${randomUUID()}`,
      sessionId: context.sessionId,
      ...(runId ? { runId } : {}),
      role: 'user',
      messageKind,
      content: sanitizeLanguageText(content, 4000),
      createdAt: new Date().toISOString(),
    });
  }

  private assistantMessage(
    context: TurnContext,
    runId: string | undefined,
    messageKind: string,
    content: string,
  ): ConversationMessage {
    return this.store.appendMessage({
      messageId: `message.${randomUUID()}`,
      sessionId: context.sessionId,
      ...(runId ? { runId } : {}),
      role: 'assistant',
      messageKind,
      content: sanitizeLanguageText(content, 4000),
      createdAt: new Date().toISOString(),
    });
  }

  private startTurn(
    context: TurnContext,
    runId: string,
    message: ConversationMessage,
  ) {
    const now = new Date().toISOString();
    const turn = {
      turnId: `turn.${randomUUID()}`,
      sessionId: context.sessionId,
      runId,
      userMessageId: message.messageId,
      status: 'received' as const,
      idempotencyKey: hash({
        sessionId: context.sessionId,
        runId,
        messageId: message.messageId,
      }),
      createdAt: now,
      updatedAt: now,
    };
    this.store.createTurn(turn);
    return turn;
  }
}

const activeResearchQuestion = (
  context: ThetaWorkflowConversationContext,
): { gap: InformationGap; question: PlannedQuestion } => {
  const assessment = context.researchAssessment ?? {};
  const gaps = Array.isArray(assessment.gaps)
    ? assessment.gaps
        .map(safeGap)
        .filter((item): item is InformationGap => item !== undefined)
    : [];
  const questions = Array.isArray(assessment.questions)
    ? assessment.questions
        .map(safeQuestion)
        .filter((item): item is PlannedQuestion => item !== undefined)
    : [];
  const question = questions[0];
  const gap =
    gaps.find((item) => item.id === question?.gapId) ??
    gaps.find((item) => item.severity === 'blocking');
  if (!gap) throw new Error('Research clarification has no active gap.');
  return {
    gap,
    question:
      question ?? {
        gapId: gap.id,
        field: gap.field,
        question: gap.question,
        severity: gap.severity,
        score: gap.informationGain,
      },
  };
};

const researchGapCandidates = (
  context: ThetaWorkflowConversationContext,
  activeGapId: string,
): Array<{
  gapId: string;
  field: string;
  reason: string;
  draftQuestion: string;
}> => {
  const assessment = context.researchAssessment ?? {};
  const gaps = Array.isArray(assessment.gaps)
    ? assessment.gaps
        .map(safeGap)
        .filter((item): item is InformationGap => item !== undefined)
    : [];
  const questions = Array.isArray(assessment.questions)
    ? assessment.questions
        .map(safeQuestion)
        .filter((item): item is PlannedQuestion => item !== undefined)
    : [];
  const questionByGap = new Map(
    questions.map((question) => [question.gapId, question.question]),
  );
  return gaps
    .filter((gap) => gap.id !== activeGapId)
    .sort(
      (left, right) =>
        (left.severity === right.severity
          ? right.informationGain - left.informationGain
          : left.severity === 'blocking'
            ? -1
            : 1),
    )
    .slice(0, 8)
    .map((gap) => ({
      gapId: gap.id,
      field: gap.field,
      reason: gap.reason,
      draftQuestion: questionByGap.get(gap.id) ?? gap.question,
    }));
};

const safeGap = (value: unknown): InformationGap | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.field !== 'string' ||
    typeof item.question !== 'string' ||
    typeof item.reason !== 'string' ||
    (item.severity !== 'blocking' && item.severity !== 'optional') ||
    typeof item.informationGain !== 'number'
  ) {
    return;
  }
  return item as unknown as InformationGap;
};

const safeQuestion = (value: unknown): PlannedQuestion | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    typeof item.gapId !== 'string' ||
    typeof item.field !== 'string' ||
    typeof item.question !== 'string' ||
    (item.severity !== 'blocking' && item.severity !== 'optional') ||
    typeof item.score !== 'number'
  ) {
    return;
  }
  return item as unknown as PlannedQuestion;
};

const recent = (
  store: ConversationStore,
  sessionId: string,
  runId?: string,
): Array<{ role: 'user' | 'assistant'; content: string }> =>
  store
    .listRecentMessages(sessionId, 12)
    .filter((message) => !runId || message.runId === runId)
    .filter(
      (
        message,
      ): message is ConversationMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    )
    .map(({ role, content }) => ({ role, content }));

const questionAttempt = (
  store: ConversationStore,
  sessionId: string,
  runId: string,
): number =>
  1 +
  store
    .listRecentMessages(sessionId, 100)
    .filter(
      (message) =>
        message.runId === runId &&
        message.messageKind === 'research.progress',
    ).length;

const requiredRun = (runId: string | undefined): string => {
  if (!runId) throw new Error('No active Run. Use /start <dataset> first.');
  return runId;
};

export const parsePlanAdjustment = (input: string): Record<string, unknown> => {
  const text = input.trim();
  const patch: Record<string, unknown> = {};
  const topicMatch = text.match(
    /(?:主题(?:数|数量)?|topics?)[^\d]{0,12}(\d{1,3})/iu,
  );
  const epochMatch = text.match(
    /(?:迭代(?:次数)?|训练轮次|epochs?)[^\d]{0,12}(\d{1,6})/iu,
  );
  const batchMatch = text.match(
    /(?:批大小|batch(?:\s*size)?)[^\d]{0,12}(\d{1,6})/iu,
  );
  const modelMatch = text.match(
    /\b(BERTopic|BTM|CTM|DTM|ETM|GSM|HDP|LDA|NVDM|ProdLDA|STM|THETA)\b/iu,
  );
  if (topicMatch) patch.numTopics = Number(topicMatch[1]);
  if (epochMatch) patch.epochs = Number(epochMatch[1]);
  if (batchMatch) patch.batchSize = Number(batchMatch[1]);
  if (modelMatch) patch.modelId = modelMatch[1].toLowerCase();
  if (/监督/iu.test(text) && !/无监督/iu.test(text)) {
    patch.mode = 'supervised';
  } else if (/无监督/iu.test(text)) {
    patch.mode = 'unsupervised';
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      '没有识别出可调整项。请明确说明模型、主题数、迭代次数或批大小，例如“把主题数改成 8”。',
    );
  }
  return patch;
};

const planFieldLabel = (field: string): string =>
  ({
    modelId: '模型',
    numTopics: '主题数',
    epochs: '迭代次数',
    batchSize: '批大小',
    mode: '训练模式',
  })[field] ?? field;

const researchFieldLabel = (field: string): string =>
  ({
    researchQuestion: '研究问题',
    dataSources: '数据来源',
    collectionMethod: '数据产生方式',
    analysisUnit: '分析单位',
    timeRange: '时间范围',
    language: '数据语言',
    comparisonGroups: '比较对象',
    topicGranularity: '主题粒度',
    knownBiases: '已知偏差',
    sensitiveData: '敏感数据情况',
    successCriteria: '成功标准',
    hardwareLimit: '本地硬件条件',
    textFieldIntent: '正文含义',
    trendAnalysis: '时间趋势要求',
    offlineOnly: '离线要求',
    requestedEmbedding: '嵌入方式',
    timeLimitHours: '可用训练时间',
    interviewComplete: '研究访谈状态',
  })[field] ?? '研究设置';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const errorRecord = (error: unknown): Record<string, string> => ({
  name: error instanceof Error ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error),
});

const safeGrounding = (
  toolId: string | null,
  value: unknown,
): {
  facts: Record<string, unknown>;
  evidence: Array<{ evidenceId: string; excerpt: string }>;
} => {
  const record = asRecord(value);
  if (toolId === 'theta.status.read') {
    return {
      facts: {
        runId: record.runId,
        status: record.status,
        currentState: record.currentState,
        pendingActionRef: record.pendingActionRef,
        pendingReason: record.pendingReason,
      },
      evidence: [],
    };
  }
  if (toolId === 'theta.evidence.read') {
    const orchestration = Array.isArray(record.orchestrationEvents)
      ? record.orchestrationEvents
      : [];
    const tools = Array.isArray(record.toolEvents) ? record.toolEvents : [];
    return {
      facts: {
        orchestrationEventCount: orchestration.length,
        toolEventCount: tools.length,
        recentEventTypes: orchestration
          .slice(-5)
          .map((event) => asRecord(event).type)
          .filter((item) => typeof item === 'string'),
      },
      evidence: [],
    };
  }
  if (toolId === 'theta.rag.search') {
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.slice(0, 5).map((item) => {
          const entry = asRecord(item);
          return {
            evidenceId:
              typeof entry.evidenceId === 'string'
                ? entry.evidenceId
                : 'unknown-evidence',
            excerpt:
              typeof entry.excerpt === 'string'
                ? entry.excerpt
                : 'No excerpt available.',
          };
        })
      : [];
    return {
      facts: {
        query: record.query,
        noEvidence: record.noEvidence,
        evidenceCount: evidence.length,
      },
      evidence,
    };
  }
  if (toolId === 'theta.model.catalog') {
    const models = Array.isArray(record.models)
      ? record.models.slice(0, 30).map((item) => {
          const model = asRecord(item);
          return {
            id: model.id,
            name: model.name,
            type: model.type,
            runnable: model.runnable,
          };
        })
      : [];
    return { facts: { models }, evidence: [] };
  }
  return { facts: record, evidence: [] };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
