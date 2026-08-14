import type {
  ApproveTrainingRequest,
  CheckpointConfirmationReceipt,
  CommandReceipt,
  ConfirmCheckpointRequest,
  ConversationMessage,
  ConversationPage,
  CreateRemoteSampleAuthorizationRequest,
  CreateRunAccepted,
  CreateRunRequest,
  MessageAccepted,
  RemoteSampleAuthorizationReceipt,
  RecoveryCommandAccepted,
  RecoveryCommandRequest,
  ResultAnalysisMessageRequest,
  ResultArtifactPage,
  SendMessageRequest,
  ThetaHealthV3,
  ThetaRunSummaryV3,
  ThetaRunViewV3,
  TrainingApprovalReceipt,
} from '../../lib/api/v3/contracts.generated';
import { ThetaApiError } from '../../lib/api/v3/errors';
import type { ThetaV3Transport, TransportRequest } from '../../lib/api/v3/transport';
import {
  createPlanCandidate,
  createPlanCheckpoint,
  createResearchCheckpoint,
  createResearchWorkspace,
  createRemoteDatasetRunView,
  createToolPermissionFailure,
  createTrainingApprovalView,
  defaultMessages,
  defaultRunView,
  mockDatasets,
  mockResultArtifacts,
} from './fixtures/default-scenario';

interface MockRunState {
  view: ThetaRunViewV3;
  messages: ConversationMessage[];
  trainingViewReads: number;
  title?: string;
}

export class MockThetaV3Transport implements ThetaV3Transport {
  private view: ThetaRunViewV3 = structuredClone(defaultRunView);
  private messages: ConversationMessage[] = structuredClone(defaultMessages);
  private readonly commands = new Map<string, CommandReceipt>();
  private readonly authorizations = new Map<string, RemoteSampleAuthorizationReceipt>();
  private readonly runStates = new Map<string, MockRunState>();
  private trainingViewReads = 0;
  private currentRunId: string | undefined = this.view.runId;
  private currentTitle: string | undefined = this.view.dataset?.fileName;
  private runSequence = 1;

  constructor() {
    this.persistCurrentRun();
  }

  async request<T>(request: TransportRequest): Promise<T> {
    await Promise.resolve();
    const url = new URL(request.path, 'http://theta.mock/');
    const path = url.pathname.replace(/^\//u, '');
    this.persistCurrentRun();
    const runMatch = path.match(/^runs\/([^/]+)(?:\/|$)/u);
    if (runMatch) this.activateRun(decodeURIComponent(runMatch[1]));

    try {
      if (request.method === 'GET' && path === 'health') return this.health() as T;
      if (request.method === 'GET' && path === 'datasets') {
        return { items: structuredClone(mockDatasets) } as T;
      }
      if (request.method === 'GET' && path === 'runs') {
        const items = [...this.runStates.values()]
          .reverse()
          .map((state) => this.summary(state.view, state.title));
        return { items } as T;
      }
      if (request.method === 'POST' && path === 'runs') return this.createRun(request.body) as T;
      if (request.method === 'DELETE' && path === `runs/${this.view.runId}`) {
        return this.deleteRun() as T;
      }
      if (request.method === 'GET' && path === `runs/${this.view.runId}/view`) {
        return this.readRunView() as T;
      }
      if (request.method === 'GET' && path === `runs/${this.view.runId}/messages`) {
        return this.listMessages(url) as T;
      }
      if (request.method === 'POST' && path === `runs/${this.view.runId}/messages`) {
        return this.sendMessage(request.body) as T;
      }
      if (request.method === 'GET' && path === `runs/${this.view.runId}/checkpoints/current`) {
        return structuredClone(this.view.checkpoint ?? null) as T;
      }
      if (request.method === 'POST' && path === `runs/${this.view.runId}/training/approvals`) {
        return this.approveTraining(request.body) as T;
      }
      if (request.method === 'POST' && path === `runs/${this.view.runId}/recovery-commands`) {
        return this.executeRecoveryCommand(request.body) as T;
      }
      if (request.method === 'GET' && path === `runs/${this.view.runId}/results/artifacts`) {
        return this.listResultArtifacts() as T;
      }
      if (request.method === 'POST' && path === `runs/${this.view.runId}/results/analysis-messages`) {
        return this.sendResultAnalysisMessage(request.body) as T;
      }

      const commandMatch = path.match(/^runs\/[^/]+\/commands\/([^/]+)$/u);
      if (request.method === 'GET' && commandMatch) {
        const command = this.commands.get(decodeURIComponent(commandMatch[1]));
        if (!command) throw this.notFound('COMMAND_NOT_FOUND', '未找到 Mock 命令。');
        return structuredClone(command) as T;
      }

      const confirmationMatch = path.match(/^runs\/[^/]+\/checkpoints\/([^/]+)\/confirmations$/u);
      if (request.method === 'POST' && confirmationMatch) {
        return this.confirmCheckpoint(decodeURIComponent(confirmationMatch[1]), request.body) as T;
      }

      const authorizationMatch = path.match(/^datasets\/([^/]+)\/remote-sample-authorizations$/u);
      if (request.method === 'POST' && authorizationMatch) {
        return this.authorizeRemoteSample(decodeURIComponent(authorizationMatch[1]), request.body) as T;
      }

      throw this.notFound('MOCK_ROUTE_NOT_FOUND', `Mock 路由不存在：${request.method} ${path}`);
    } finally {
      this.persistCurrentRun();
    }
  }

  snapshot(): ThetaRunViewV3 {
    return structuredClone(this.view);
  }

  private persistCurrentRun(): void {
    if (!this.currentRunId) return;
    this.runStates.set(this.currentRunId, {
      view: structuredClone(this.view),
      messages: structuredClone(this.messages),
      trainingViewReads: this.trainingViewReads,
      title: this.currentTitle,
    });
  }

  private activateRun(runId: string): void {
    if (runId === this.currentRunId) return;
    const state = this.runStates.get(runId);
    if (!state) throw this.notFound('RUN_NOT_FOUND', '未找到 Mock 项目。');
    this.currentRunId = runId;
    this.currentTitle = state.title;
    this.view = structuredClone(state.view);
    this.messages = structuredClone(state.messages);
    this.trainingViewReads = state.trainingViewReads;
  }

  private health(): ThetaHealthV3 {
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      capabilities: { agent: true, events: true, checkpoints: true },
      checks: [{ id: 'mock-transport', status: 'PASS', message: 'V3 Mock Transport 已启用。' }],
    };
  }

