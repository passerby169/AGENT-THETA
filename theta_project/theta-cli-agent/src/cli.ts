#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isThetaAgentCommand, runThetaAgentCliCommand } from './agent-cli.js';
import { loadThetaProjectEnvironment } from './environment.js';
import { renderUserError } from './presentation/terminal-renderer.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';

interface CliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

const output: CliOutput = {
  write: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

const help = `THETA V6 CLI Agent

Usage:
  theta
  theta interactive
  theta doctor [--json]
  theta start
  theta start --file <dataset> [--goal <text>] [--allow-remote-samples]
  theta workflow intake --run-id <id> [--runtime-db <path>]
  theta workflow discover --run-id <id> [--runtime-db <path>]
  theta workflow prepare --run-id <id> [--runtime-db <path>]
  theta advance --run-id <id> [--runtime-db <path>]
  theta cancel --run-id <id> [--reason <text>] [--runtime-db <path>]
  theta workflow checkpoint --run-id <id>
  theta workflow decide --run-id <id> (--approve | --revise --text <reason>)
  theta workflow message --run-id <id> --text <research answer>
  theta workflow activity --run-id <id> [--runtime-db <path>]
  theta status --run-id <id> [--runtime-db <path>]
  theta audit export --run-id <id> [--runtime-db <path>]
  theta workflow compile

Run theta (or theta start without a dataset) in an interactive terminal to meet
the Agent first; it will explain the workflow and request data only when useful. Non-interactive commands remain
available for scripts and debugging.`;

export const runCli = async (args: string[], target: CliOutput = output): Promise<number> => {
  try {
    const normalized = args[0] === '--' ? args.slice(1) : args;
    if (normalized.includes('--help') || normalized.includes('-h')) {
      target.write(help);
      return 0;
    }
    if (normalized.length === 0) {
      if (!process.stdin.isTTY) {
        target.write(help);
        return 0;
      }
      return runThetaAgentCliCommand(['interactive'], target);
    }
    if (isThetaAgentCommand(normalized)) return runThetaAgentCliCommand(normalized, target);
    if (normalized[0] === 'workflow') return runThetaWorkflowCliCommand(normalized.slice(1), target);
    throw new Error(`Unknown V6 command: ${normalized.join(' ')}`);
  } catch (error) {
    target.writeError(renderUserError(error));
    return 1;
  }
};

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  loadThetaProjectEnvironment();
  process.exitCode = await runCli(process.argv.slice(2));
}
