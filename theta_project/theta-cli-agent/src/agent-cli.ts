import { createInterface } from 'node:readline';
import { ConversationService } from './conversation/conversation-service.js';
import { ThetaConversationWorkflowExecutor } from './conversation/workflow-executor.js';
import { DoctorService, type DoctorReport } from './doctor-service.js';
import {
  ThetaOperatorCommandService,
  type OperatorCommandExecutor,
  type OperatorInvocation,
} from './operator-command-service.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';

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
    if (invocation.kind !== 'repl') {
      const value = await (
        dependencies.operator ?? new ThetaOperatorCommandService()
      ).execute(invocation as OperatorInvocation);
      output.write(
        invocation.json
          ? JSON.stringify(value)
          : JSON.stringify(value, null, 2),
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
    output.writeError(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  let activeRunId = options.activeRunId;
  output.write(
    'THETA deterministic REPL. Use /help; free-form model chat is disabled.',
  );
  if (readline.terminal) readline.setPrompt('theta-agent> ');
  if (readline.terminal) readline.prompt();
  try {
    for await (const line of readline) {
      try {
        const command = conversation.parseReplLine(line);
        if (command.kind === 'exit') break;
        if (command.kind === 'help') {
          output.write(replHelp);
        } else if (command.kind === 'back') {
          activeRunId = undefined;
          output.write('Active Run cleared.');
        } else {
          const result = await executor.execute(command, {
            activeRunId,
            runtimeDb: options.runtimeDb,
          });
          activeRunId = result.activeRunId ?? activeRunId;
          output.write(JSON.stringify(result.value, null, 2));
        }
      } catch (error) {
        output.writeError(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (readline.terminal) readline.prompt();
    }
  } finally {
    readline.close();
  }
};

const replHelp = `Deterministic REPL commands:
  /start <dataset>  Start a durable event-first Run.
  /status [runId]   Read the canonical Run projection.
  /why [runId]      Explain state from reason codes, guards, and EvidenceRefs.
  /evidence [runId] Read orchestration and governed tool events.
  /plan [runId]     Show the current plan-review projection.
  /approve [runId]  Resolve the current simple HumanWait explicitly.
  /save [runId]     Print a deterministic replay fixture to the terminal.
  /back             Clear the active Run.
  /exit             Leave the REPL.`;

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