  private summary(view: ThetaRunViewV3 = this.view, title = this.currentTitle): ThetaRunSummaryV3 {
    return {
      runId: view.runId,
      revision: view.revision,
      lifecycle: view.lifecycle,
      phase: view.phase,
      updatedAt: view.updatedAt,
      title: title ?? view.dataset?.fileName,
      interaction: view.interaction,
    };
  }

  private createRun(body: unknown): CreateRunAccepted {
    const input = body as CreateRunRequest;
    if (!input?.datasetRef || !input.clientCommandId) {
      throw new ThetaApiError(400, {
        code: 'INVALID_REQUEST',
        category: 'validation',
        message: 'datasetRef 和 clientCommandId 为必填项。',
        retryable: false,
      });
    }
    const dataset = mockDatasets.find((item) => item.datasetRef === input.datasetRef);
    if (!dataset) throw this.notFound('DATASET_NOT_FOUND', '未找到所选数据集。');
    if (dataset.availability === 'remote_sample_authorization_required') {
      const authorization = input.remoteSampleAuthorizationId
        ? this.authorizations.get(input.remoteSampleAuthorizationId)
        : undefined;
      if (!authorization || authorization.datasetRef !== dataset.datasetRef) {
        throw new ThetaApiError(403, {
          code: 'REMOTE_SAMPLE_AUTHORIZATION_REQUIRED',
          category: 'permission',
          message: '该数据集需要远程脱敏样本授权。',
          retryable: false,
          recovery: {
            action: 'contact_user',
            label: '授权样本',
            description: '允许 Agent 在限定时间内读取最多 10 条脱敏样本。',
          },
        });
      }
    }
    const baseView = dataset.source === 'remote'
      ? createRemoteDatasetRunView()
      : structuredClone(defaultRunView);
    const runId = `run_mock_${++this.runSequence}`;
    this.currentRunId = runId;
    this.currentTitle = input.initialMessage?.trim().slice(0, 36) || `研究项目 ${this.runSequence}`;
    this.trainingViewReads = 0;
    this.view = { ...baseView, runId };
    this.messages = dataset.source === 'remote'
      ? [{
          messageId: 'message_remote_1',
          sequence: 1,
          role: 'assistant',
          kind: 'activity_notice',
          content: '数据字段、文本方向和质量信号已明确，本次无需数据确认，已进入研究对话。',
          createdAt: new Date().toISOString(),
          status: 'completed',
        }]
      : structuredClone(defaultMessages);
    if (input.initialMessage?.trim()) {
      if (dataset.source !== 'remote') this.beginConversation();
      this.messages = [...this.messages, {
        messageId: 'message_initial_user',
        sequence: (this.messages.at(-1)?.sequence ?? 0) + 1,
        role: 'user',
        kind: 'text',
        content: input.initialMessage.trim(),
        createdAt: new Date().toISOString(),
        status: 'completed',
      }];
      this.applyMockAgentResponse(input.initialMessage.trim());
    } else if (dataset.source === 'remote') {
      this.appendAssistantMessage(
        'agent_question',
        '你希望从这批新闻文本中回答什么问题？也可以直接让我自主确定研究方向。',
      );
    }
    const command = this.command(input.clientCommandId, 'accepted');
    return { runId: this.view.runId, command, view: structuredClone(this.view) };
  }

