import path from 'node:path';
import { ThetaAgentApplicationService } from '../application/theta-agent-application-service.js';
import type { DatasetUploadRequestRecord } from '../datasets/dataset-attachment-broker.js';
import { DatasetIngestionService } from '../datasets/dataset-ingestion-service.js';
import { DoctorService } from '../doctor-service.js';
import { defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import {
  renderActivityLine,
  renderConfirmationCard,
  renderPhaseEnd,
  renderPhaseStart,
  renderValue,
} from '../presentation/terminal-renderer.js';
import {
  datasetPathCard,
  datasetUploadCard,
  runCreatedCard,
  sampleConsentCard,
  trainingAuthorizationCard,
  welcomeCard,
  stagedAttachmentCard,
} from './cards.js';
import { askChoice, askNonEmpty, ReadlineInteractiveTerminal, type InteractiveTerminal } from './terminal-io.js';

export interface ThetaInteractiveShellOptions {
  runtimeDb?: string;
  uploadDir?: string;
  userId?: string;
  workspaceId?: string;
  terminal?: InteractiveTerminal;
  application?: ThetaAgentApplicationService;
}

export class ThetaInteractiveShell {
  private readonly runtimeDb: string;
  private readonly uploadDir: string;
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly terminal: InteractiveTerminal;
  private readonly application: ThetaAgentApplicationService;
  private readonly ingestion: DatasetIngestionService;

  constructor(options: ThetaInteractiveShellOptions = {}) {
    this.runtimeDb = path.resolve(options.runtimeDb ?? defaultThetaV6RuntimeDb());
    this.uploadDir = path.resolve(options.uploadDir ?? process.env.THETA_DATASET_UPLOAD_DIR ?? path.join(path.dirname(this.runtimeDb), 'uploads'));
    this.userId = options.userId ?? 'local_user';
    this.workspaceId = options.workspaceId ?? 'local_workspace';
    this.terminal = options.terminal ?? new ReadlineInteractiveTerminal();
    this.application = options.application ?? new ThetaAgentApplicationService();
    this.ingestion = new DatasetIngestionService({ runtimeDb: this.runtimeDb, managedRoot: this.uploadDir });
  }

  async run(): Promise<number> {
    try {
      while (true) {
        this.terminal.write(welcomeCard());
        const choice = await askChoice(this.terminal, '\n请输入 1-4：', ['1', '2', '3', '4']);
        if (choice === '4') return 0;
        if (choice === '3') {
          this.terminal.write(renderValue(await new DoctorService().run()));
          await this.terminal.question('\n按回车返回欢迎页...');
          continue;
        }
        if (choice === '2') {
          const runId = await askNonEmpty(this.terminal, '\n请输入之前的任务标识：');
          if (runId === '/cancel') continue;
          try {
            await this.application.status(runId, this.runtimeDb);
            await this.runSession(runId);
          } catch (error) {
            this.terminal.writeError(this.interactiveError(error));
            await this.terminal.question('\n按回车返回欢迎页...');
          }
          continue;
        }
        try {
          const created = await this.application.createRun({
            runtimeDb: this.runtimeDb,
            userId: this.userId,
            workspaceId: this.workspaceId,
          });
          this.terminal.write(runCreatedCard(created.runId));
          await this.runSession(created.runId);
        } catch (error) {
          this.terminal.writeError(this.interactiveError(error));
          await this.terminal.question('\n按回车返回欢迎页...');
        }
      }
    } finally {
      this.terminal.close();
    }
  }

  private async receiveRequestedAttachment(
    runId: string,
    request: DatasetUploadRequestRecord,
  ): Promise<boolean> {
    while (true) {
      this.terminal.write(datasetPathCard(request));
      const filePath = await askNonEmpty(this.terminal, '\n数据文件路径：');
      if (filePath === '/cancel') return false;
      try {
        const inspected = await this.ingestion.inspectLocalFile(filePath);
        this.terminal.write(datasetUploadCard(inspected));
        const choice = await askChoice(this.terminal, '\n请输入 1-3：', ['1', '2', '3']);
        if (choice === '3') return false;
        if (choice === '2') continue;
        this.terminal.write(sampleConsentCard());
        const consent = await askChoice(this.terminal, '\n请输入 1 或 2：', ['1', '2']);
        this.terminal.write('→ CLI Host 正在暂存文件并生成作用域受限的附件引用');
        const staged = await this.application.stageDatasetAttachment({
          runId,
          uploadRequestId: request.uploadRequestId,
          filePath,
          runtimeDb: this.runtimeDb,
          uploadRoot: this.uploadDir,
          userId: this.userId,
          workspaceId: this.workspaceId,
          allowRemoteSamples: consent === '1',
        });
        this.terminal.write(stagedAttachmentCard(staged));
        return true;
      } catch (error) {
        this.terminal.writeError(this.interactiveError(error));
        const retry = await askChoice(this.terminal, '\n[1] 重新选择  [2] 返回欢迎页：', ['1', '2']);
        if (retry === '2') return false;
      }
    }
  }

  private async runSession(runId: string): Promise<void> {
    for (let step = 0; step < 500; step += 1) {
      const snapshot = await this.application.status(runId, this.runtimeDb);
      const state = snapshot.currentState;
      if (!state) throw new Error('当前任务没有可恢复的 FSM 状态。');

      if (state === 'Intake') {
        if (snapshot.status === 'waiting_human') {
          if (snapshot.pendingActionRef?.startsWith('theta.intake.question:')) {
            const answer = await this.askConversation(snapshot.pendingReason ?? '你想怎样开始使用 THETA？');
            if (answer === null) return;
            const result = await this.runVisible(runId, () => this.application.submitIntakeMessage({
              runId,
              content: answer,
              runtimeDb: this.runtimeDb,
              uploadRoot: this.uploadDir,
              userId: this.userId,
              workspaceId: this.workspaceId,
            }));
            if (result.disposition === 'recoverable_error') throw new Error(result.error ?? 'Intake Agent 未能完成本轮对话。');
            continue;
          }
          const request = this.application.currentDatasetUploadRequest(runId, this.runtimeDb, this.uploadDir);
          if (!request || request.uploadRequestId !== snapshot.pendingActionRef) {
            throw new Error('FSM 正在等待上传，但找不到与当前任务绑定的上传请求。');
          }
          if (!await this.receiveRequestedAttachment(runId, request)) return;
        } else {
          const result = await this.runVisible(runId, () => this.application.runIntake(runId, this.runtimeDb, this.uploadDir));
          if (result.disposition === 'recoverable_error') throw new Error(result.error ?? 'Intake Agent 未能完成本轮动作。');
        }
        continue;
      }

      if (state === 'DatasetDiscovery') {
        if (snapshot.status === 'waiting_human') {
          const answer = await this.askConversation(snapshot.pendingReason ?? '请补充数据理解所需的信息。');
          if (answer === null) return;
          await this.runVisible(runId, () => this.application.submitDatasetDiscoveryMessage({ runId, content: answer, runtimeDb: this.runtimeDb, userId: this.userId, workspaceId: this.workspaceId }));
        } else {
          await this.runVisible(runId, () => this.application.runDatasetDiscovery(runId, this.runtimeDb));
        }
        continue;
      }

      if (state === 'ResearchDialogue') {
        if (snapshot.status === 'waiting_human') {
          const answer = await this.askConversation(snapshot.pendingReason ?? '请补充你的研究意图。');
          if (answer === null) return;
          await this.runVisible(runId, () => this.application.submitResearchMessage({ runId, content: answer, runtimeDb: this.runtimeDb, userId: this.userId, workspaceId: this.workspaceId }));
        } else {
          await this.runVisible(runId, () => this.application.runResearchDialogue(runId, this.runtimeDb));
        }
        continue;
      }

      if (state === 'DatasetCheckpoint' || state === 'ResearchCheckpoint' || state === 'PlanConfirmation') {
        const checkpoint = await this.application.currentCheckpoint(runId, this.runtimeDb);
        if (!checkpoint || checkpoint.status !== 'proposed') throw new Error('当前确认卡不存在或已经过期。');
        this.terminal.write(renderConfirmationCard(checkpoint, { includeCommands: false }));
        const choice = await askChoice(this.terminal, '\n请输入 1 或 2：', ['1', '2']);
        if (choice === '1') {
          await this.runVisible(runId, () => this.application.decideCheckpoint({
            runId,
            action: 'approve',
            checkpointId: checkpoint.checkpointId,
            expectedContentHash: checkpoint.contentHash,
            runtimeDb: this.runtimeDb,
            userId: this.userId,
            workspaceId: this.workspaceId,
          }));
        } else {
          const feedback = await askNonEmpty(this.terminal, '请说明原因或需要修改的内容：');
          if (feedback === '/cancel') return;
          await this.runVisible(runId, () => this.application.decideCheckpoint({
            runId,
            action: 'revise',
            feedback,
            checkpointId: checkpoint.checkpointId,
            expectedContentHash: checkpoint.contentHash,
            runtimeDb: this.runtimeDb,
            userId: this.userId,
            workspaceId: this.workspaceId,
          }));
        }
        continue;
      }

      if (state === 'PlanDesign') {
        await this.runVisible(runId, () => this.application.runPlanDesign(runId, this.runtimeDb));
        continue;
      }

      if (state === 'CreatePlan' || state === 'DryRun') {
        const result = await this.runVisible(runId, () => this.application.prepareTraining(runId, this.runtimeDb));
        this.terminal.write(result.summary);
        continue;
      }

      if (state === 'TrainingConfirmation') {
        const checkpoint = await this.application.currentCheckpoint(runId, this.runtimeDb);
        if (!checkpoint || checkpoint.kind !== 'training' || checkpoint.status !== 'proposed') throw new Error('训练授权内容不存在或已经过期。');
        this.terminal.write(trainingAuthorizationCard(checkpoint.summaryForUser));
        const choice = await askChoice(this.terminal, '\n请输入 1-3：', ['1', '2', '3']);
        if (choice === '3') return;
        const content = choice === '1'
          ? '我已阅读当前训练方案和训练前检查结果，无条件批准立即启动训练。'
          : await askNonEmpty(this.terminal, '请说明为什么暂不批准，或希望如何修改计划：');
        if (content === '/cancel') return;
        await this.runVisible(runId, () => this.application.submitTrainingConfirmationMessage({ runId, content, runtimeDb: this.runtimeDb, userId: this.userId, workspaceId: this.workspaceId }));
        continue;
      }

      if (state === 'VerifyDataset' || state === 'StartTraining' || state === 'EvaluateResults') {
        const result = await this.runVisible(runId, () => this.application.advanceTraining(runId, this.runtimeDb));
        this.terminal.write(result.summary);
        if (result.results) this.terminal.write(renderValue(result.results));
        continue;
      }

      if (state === 'MonitorTraining') {
        const result = await this.runVisible(runId, () => this.application.advanceTraining(runId, this.runtimeDb));
        this.terminal.write(result.summary);
        if (result.disposition === 'monitoring') {
          const answer = (await this.terminal.question('\n按回车刷新训练状态，输入 /exit 暂停查看：')).trim();
          if (answer === '/exit') return;
        }
        continue;
      }

      if (state === 'Completed') {
        this.terminal.write('✓ 当前研究、训练和结果验证流程已经完成。');
        await this.terminal.question('\n按回车返回欢迎页...');
        return;
      }

      if (state === 'Cancelled') {
        this.terminal.write('当前训练已经取消。你可以返回欢迎页开始新任务。');
        await this.terminal.question('\n按回车返回欢迎页...');
        return;
      }

      if (state === 'Failed' || state === 'HumanRecovery' || state === 'Quarantined') {
        this.terminal.writeError([
          `当前任务进入“${state}”状态，自动流程已经安全停止。`,
          ...(snapshot.recoveryReason
            ? [`原因：${snapshot.recoveryReason}`]
            : snapshot.pendingReason ? [`原因：${snapshot.pendingReason}`] : []),
          `任务标识：${runId}`,
          '运行 theta doctor 检查环境，修复后可从欢迎页继续这个任务。',
        ].join('\n'));
        await this.terminal.question('\n按回车返回欢迎页...');
        return;
      }

      this.terminal.writeError(`当前任务停在 ${state}，需要人工处理后再继续。`);
      return;
    }
    throw new Error('交互会话超过安全步数限制，请稍后使用任务标识继续。');
  }

  private async askConversation(question: string): Promise<string | null> {
    this.terminal.write(['', 'Agent', question, '', '你可以直接用自然语言回答；输入 /exit 暂停并稍后继续。'].join('\n'));
    const answer = await askNonEmpty(this.terminal, '\n你的回答：');
    return answer === '/exit' ? null : answer;
  }

  private async runVisible<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const seen = new Set<string>();
    const initial = await this.application.activities(runId, this.runtimeDb);
    const startingState = (await this.application.status(runId, this.runtimeDb)).currentState;
    for (const activity of initial.recent) seen.add(activity.eventId);
    this.terminal.write(renderPhaseStart(startingState ?? initial.phase));
    let queue = Promise.resolve();
    const renderNew = async (): Promise<void> => {
      const task = queue.then(async () => {
        const snapshot = await this.application.activities(runId, this.runtimeDb);
        for (const activity of snapshot.recent) {
          if (seen.has(activity.eventId)) continue;
          seen.add(activity.eventId);
          this.terminal.write(renderActivityLine(activity));
        }
      });
      queue = task.catch(() => undefined);
      await task;
    };
    const timer = setInterval(() => { void renderNew().catch(() => undefined); }, 500);
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      await renderNew();
      const endingState = (await this.application.status(runId, this.runtimeDb)).currentState;
      this.terminal.write(renderPhaseEnd(startingState ?? initial.phase, endingState));
    }
  }

  private interactiveError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const infrastructureHint = /ECONNREFUSED|Mongo|Redis|27017|6379/iu.test(message)
      ? '\n本地 Memory 服务可能未启动；请先启动 MongoDB Replica Set 和 Redis，或从欢迎页运行环境检查。'
      : '';
    return `操作未完成\n${message}${infrastructureHint}`;
  }
}
