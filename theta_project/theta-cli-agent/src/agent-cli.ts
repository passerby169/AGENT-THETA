import { DoctorService } from './doctor-service.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';
import { renderUserError, renderValue } from './presentation/terminal-renderer.js';

export interface AgentCliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

export const isThetaAgentCommand = (args: readonly string[]): boolean =>
  ['doctor', 'start', 'status', 'audit', 'repl'].includes(args[0] ?? '');

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
      return runThetaWorkflowCliCommand(['run', ...rest], output);
    }
    if (command === 'status') {
      return runThetaWorkflowCliCommand(['status', ...rest], output);
    }
    if (command === 'audit') {
      const normalized = rest[0] === 'export' ? rest.slice(1) : rest;
      return runThetaWorkflowCliCommand(['trace', ...normalized], output);
    }
    if (command === 'repl') {
      throw new Error(
        'The legacy fixed-form REPL was removed. The V6 conversational REPL will be connected after Dataset, Research and Planner agents are implemented.',
      );
    }
    throw new Error(`Unsupported THETA V6 command: ${command ?? '(empty)'}`);
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

const hasFlag = (args: readonly string[], flag: string): boolean =>
  args.includes(`--${flag}`);