  private deleteRun(): { runId: string; deleted: true } {
    const runId = this.currentRunId;
    if (!runId || !this.runStates.has(runId)) {
      throw this.notFound('RUN_NOT_FOUND', '未找到 Mock 项目。');
    }
    this.runStates.delete(runId);
    this.currentRunId = undefined;
    this.currentTitle = undefined;
    return { runId, deleted: true };
  }

  private beginConversation(): void {
    this.view = {
      ...this.view,
      revision: this.view.revision + 1,
      lifecycle: 'active',
      phase: 'research_dialogue',
      activity: {
        kind: 'agent_reasoning',
        label: '正在理解你的请求',
        detail: '数据导入、理解、分析和问题修复均由当前对话协调。',
      },
      interaction: {
        kind: 'conversation',
        prompt: '继续描述目标、数据来源或需要处理的问题。',
        expectsUserInput: true,
      },
      progress: {
        scope: 'phase',
        stageId: 'research_dialogue',
        label: '研究对话',
        detail: 'Agent 正在根据首条消息建立研究上下文。',
        percent: null,
        indeterminate: true,
      },
      checkpoint: undefined,
      capabilities: {
        ...this.view.capabilities,
        canConfirmCheckpoint: false,
        canRejectCheckpoint: false,
      },
    };
    this.messages = [{
      messageId: 'message_conversation_ready',
      sequence: 1,
      role: 'assistant',
      kind: 'activity_notice',
      content: '项目已创建。你可以在这里导入数据、提出分析目标、梳理框架或处理失败。',
      createdAt: new Date().toISOString(),
      status: 'completed',
    }];
  }

  private listMessages(url: URL): ConversationPage {
    const after = Number.parseInt(url.searchParams.get('afterSequence') ?? '0', 10);
    const limit = Math.min(100, Number.parseInt(url.searchParams.get('limit') ?? '100', 10));
    const items = this.messages.filter((message) => message.sequence > after).slice(0, limit);
    const last = items.at(-1)?.sequence ?? after;
    return {
      items: structuredClone(items),
      nextAfterSequence: this.messages.some((message) => message.sequence > last) ? last : null,
    };
  }

  private sendMessage(body: unknown): MessageAccepted {
    const input = body as SendMessageRequest;
    this.assertRevision(input.expectedRunRevision);
    const sequence = (this.messages.at(-1)?.sequence ?? 0) + 1;
    const message: ConversationMessage = {
      messageId: `message_mock_${sequence}`,
      clientMessageId: input.clientMessageId,
      sequence,
      role: 'user',
      kind: 'text',
      content: input.content,
      createdAt: new Date().toISOString(),
      status: 'accepted',
      commandId: `command_${input.clientCommandId}`,
      checkpointId: input.checkpointContext?.checkpointId,
    };
    this.messages = [...this.messages, message];
    this.bumpRevision();
    if (this.view.checkpoint?.kind === 'plan' || this.view.phase === 'plan_confirmation') {
      this.applyMockPlanRevision(input.content, input.checkpointContext?.checkpointId);
    } else {
      this.applyMockAgentResponse(input.content, input.checkpointContext?.checkpointId);
    }
    const command = this.command(input.clientCommandId, 'accepted');
    return { message: structuredClone(message), command, runRevision: this.view.revision };
  }

