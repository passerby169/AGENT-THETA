import { createInterface } from 'node:readline';
import { ConversationService } from './conversation/conversation-service.js';
import { SQLiteConversationStore } from './storage/sqlite-conversation-store.js';
import { ThetaTurnOrchestrator } from './conversation/turn-orchestrator.js';
import { ThetaConversationWorkflowExecutor } from './conversation/workflow-executor.js';
import { DoctorService, type DoctorReport } from './doctor-service.js';
import {
  ThetaOperatorCommandService,
  type OperatorCommandExecutor,
  type OperatorInvocation,
} from './operator-command-service.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';
import { ThetaWorkflowService } from './theta-workflow-service.js';
import { defaultThetaWorkflowDb } from './theta-workflow-runtime.js';
import {
  renderUserError,
  renderValue,
} from './presentation/terminal-renderer.js';
import { TrainingFollowController } from './training/training-follow-controller.js';
import { ResultService } from './results/result-service.js';
import { listLocalRuns } from './storage/run-catalog.js';

export interface AgentCliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

export interface AgentCliDependencies {
  conversation?: ConversationService;
  doctor?: DoctorService;
  executor?: ThetaConversationWorkflowExecutor;
  operator?: OperatorCommandExecutor;
}

export const agentCommandNames = new Set([
  'doctor',
  'start',
  'resume',
  'status',
  'audit',
  'evidence',
  'rag',
  'train',
  'language',
  'answer',
  'columns',
  'repl',
]);

export const isThetaAgentCommand = (args: readonly string[]): boolean => {
  const [command, subcommand] = args;
  if (command && agentCommandNames.has(command)) return true;
  if (command !== 'plan') return false;
  if (subcommand === 'show') return true;
  return (
    subcommand === 'approve' &&
    args.some(
      (argument) =>
        argument === '--run-id' || argument.startsWith('--run-id='),
    )
  );
};

