import { readFile } from "node:fs/promises";
import path from "node:path";
import { ThetaAgentApplicationService } from './application/theta-agent-application-service.js';
import {
  renderUserError,
  renderActivityLine,
  renderPlanPresentation,
  renderValue,
} from "./presentation/terminal-renderer.js";

interface WorkflowCliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

interface ParsedWorkflowArguments {
  command?: string;
  flags: Map<string, string | boolean>;
}

export const thetaWorkflowHelp = `THETA workflow commands:
  workflow compile
      Compile the THETA DomainPack V6 and print the FSM contract summary.

  workflow run --file <dataset> [--run-id <id>] [--runtime-db <path>]
      Start the V6 LLM-led workflow and enter DatasetDiscovery.

  workflow discover --run-id <id> [--runtime-db <path>]
      Let MiniMax autonomously select governed tools and complete DatasetDiscovery.

  workflow research --run-id <id> [--runtime-db <path>]
      Continue the same memory-aware Agent through open ResearchDialogue.

  workflow plan --run-id <id> [--runtime-db <path>]
      Let the same Agent design, ground and validate a candidate plan.

  workflow prepare --run-id <id> [--runtime-db <path>]
      Compile the approved Canonical Plan and run preflight checks, then stop
      at the independent TrainingConfirmation checkpoint without training.

  workflow checkpoint --run-id <id> [--runtime-db <path>]
      Read the current conversational checkpoint.

  workflow message --run-id <id> --text <natural language> [--message-id <id>]
      Submit one user message to the current checkpoint and continue the Run.

  workflow conversation --run-id <id> [--runtime-db <path>]
      Read the persisted conversation projection.

  workflow activity --run-id <id> [--runtime-db <path>]
      Show the current safe Agent activity, recent Tool calls and semantic progress.

  workflow status --run-id <id> [--runtime-db <path>]
      Derive the current Run state from canonical Runtime events.

  workflow trace --run-id <id> [--runtime-db <path>]
      Print canonical orchestration events and governed tool trace events.

  workflow replay --run-id <id> [--runtime-db <path>]
      Derive a deterministic replay fixture from persisted events.`;

export const runThetaWorkflowCliCommand = async (
  args: string[],
  output: WorkflowCliOutput,
): Promise<number> => {
  try {
    const parsed = parseWorkflowArguments(args);
    if (!parsed.command || flag(parsed, "help")) {
      output.write(thetaWorkflowHelp);
      return 0;
    }

    const service = new ThetaAgentApplicationService();
    const runtimeDb = stringFlag(parsed, "runtime-db");
    const json = flag(parsed, "json");

    if (parsed.command === "compile") {
      write(service.compileSummary(), json, output);
      return 0;
    }
    if (parsed.command === "run") {
      const input = await workflowInput(parsed);
      const result = await service.createRun({
        filePath: input.filePath,
        ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
        allowRemoteSamples: input.allowRemoteSamples,
        ...(stringFlag(parsed, "run-id")
          ? { runId: stringFlag(parsed, "run-id") }
          : {}),
        ...(runtimeDb ? { runtimeDb } : {}),
        userId: stringFlag(parsed, 'user-id') ?? 'local_user',
        workspaceId: stringFlag(parsed, 'workspace-id') ?? 'local_workspace',
      });
      write(result, json, output);
      return 0;
    }
    if (parsed.command === "status") {
      const status = await service.status(
        requiredFlag(parsed, "run-id"),
        runtimeDb,
      );
      write(status, json, output);
      return 0;
    }
    if (parsed.command === 'discover') {
      const runId = requiredFlag(parsed, 'run-id');
      const discovered = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runDatasetDiscovery(runId, runtimeDb));
      write(discovered, json, output);
      return discovered.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'research') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runResearchDialogue(runId, runtimeDb));
      write(result, json, output);
      return result.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'plan') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runPlanDesign(runId, runtimeDb));
      if (!json && result.planPresentation) output.write(renderPlanPresentation(result.planPresentation));
      else write(result, json, output);
      return result.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'prepare') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.prepareTraining(runId, runtimeDb));
      write(result, json, output);
      return result.disposition === 'ready_for_training_confirmation' ? 0 : 2;
    }
    if (parsed.command === 'checkpoint') {
      write(await service.currentCheckpoint(requiredFlag(parsed, 'run-id'), runtimeDb), json, output);
      return 0;
    }
    if (parsed.command === 'conversation') {
      write(await service.conversation(requiredFlag(parsed, 'run-id'), runtimeDb), json, output);
      return 0;
    }
    if (parsed.command === 'activity') {
      write(await service.activities(requiredFlag(parsed, 'run-id'), runtimeDb), json, output);
      return 0;
    }
    if (parsed.command === 'message') {
      const runId = requiredFlag(parsed, 'run-id');
      const request = {
        runId,
        content: requiredFlag(parsed, 'text'),
        ...(stringFlag(parsed, 'message-id') ? { messageId: stringFlag(parsed, 'message-id') } : {}),
        ...(runtimeDb ? { runtimeDb } : {}),
        userId: stringFlag(parsed, 'user-id') ?? 'local_user',
        workspaceId: stringFlag(parsed, 'workspace-id') ?? 'local_workspace',
      };
      const snapshot = await service.status(runId, runtimeDb);
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, async () => snapshot.currentState === 'ResearchDialogue'
        ? service.submitResearchMessage(request)
        : snapshot.currentState === 'ResearchCheckpoint'
          ? service.submitResearchCheckpointMessage(request)
          : snapshot.currentState === 'PlanConfirmation'
            ? service.submitPlanConfirmationMessage(request)
          : service.submitCheckpointMessage(request));
      write(result, json, output);
      return 'continuation' in result && result.continuation?.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === "trace") {
      const evidence = await service.evidence(
        requiredFlag(parsed, "run-id"),
        runtimeDb,
      );
      write(evidence, json, output);
      return 0;
    }
    throw new Error(`Unknown workflow command: ${parsed.command}`);
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