  private confirmCheckpoint(checkpointId: string, body: unknown): CheckpointConfirmationReceipt {
    const input = body as ConfirmCheckpointRequest;
    this.assertRevision(input.expectedRunRevision);
    const checkpoint = this.view.checkpoint;
    if (
      !checkpoint ||
      checkpoint.checkpointId !== checkpointId ||
      checkpoint.revision !== input.checkpointRevision ||
      checkpoint.contentHash !== input.contentHash
    ) {
      throw new ThetaApiError(409, {
        code: 'CHECKPOINT_SUPERSEDED',
        category: 'conflict',
        message: '该检查点已被新版本替代，请刷新后重新确认。',
        retryable: true,
        recovery: { action: 'refresh', label: '刷新', description: '读取最新 RunView。' },
      });
    }
    if (
      checkpoint.kind === 'plan' &&
      (!this.view.plan || this.view.plan.candidatePlanHash !== input.contentHash)
    ) {
      throw new ThetaApiError(409, {
        code: 'PLAN_HASH_MISMATCH',
        category: 'conflict',
        message: '候选方案 Hash 已变化，请查看并批准最新方案。',
        retryable: true,
        recovery: { action: 'refresh', label: '刷新方案', description: '读取最新 Plan Candidate。' },
      });
    }
    const command = this.command(input.clientCommandId, 'accepted');
    this.bumpRevision();
    const confirmedResearch = checkpoint.kind === 'research';
    const confirmedPlan = checkpoint.kind === 'plan';
    this.view = {
      ...this.view,
      lifecycle: checkpoint.kind === 'dataset' || confirmedPlan ? 'waiting_user' : 'active',
      phase: checkpoint.kind === 'dataset'
        ? 'research_dialogue'
        : confirmedPlan
          ? 'training_confirmation'
          : 'plan_confirmation',
      activity: checkpoint.kind === 'dataset'
        ? { kind: 'waiting_user', label: '等待研究方向' }
        : confirmedPlan ? {
            kind: 'waiting_user',
            label: '等待训练批准',
            detail: 'Dry Run 已通过，训练尚未开始。',
          } : {
            kind: 'agent_reasoning',
            label: '正在设计研究方案',
            detail: '研究理解已确认，开始选择模型、参数与评价方式。',
          },
      interaction: checkpoint.kind === 'dataset'
        ? {
            kind: 'conversation',
            prompt: '请描述研究目标，或直接委托 Agent 自主确定方向。',
            expectsUserInput: true,
          }
        : confirmedPlan
          ? {
              kind: 'training_approval',
              prompt: '请核对 Dry Run 和资源信息，再单独批准训练。',
              expectsUserInput: true,
            }
          : { kind: 'none', expectsUserInput: false },
      progress: checkpoint.kind === 'dataset'
        ? {
            scope: 'phase',
            stageId: 'research_dialogue',
            label: '研究对话',
            detail: '数据理解已确认，等待研究目标。',
            percent: null,
            indeterminate: true,
          }
        : confirmedPlan ? {
            scope: 'training',
            stageId: 'training_approval',
            label: '等待训练批准',
            detail: 'Dry Run 已完成，尚未启动训练进程。',
            percent: null,
            indeterminate: true,
          } : {
            scope: 'phase',
            stageId: 'plan_confirmation',
            label: '确认方案',
            detail: '候选方案已通过 Validator，等待强制审批。',
            percent: null,
            indeterminate: true,
          },
      checkpoint: undefined,
      training: confirmedPlan && this.view.plan
        ? createTrainingApprovalView(this.view.plan)
        : this.view.training,
      capabilities: {
        ...this.view.capabilities,
        canConfirmCheckpoint: false,
        canRejectCheckpoint: false,
        canApprovePlan: false,
        canApproveTraining: confirmedPlan,
      },
    };
    this.appendAssistantMessage(
      'checkpoint_confirmed',
      confirmedPlan
        ? '当前方案已批准且 Dry Run 通过。训练仍需单独批准。'
        : confirmedResearch
          ? '当前研究理解已确认，候选方案已生成并通过 Validator，请审批方案。'
          : '数据理解已确认，请描述你的研究目标。',
      checkpoint.checkpointId,
    );
    if (confirmedResearch && this.view.research) this.proposePlan(this.view.research);
    return {
      receiptId: `receipt_${checkpointId}_${checkpoint.revision}`,
      checkpointId,
      checkpointRevision: checkpoint.revision,
      contentHash: checkpoint.contentHash,
      kind: checkpoint.kind,
      confirmedBy: 'mock_user',
      confirmedAt: new Date().toISOString(),
      command,
    };
  }