export const runThetaAgentCliCommand = async (
  args: string[],
  output: AgentCliOutput,
  dependencies: AgentCliDependencies = {},
): Promise<number> => {
  try {
    const conversation =
      dependencies.conversation ?? new ConversationService();
    const invocation = conversation.parseInvocation(args);
    if (invocation.kind === 'workflow') {
      return runThetaWorkflowCliCommand(
        [
          invocation.action === 'start' ? 'run' : 'resume',
          ...invocation.args,
        ],
        output,
      );
    }
    if (invocation.kind === 'status') {
      return runThetaWorkflowCliCommand(
        [
          'status',
          '--run-id',
          invocation.runId,
          ...(invocation.runtimeDb
            ? ['--runtime-db', invocation.runtimeDb]
            : []),
          ...(invocation.json ? ['--json'] : []),
        ],
        output,
      );
    }
    if (invocation.kind === 'audit') {
      return runThetaWorkflowCliCommand(
        [
          'trace',
          '--run-id',
          invocation.runId,
          ...(invocation.runtimeDb
            ? ['--runtime-db', invocation.runtimeDb]
            : []),
          ...(invocation.json ? ['--json'] : []),
        ],
        output,
      );
    }
    if (invocation.kind === 'doctor') {
      const report = await (dependencies.doctor ?? new DoctorService()).run();
      writeDoctor(report, invocation.json, output);
      return report.status === 'blocked' ? 2 : 0;
    }
    if (invocation.kind === 'conversationTurn') {
      const runtimeDb = invocation.runtimeDb ?? defaultThetaWorkflowDb();
      const store = new SQLiteConversationStore(runtimeDb);
      try {
        const orchestrator = new ThetaTurnOrchestrator(store);
        const result = await withActivityHeartbeat(
          '正在理解你的回答',
          output,
          () =>
            orchestrator.execute(
              { kind: invocation.action, text: invocation.text },
              {
                sessionId: invocation.sessionId ?? 'theta-cli-local-session',
                activeRunId: invocation.runId,
                runtimeDb,
              },
            ),
        );
        output.write(
          invocation.json
            ? JSON.stringify(result.value)
            : renderValue(result.value),
        );
        return 0;
      } finally {
        store.close();
      }
    }
    if (invocation.kind !== 'repl') {
      const value = await (
        dependencies.operator ?? new ThetaOperatorCommandService()
      ).execute(invocation as OperatorInvocation);
      output.write(
        invocation.json
          ? JSON.stringify(value)
          : renderValue(value),
      );
      return 0;
    }
    await runRepl(
      {
        activeRunId: invocation.runId,
        runtimeDb: invocation.runtimeDb,
      },
      output,
      conversation,
      dependencies.executor ?? new ThetaConversationWorkflowExecutor(),
    );
    return 0;
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

interface ReplOptions {
  activeRunId?: string;
  runtimeDb?: string;
}

export const runRepl = async (
  options: ReplOptions,
  output: AgentCliOutput,
  conversation = new ConversationService(),
  executor = new ThetaConversationWorkflowExecutor(),
): Promise<void> => {
  const runtimeDb = options.runtimeDb ?? defaultThetaWorkflowDb();
  const store = new SQLiteConversationStore(runtimeDb);
  const orchestrator = new ThetaTurnOrchestrator(
    store,
    new ThetaWorkflowService(),
    undefined,
    executor,
  );
  const workflow = new ThetaWorkflowService();
  const follower = new TrainingFollowController(workflow);
  const results = new ResultService(workflow);
  const sessionId = 'theta-cli-local-session';
  let activeRunId = options.activeRunId;
  if (activeRunId) {
    try {
      await workflow.status(activeRunId, runtimeDb);
    } catch (error) {
      output.writeError(renderUserError(error));
      activeRunId = undefined;
    }
  }
  store.getOrCreateSession(sessionId, { activeRunId });
  if (!activeRunId && options.activeRunId) {
    store.updateSession(sessionId, { activeRunId: null });
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  let lastRawValue: unknown;
  output.write(
    '\nTHETA 研究训练助手\n\n直接用自然语言回答问题；使用 /llm on 开启 MiniMax，/next 查看下一步，/help 查看命令。\n',
  );
  if (readline.terminal) readline.setPrompt('theta-agent> ');
  if (readline.terminal) readline.prompt();
  try {
    for await (const line of readline) {
      try {
        const command = conversation.parseReplLine(line);
        if (command.kind === 'exit') break;
        if (command.kind === 'details') {
          output.write(
            lastRawValue === undefined
              ? '\n还没有可展开的技术详情。'
              : JSON.stringify(lastRawValue, null, 2),
          );
          if (readline.terminal) readline.prompt();
          continue;
        }
        if (command.kind === 'runs') {
          lastRawValue = {
            kind: 'run.catalog',
            runs: listLocalRuns(runtimeDb),
          };
          output.write(renderValue(lastRawValue));
          if (readline.terminal) readline.prompt();
          continue;
        }
        if (
          command.kind === 'results' ||
          command.kind === 'openResults' ||
          command.kind === 'summary' ||
          command.kind === 'logs' ||
          command.kind === 'cancel'
        ) {
          if (!activeRunId) {
            throw new Error('No active Run. Use /start <dataset> first.');
          }
          lastRawValue =
            command.kind === 'logs'
              ? await results.logs(activeRunId, runtimeDb)
              : command.kind === 'openResults'
                ? await results.open(activeRunId, runtimeDb)
                : command.kind === 'cancel'
                  ? await results.cancel(
                      activeRunId,
                      runtimeDb,
                      command.text,
                      command.confirm,
                    )
                  : {
                      ...(await results.overview(activeRunId, runtimeDb)),
                      ...(command.kind === 'summary'
                        ? { kind: 'run.summary' }
                        : {}),
                    };
          output.write(renderValue(lastRawValue));
          if (readline.terminal) readline.prompt();
          continue;
        }
        if (command.kind === 'follow') {
          if (!activeRunId) {
            throw new Error('No active Run. Use /start <dataset> first.');
          }
          lastRawValue = await followTraining(
            activeRunId,
            runtimeDb,
            follower,
            output,
          );
          if (readline.terminal) readline.prompt();
          continue;
        }
        if (command.kind === 'retry') {
          if (!activeRunId) {
            throw new Error('No active Run. Use /start <dataset> first.');
          }
          lastRawValue = await results.retry(activeRunId, runtimeDb);
          output.write(renderValue(lastRawValue));
          if (readline.terminal) readline.prompt();
          continue;
        }
        if (command.kind === 'help') {
          output.write(replHelp);
        } else if (command.kind === 'back') {
          activeRunId = undefined;
          store.updateSession(sessionId, { activeRunId: null });
          output.write('Active Run cleared.');
        } else {
          const languageEnabled =
            store.getSession(sessionId)?.languageConsent === true;
          const usesLanguage =
            languageEnabled &&
            ['answer', 'columns', 'natural'].includes(command.kind);
          const result = usesLanguage
            ? await withActivityHeartbeat(
                command.kind === 'columns'
                  ? '正在理解列角色'
                  : '正在理解你的回答并准备下一步',
                output,
                () =>
                  orchestrator.execute(command, {
                    sessionId,
                    activeRunId,
                    runtimeDb,
                  }),
              )
            : await orchestrator.execute(command, {
                sessionId,
                activeRunId,
                runtimeDb,
              });
          activeRunId = result.activeRunId ?? activeRunId;
          lastRawValue = result.value;
          output.write(renderValue(result.value));
          if (
            (command.kind === 'startTraining' ||
              command.kind === 'approve') &&
            asRecord(result.value)?.currentState === 'MonitorTraining' &&
            activeRunId
          ) {
            lastRawValue = await followTraining(
              activeRunId,
              runtimeDb,
              follower,
              output,
            );
          }
        }
      } catch (error) {
        output.writeError(renderUserError(error));
      }
      if (readline.terminal) readline.prompt();
    }
  } finally {
    readline.close();
    store.close();
  }
};

const replHelp = `THETA 交互命令
  /start <数据文件>       创建持久化训练任务
  /answer <回答>          显式提交研究问题回答
  /columns <说明>         确认正文、时间、ID 和元数据列
  /llm on|off             开启或关闭 MiniMax 语言辅助
  /brief                  查看当前研究档案
  /history                查看已持久化的最近对话
  /next                   查看当前推荐的下一步
  /details                展开上一条响应的机器详情
  /status [runId]         查看任务状态
  /why [runId]            解释当前状态和原因
  /evidence [runId]       查看受治理证据摘要
  /plan [runId]           查看完整候选或正式训练方案
  /approve-plan           审批 1/2：固化训练方案
  /approve-plan --accept-degradation
                         明确接受未满足的研究能力后固化方案
  /start-training         审批 2/2：启动真实训练
  /approve [runId]        按当前阶段执行审批的兼容命令
  /adjust <修改内容>      自然语言调整模型或参数
  /follow                 自动跟踪训练直至终态
  /logs                   查看最近训练日志
  /results                查看当前任务的结果和产物
  /open-results           打开当前任务结果目录
  /summary                解读真实指标和结果
  /runs                   列出本地持久化任务
  /cancel <原因>          预览取消；添加 --confirm 执行
  /save [runId]           生成确定性 Replay
  /back                   清除当前活动任务
  /exit                   退出`;

const writeDoctor = (
  report: DoctorReport,
  json: boolean,
  output: AgentCliOutput,
): void => {
  if (json) {
    output.write(JSON.stringify(report));
    return;
  }
  output.write(
    [
      `THETA doctor: ${report.status.toUpperCase()}`,
      ...report.checks.map(
        (check) =>
          `[${check.status}] ${check.id}: ${check.message}${
            check.remediation ? `\n  Fix: ${check.remediation}` : ''
          }`,
      ),
    ].join('\n'),
  );
};

const followTraining = async (
  runId: string,
  runtimeDb: string,
  follower: TrainingFollowController,
  output: AgentCliOutput,
): Promise<unknown> => {
  let detached = false;
  let lastSignature = '';
  const onSigint = (): void => {
    detached = true;
    output.write(
      '\n已停止前台跟踪，后台训练不会被取消。稍后使用 /follow 可以继续查看。',
    );
  };
  process.once('SIGINT', onSigint);
  try {
    const result = await follower.follow({
      runId,
      runtimeDb,
      shouldStop: () => detached,
      onUpdate: (value) => {
        const record = asRecord(value);
        const receipt = asRecord(record?.trainingReceipt);
        const signature = [
          record?.currentState,
          receipt?.progress,
          receipt?.currentStep,
          record?.status,
        ].join('|');
        if (signature !== lastSignature) {
          lastSignature = signature;
          output.write(renderValue(value));
        }
      },
      onHeartbeat: (elapsedMs, _polls, value) => {
        const record = asRecord(value);
        const receipt = asRecord(record?.trainingReceipt);
        const stage = receipt?.currentStep
          ? humanTrainingStage(String(receipt.currentStep))
          : '';
        const progress =
          typeof receipt?.progress === 'number'
            ? ` · ${String(receipt.progress)}%`
            : '';
        output.write(
          `训练仍在进行（已等待 ${formatElapsed(elapsedMs)}）${stage ? ` · ${stage}${progress}` : progress}。按 Ctrl+C 只停止前台跟踪，不会取消训练。`,
        );
      },
    });
    return result.final;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
};

const humanTrainingStage = (stage: string): string =>
  ({
    queued: '等待后台执行',
    prepare_data: '读取并准备数据',
    data_prepared: '数据准备完成',
    run_pipeline: '训练模型',
    evaluate_model: '评估模型',
    generate_visualizations: '生成图表',
    verify_visualizations: '验证图表',
    bind_results: '整理并绑定结果',
    completed: '训练完成',
  })[stage] ?? stage;

const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const withActivityHeartbeat = async <T>(
  label: string,
  output: AgentCliOutput,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = Date.now();
  output.write(`${label}……`);
  const timer = setInterval(() => {
    output.write(
      `${label}，已等待 ${formatElapsed(Date.now() - startedAt)}，仍在处理……`,
    );
  }, 15_000);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
};

const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
