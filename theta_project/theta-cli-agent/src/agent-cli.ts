import { DoctorService } from './doctor-service.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';
import { renderUserError, renderValue } from './presentation/terminal-renderer.js';
import { ThetaInteractiveShell } from './interactive/theta-interactive-shell.js';

export interface AgentCliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

export const isThetaAgentCommand = (args: readonly string[]): boolean =>
  ['doctor', 'start', 'status', 'advance', 'cancel', 'audit', 'interactive', 'repl'].includes(args[0] ?? '');

export const runThetaAgentCliCommand = async (
  args: string[],
  output: AgentCliOutput,
): Promise<number> => {
  try {
    const [command, ...rest] = args;
    if (command === 'doctor') {
      const report = await new DoctorService().run();
      output.write(hasFlag(rest, 'json') ? JSON.stringify(report) : renderValue(report));
      return report.status === 'blocked' ? 2 : 0;
    }
    if (command === 'start') {
      if (!hasOption(rest, 'file') && !hasOption(rest, 'dataset-ref') && process.stdin.isTTY) {
        return new ThetaInteractiveShell().run();
      }
      return runThetaWorkflowCliCommand(['run', ...rest], output);
    }
    if (command === 'status') {
      return runThetaWorkflowCliCommand(['status', ...rest], output);
    }
    if (command === 'advance') {
      return runThetaWorkflowCliCommand(['advance', ...rest], output);
    }
    if (command === 'cancel') {
      return runThetaWorkflowCliCommand(['cancel', ...rest], output);
    }
    if (command === 'audit') {
      const normalized = rest[0] === 'export' ? rest.slice(1) : rest;
      return runThetaWorkflowCliCommand(['trace', ...normalized], output);
    }
    if (command === 'interactive' || command === 'repl') {
      if (!process.stdin.isTTY) throw new Error('交互模式需要在可输入的终端中运行。');
      return new ThetaInteractiveShell().run();
    }
    throw new Error(`Unsupported THETA V6 command: ${command ?? '(empty)'}`);
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

const hasFlag = (args: readonly string[], flag: string): boolean =>
  args.includes(`--${flag}`);

const hasOption = (args: readonly string[], option: string): boolean =>
  args.some((item) => item === `--${option}` || item.startsWith(`--${option}=`));