  private applyMockAgentResponse(content: string, checkpointId?: string): void {
    if (this.view.phase !== 'research_dialogue' && this.view.checkpoint?.kind !== 'research') return;

    const delegated = /(?:直接规划|无需确认|不需要确认|你决定|你来决定|自主决定)/u.test(content);
    const nextResearchRevision = this.view.checkpoint?.kind === 'research'
      ? this.view.checkpoint.revision + 1
      : 1;
    const research = createResearchWorkspace(content, nextResearchRevision);

    if (delegated) {
      this.view = {
        ...this.view,
        lifecycle: 'active',
        phase: 'plan_design',
        activity: {
          kind: 'agent_reasoning',
          label: '正在设计研究方案',
          detail: '研究目标已足够明确，本次跳过研究确认。',
        },
        interaction: { kind: 'none', expectsUserInput: false },
        progress: {
          scope: 'phase',
          stageId: 'plan_design',
          label: '设计方案',
          detail: '正在选择模型、参数与评价方式。',
          percent: null,
          indeterminate: true,
        },
        checkpoint: undefined,
        research,
        capabilities: {
          ...this.view.capabilities,
          canConfirmCheckpoint: false,
          canRejectCheckpoint: false,
        },
      };
      this.appendAssistantMessage(
        'agent_summary',
        '研究目标已经足够明确，我将直接进入方案设计；本次不需要研究确认。',
      );
      this.proposePlan(research);
      return;
    }

    const checkpoint = createResearchCheckpoint(research, nextResearchRevision);
    this.view = {
      ...this.view,
      lifecycle: 'waiting_user',
      phase: 'research_dialogue',
      activity: { kind: 'waiting_user', label: '等待确认研究理解' },
      interaction: {
        kind: 'checkpoint',
        prompt: '可继续提问或修改；只有点击确认按钮才会批准当前研究版本。',
        checkpointId: checkpoint.checkpointId,
        expectsUserInput: true,
      },
      progress: {
        scope: 'phase',
        stageId: 'research_checkpoint',
        label: '研究理解',
        detail: checkpointId ? 'Agent 已根据你的反馈生成新版本。' : '等待确认当前研究理解。',
        percent: null,
        indeterminate: true,
      },
      checkpoint,
      research,
      capabilities: {
        ...this.view.capabilities,
        canConfirmCheckpoint: true,
        canRejectCheckpoint: true,
      },
    };
    this.appendAssistantMessage(
      checkpointId ? 'checkpoint_revised' : 'checkpoint_proposed',
      checkpointId
        ? `我已根据你的反馈修订研究理解，当前为版本 ${checkpoint.revision}。请检查后显式确认。`
        : '我已整理当前研究理解。你可以继续修订，或显式确认此版本。',
      checkpoint.checkpointId,
    );
  }

  private proposePlan(research: NonNullable<ThetaRunViewV3['research']>): void {
    const plan = createPlanCandidate(
      research,
      2,
      undefined,
      this.view.dataset?.datasetHash,
    );
    const checkpoint = createPlanCheckpoint(plan);
    this.view = {
      ...this.view,
      lifecycle: 'waiting_user',
      phase: 'plan_confirmation',
      activity: { kind: 'waiting_user', label: '等待审批研究方案' },
      interaction: {
        kind: 'checkpoint',
        prompt: '可在对话中要求修改；只有点击“批准当前方案”才会生成审批回执。',
        checkpointId: checkpoint.checkpointId,
        expectsUserInput: true,
      },
      progress: {
        scope: 'phase',
        stageId: 'plan_confirmation',
        label: '确认方案',
        detail: '候选方案已通过 Validator，等待强制审批。',
        percent: null,
        indeterminate: true,
      },
      plan,
      checkpoint,
      capabilities: {
        ...this.view.capabilities,
        canSendMessage: true,
        canConfirmCheckpoint: false,
        canRejectCheckpoint: true,
        canApprovePlan: true,
      },
      links: {
        ...this.view.links,
        plan: `/api/v3/runs/${this.view.runId}/plan`,
        checkpoint: `/api/v3/runs/${this.view.runId}/checkpoints/current`,
      },
    };
    this.appendAssistantMessage(
      'activity_notice',
      'Validator 拒绝了主题数过高的初稿；Agent 已自动修订参数并重新验证通过。',
    );
    this.appendAssistantMessage(
      'checkpoint_proposed',
      '候选方案已通过 Validator。你可以继续提出修改，或显式批准当前方案。',
      checkpoint.checkpointId,
    );
  }