const workflowInput = async (
  parsed: ParsedWorkflowArguments,
): Promise<{ filePath: string; initialMessage?: string; allowRemoteSamples: boolean }> => {
  const inputFile = stringFlag(parsed, "input");
  if (inputFile) {
    const value = JSON.parse(
      await readFile(path.resolve(inputFile), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("--input must contain a JSON object.");
    }
    const input = value as Record<string, unknown>;
    if (typeof input.filePath !== 'string') throw new Error('--input requires filePath.');
    return {
      filePath: path.resolve(process.cwd(), input.filePath),
      ...(typeof input.initialMessage === 'string' ? { initialMessage: input.initialMessage } : {}),
      allowRemoteSamples: input.allowRemoteSamples === true,
    };
  }
  return {
    filePath: path.resolve(process.cwd(), requiredFlag(parsed, "file")),
    ...(stringFlag(parsed, "goal")
      ? { initialMessage: stringFlag(parsed, "goal") }
      : {}),
    allowRemoteSamples: flag(parsed, 'allow-remote-samples'),
  };
};

const withActivityUpdates = async <T>(
  service: ThetaAgentApplicationService,
  runId: string,
  runtimeDb: string | undefined,
  json: boolean,
  output: WorkflowCliOutput,
  operation: () => Promise<T>,
): Promise<T> => {
  if (json) return operation();
  const seen = new Set<string>();
  let reading = false;
  const renderNew = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      const snapshot = await service.activities(runId, runtimeDb);
      for (const activity of snapshot.recent) {
        if (seen.has(activity.eventId)) continue;
        seen.add(activity.eventId);
        output.write(renderActivityLine(activity));
      }
    } finally {
      reading = false;
    }
  };
  await renderNew();
  const timer = setInterval(() => { void renderNew(); }, 750);
  try { return await operation(); }
  finally {
    clearInterval(timer);
    await renderNew();
  }
};

const parseWorkflowArguments = (args: string[]): ParsedWorkflowArguments => {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      if (command) throw new Error(`Unexpected workflow argument: ${value}`);
      command = value;
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
};

const write = (
  value: unknown,
  json: boolean,
  output: WorkflowCliOutput,
): void => {
  if (json) {
    output.write(JSON.stringify(value));
    return;
  }
  output.write(renderValue(value));
};

const flag = (parsed: ParsedWorkflowArguments, name: string): boolean =>
  parsed.flags.get(name) === true;

const stringFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const requiredFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): string => {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
};

const integerFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): number | undefined => {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Option --${name} must be a positive integer.`);
  }
  return parsedValue;
};

const optionalJsonFlag = async (
  parsed: ParsedWorkflowArguments,
  name: string,
): Promise<Record<string, unknown> | undefined> => {
  const filename = stringFlag(parsed, name);
  if (!filename) return undefined;
  const value = JSON.parse(
    await readFile(path.resolve(process.cwd(), filename), "utf8"),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--${name} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
};