  private applyMockPlanRevision(content: string, checkpointId?: string): void {
    const currentPlan = this.view.plan;
    const research = this.view.research;
    if (!currentPlan || !research) return;
    if (/(?:模拟.*(?:权限|失败)|工具权限)/u.test(content)) {
      this.view = {
        ...this.view,
        lifecycle: 'failed',
        phase: 'recovery',
        activity: { kind: 'recovering', label: '等待选择恢复动作' },
        interaction: {
          kind: 'recovery',
          prompt: '请选择后端提供的恢复动作，或询问失败原因。',
          expectsUserInput: true,
        },
        progress: {
          scope: 'phase',
          stageId: 'plan_validation_failed',
          label: '方案验证受阻',
          detail: '未启动训练，当前方案保持不变。',
          percent: null,
          indeterminate: true,
        },
        checkpoint: undefined,
        failure: createToolPermissionFailure(),
        capabilities: {
          ...this.view.capabilities,
          canApprovePlan: false,
          canConfirmCheckpoint: false,
          canRetry: true,
          canResume: false,
        },
      };
      this.appendAssistantMessage(
        'failure_notice',
        '模型环境检查被拒绝。请从失败卡提供的合法恢复动作中选择。',
      );
      return;
    }
    const plan = createPlanCandidate(
      research,
      currentPlan.revision + 1,
      content,
      this.view.dataset?.datasetHash,
    );
    const checkpoint = createPlanCheckpoint(plan);
    this.view = {
      ...this.view,
      lifecycle: 'waiting_user',
      phase: 'plan_confirmation',
      activity: { kind: 'waiting_user', label: '等待审批修订方案' },
      interaction: {
        kind: 'checkpoint',
        prompt: '方案已重新验证。请查看最新版本后显式批准。',
        checkpointId: checkpoint.checkpointId,
        expectsUserInput: true,
      },
      progress: {
        scope: 'phase',
        stageId: 'plan_confirmation',
        label: '确认方案',
        detail: '修改已应用且 Validator 已重新通过；旧 Hash 已失效。',
        percent: null,
        indeterminate: true,
      },
      plan,
      checkpoint,
      capabilities: {
        ...this.view.capabilities,
        canConfirmCheckpoint: false,
        canApprovePlan: true,
      },
    };
    this.appendAssistantMessage(
      'checkpoint_revised',
      `方案已修订为版本 ${plan.revision} 并重新通过 Validator。旧批准入口已失效。`,
      checkpointId ?? checkpoint.checkpointId,
    );
  }

  private approveTraining(body: unknown): TrainingApprovalReceipt {
    const input = body as ApproveTrainingRequest;
    this.assertRevision(input.expectedRunRevision);
    const training = this.view.training;
    if (
      !training?.dryRunHash ||
      training.dryRunHash !== input.dryRunHash ||
      !training.canonicalPlanHash ||
      !this.view.capabilities.canApproveTraining
    ) {
      throw new ThetaApiError(409, {
        code: 'DRY_RUN_SUPERSEDED',
        category: 'conflict',
        message: 'Dry Run 已变化，请查看最新检查结果后重新批准。',
        retryable: true,
        recovery: { action: 'refresh', label: '刷新检查', description: '读取最新 TrainingView。' },
      });
    }
    const command = this.command(input.clientCommandId, 'accepted');
    this.bumpRevision();
    this.trainingViewReads = 0;
    this.view = {
      ...this.view,
      lifecycle: 'waiting_runtime',
      phase: 'training',
      activity: {
        kind: 'training',
        label: '训练已启动',
        detail: '运行时尚未提供可信总进度。',
      },
      interaction: { kind: 'none', expectsUserInput: false },
      progress: {
        scope: 'training',
        stageId: 'training_running',
        label: '模型训练',
        detail: '正在启动分实验任务。',
        percent: null,
        indeterminate: true,
      },
      training: {
        ...training,
        status: 'running',
        stage: { id: 'training_running', label: '模型训练', detail: '分实验任务已提交。' },
        progress: {
          scope: 'training',
          stageId: 'training_running',
          label: '模型训练',
          detail: '运行时尚未提供可信总进度。',
          percent: null,
          indeterminate: true,
        },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        recentNotices: ['训练审批回执已验证。', '分实验任务正在启动。'],
      },
      capabilities: {
        ...this.view.capabilities,
        canApproveTraining: false,
        canSendMessage: false,
        canCancelTraining: true,
      },
    };
    return {
      receiptId: `training_receipt_${input.clientCommandId}`,
      dryRunHash: training.dryRunHash,
      canonicalPlanHash: training.canonicalPlanHash,
      approvedBy: 'mock_user',
      approvedAt: new Date().toISOString(),
      command,
    };
  }

  private readRunView(): ThetaRunViewV3 {
    if (this.view.phase === 'training') {
      if (this.trainingViewReads === 1 && this.view.training?.status === 'running') {
        this.advanceTrainingToEvaluation();
      } else if (this.trainingViewReads >= 2 && this.view.training?.status === 'evaluating') {
        this.completeTraining();
      }
      this.trainingViewReads += 1;
    }
    return structuredClone(this.view);
  }

  private advanceTrainingToEvaluation(): void {
    const training = this.view.training!;
    this.bumpRevision();
    this.view = {
      ...this.view,
      activity: { kind: 'training', label: '正在评价实验结果', detail: '6 个实验均已完成训练。' },
      progress: {
        scope: 'training', stageId: 'evaluating', label: '结果评价', detail: '正在计算稳定性与一致性。',
        percent: 72, indeterminate: false,
      },
      training: {
        ...training,
        status: 'evaluating',
        stage: { id: 'evaluating', label: '结果评价', detail: '正在汇总跨实验指标。' },
        progress: {
          scope: 'training', stageId: 'evaluating', label: '结果评价', detail: '正在计算稳定性与一致性。',
          percent: 72, indeterminate: false,
        },
        experiments: training.experiments.map((experiment) => ({ ...experiment, status: 'completed', percent: 100 })),
        updatedAt: new Date().toISOString(),
        recentNotices: [...training.recentNotices, '6 个实验已完成，开始统一评价。'],
      },
    };
  }

  private completeTraining(): void {
    const training = this.view.training!;
    this.bumpRevision();
    this.view = {
      ...this.view,
      lifecycle: 'completed',
      phase: 'completed',
      activity: { kind: 'idle', label: '研究已完成' },
      interaction: {
        kind: 'conversation',
        prompt: '可以基于结果 Artifact 继续提问。',
        expectsUserInput: true,
      },
      progress: {
        scope: 'run', stageId: 'completed', label: '研究完成', detail: '结果 Artifact 已准备完成。',
        percent: 100, indeterminate: false,
      },
      training: {
        ...training,
        status: 'completed',
        stage: { id: 'completed', label: '训练与评价完成' },
        progress: {
          scope: 'training', stageId: 'completed', label: '训练完成', percent: 100, indeterminate: false,
        },
        updatedAt: new Date().toISOString(),
        recentNotices: [...training.recentNotices, '结果 Artifact 已生成。'],
      },
      results: {
        status: 'available',
        artifactCount: mockResultArtifacts.length,
        overviewUrl: `/api/v3/runs/${this.view.runId}/results`,
      },
      capabilities: {
        ...this.view.capabilities,
        canSendMessage: true,
        canCancelTraining: false,
      },
      links: { ...this.view.links, results: `/api/v3/runs/${this.view.runId}/results` },
    };
    this.appendAssistantMessage('agent_summary', '训练和评价已完成，结果 Artifact 已可查看。');
  }

  private executeRecoveryCommand(body: unknown): RecoveryCommandAccepted {
    const input = body as RecoveryCommandRequest;
    this.assertRevision(input.expectedRunRevision);
    const failure = this.view.failure;
    const action = failure?.suggestedActions.find((item) => item.id === input.actionId);
    if (!failure || !action) {
      throw new ThetaApiError(400, {
        code: 'RECOVERY_ACTION_NOT_ALLOWED',
        category: 'validation',
        message: '该恢复动作不在当前 Failure 的允许列表中。',
        retryable: false,
      });
    }
    const command = this.command(input.clientCommandId, 'accepted');
    this.bumpRevision();
    if (action.type === 'cancel') {
      this.view = {
        ...this.view,
        lifecycle: 'cancelled',
        activity: { kind: 'idle', label: '研究已取消' },
        interaction: { kind: 'none', expectsUserInput: false },
        failure: undefined,
        capabilities: { ...this.view.capabilities, canRetry: false, canSendMessage: false },
      };
    } else if (this.view.research) {
      const research = this.view.research;
      this.view = { ...this.view, failure: undefined, capabilities: { ...this.view.capabilities, canRetry: false } };
      this.proposePlan(research);
      this.appendAssistantMessage('activity_notice', '恢复命令已接受，方案环境检查已重新通过。');
    }
    return { failureId: failure.failureId, actionId: action.id, runRevision: this.view.revision, command };
  }

  private listResultArtifacts(): ResultArtifactPage {
    if (this.view.results?.status !== 'available') {
      throw this.notFound('RESULTS_NOT_AVAILABLE', '结果 Artifact 尚未准备完成。');
    }
    return {
      items: structuredClone(mockResultArtifacts).map((artifact) => ({
        ...artifact,
        contentUrl: `/api/agent-v3/mock-artifacts/${encodeURIComponent(artifact.artifactId)}`,
      })),
    };
  }

  private sendResultAnalysisMessage(body: unknown): MessageAccepted {
    const input = body as ResultAnalysisMessageRequest;
    this.assertRevision(input.expectedRunRevision);
    if (this.view.results?.status !== 'available') {
      throw this.notFound('RESULTS_NOT_AVAILABLE', '结果尚不可分析。');
    }
    const sequence = (this.messages.at(-1)?.sequence ?? 0) + 1;
    const message: ConversationMessage = {
      messageId: `message_mock_${sequence}`,
      clientMessageId: input.clientMessageId,
      sequence,
      role: 'user',
      kind: 'text',
      content: input.content,
      createdAt: new Date().toISOString(),
      status: 'accepted',
      commandId: `command_${input.clientCommandId}`,
      citations: input.artifactIds?.map((artifactId) => ({
        refId: artifactId,
        label: mockResultArtifacts.find((artifact) => artifact.artifactId === artifactId)?.name ?? artifactId,
        type: 'result' as const,
      })),
    };
    this.messages = [...this.messages, message];
    this.bumpRevision();
    const command = this.command(input.clientCommandId, 'accepted');
    this.appendAssistantMessage(
      'agent_summary',
      '从主题占比与稳定性结果看，监管框架、产业应用和风险治理是最稳定的三个议题。',
    );
    return { message: structuredClone(message), command, runRevision: this.view.revision };
  }

  private appendAssistantMessage(
    kind: ConversationMessage['kind'],
    content: string,
    checkpointId?: string,
  ): void {
    const sequence = (this.messages.at(-1)?.sequence ?? 0) + 1;
    this.messages = [...this.messages, {
      messageId: `message_mock_${sequence}`,
      sequence,
      role: 'assistant',
      kind,
      content,
      createdAt: new Date().toISOString(),
      status: 'completed',
      checkpointId,
    }];
  }

  private authorizeRemoteSample(datasetRef: string, body: unknown): RemoteSampleAuthorizationReceipt {
    const input = body as CreateRemoteSampleAuthorizationRequest;
    const dataset = mockDatasets.find((item) => item.datasetRef === datasetRef);
    if (!dataset) throw this.notFound('DATASET_NOT_FOUND', '未找到所选数据集。');
    const authorizedAt = new Date();
    const receipt: RemoteSampleAuthorizationReceipt = {
      authorizationId: `authorization_${input.clientCommandId}`,
      datasetRef,
      datasetHash: datasetRef === 'dataset_mock_news_remote'
        ? 'sha256:dataset-mock-news-remote'
        : 'sha256:dataset-mock-courses',
      maxRows: input.maxRows,
      purpose: 'dataset_understanding',
      redactionPolicyVersion: input.acceptedRedactionPolicyVersion,
      authorizedBy: 'mock_user',
      authorizedAt: authorizedAt.toISOString(),
      expiresAt: new Date(authorizedAt.getTime() + input.expiresInMinutes * 60_000).toISOString(),
    };
    this.authorizations.set(receipt.authorizationId, receipt);
    return receipt;
  }

  private assertRevision(expected: number): void {
    if (expected === this.view.revision) return;
    throw new ThetaApiError(
      409,
      {
        code: 'STALE_RUN_REVISION',
        category: 'conflict',
        message: '页面状态已过期，请刷新后重试。',
        retryable: true,
        recovery: { action: 'refresh', label: '刷新', description: '读取最新 RunView。' },
      },
      {
        apiVersion: '3.0.0',
        requestId: 'request_mock_stale_revision',
        serverTime: new Date().toISOString(),
        currentRunRevision: this.view.revision,
      },
    );
  }

  private command(clientCommandId: string, status: CommandReceipt['status']): CommandReceipt {
    const command: CommandReceipt = {
      commandId: `command_${clientCommandId}`,
      clientCommandId,
      status,
      acceptedAt: new Date().toISOString(),
      statusUrl: `/api/v3/runs/${this.view.runId}/commands/command_${clientCommandId}`,
    };
    this.commands.set(command.commandId, command);
    return command;
  }

  private bumpRevision(): void {
    this.view = {
      ...this.view,
      revision: this.view.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  private notFound(code: string, message: string): ThetaApiError {
    return new ThetaApiError(404, { code, category: 'not_found', message, retryable: false });
  }
}
