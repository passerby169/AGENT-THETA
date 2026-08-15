import { readFile } from "node:fs/promises";
import { createInterface } from 'node:readline/promises';
import path from "node:path";
import { ThetaAgentApplicationService } from './application/theta-agent-application-service.js';
import { presentConfirmationCard } from './checkpoints/confirmation-card-presenter.js';
import {
  renderUserError,
  renderActivityLine,
  renderActivitySnapshot,
  renderPhaseEnd,
  renderPhaseStart,
  renderConfirmationCard,
  renderValue,
  renderWorkflowOutcome,
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

  workflow intake --run-id <id> [--runtime-db <path>]
      Let MiniMax request or ingest a Run-scoped dataset attachment.

  workflow discover --run-id <id> [--runtime-db <path>]
      Let MiniMax autonomously select governed tools and complete DatasetDiscovery.

  workflow research --run-id <id> [--runtime-db <path>]
      Continue the same memory-aware Agent through open ResearchDialogue.

  workflow plan --run-id <id> [--runtime-db <path>]
      Let the same Agent design, ground and validate a candidate plan.

  workflow prepare --run-id <id> [--runtime-db <path>]
      Compile the approved Canonical Plan and run preflight checks, then stop
      at the independent TrainingConfirmation checkpoint without training.

  workflow advance --run-id <id> [--runtime-db <path>]
      Execute exactly one governed training lifecycle step and show every Tool call.

  workflow cancel --run-id <id> [--runtime-db <path>] [--reason <text>]
      Request cooperative cancellation of the current training run.

  workflow checkpoint --run-id <id> [--runtime-db <path>]
      Show the current confirmation card and, in an interactive terminal,
      choose “yes, next phase” or “no, explain why”.

  workflow decide --run-id <id> (--approve | --revise --text <reason>)
      Deterministically approve a data/research/plan checkpoint, or submit
      natural-language revision feedback to MiniMax.

  workflow message --run-id <id> --text <natural language> [--message-id <id>]
      Reply to an ordinary Intake, DatasetDiscovery, or ResearchDialogue question.
      Final confirmation cards use workflow decide instead.

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
      writeOutcome(result, json, output);
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
      writeOutcome(discovered, json, output);
      return discovered.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'research') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runResearchDialogue(runId, runtimeDb));
      writeOutcome(result, json, output);
      return result.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'plan') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runPlanDesign(runId, runtimeDb));
      if (!json && result.snapshot.currentState === 'PlanConfirmation') {
        const checkpoint = await service.currentCheckpoint(runId, runtimeDb);
        if (!checkpoint || checkpoint.kind !== 'plan') throw new Error('计划已生成，但当前训练计划确认卡不存在。');
        output.write(renderConfirmationCard(checkpoint));
      } else writeOutcome(result, json, output);
      return result.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'prepare') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.prepareTraining(runId, runtimeDb));
      writeOutcome(result, json, output);
      return result.disposition === 'ready_for_training_confirmation' ? 0 : 2;
    }
    if (parsed.command === 'advance') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.advanceTraining(runId, runtimeDb));
      writeOutcome(result, json, output);
      return ['recovery_required', 'quarantined'].includes(result.disposition) ? 2 : 0;
    }
    if (parsed.command === 'cancel') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.cancelTraining(
        runId,
        stringFlag(parsed, 'reason') ?? '用户通过 CLI 请求取消训练',
        runtimeDb,
      ));
      writeOutcome(result, json, output);
      return result.disposition === 'recovery_required' ? 2 : 0;
    }
    if (parsed.command === 'checkpoint') {
      const runId = requiredFlag(parsed, 'run-id');
      const [latestCheckpoint, snapshot] = await Promise.all([
        service.currentCheckpoint(runId, runtimeDb),
        service.status(runId, runtimeDb),
      ]);
      const checkpoint = latestCheckpoint !== null && latestCheckpoint.status === 'proposed' && ({
        dataset: 'DatasetCheckpoint',
        research: 'ResearchCheckpoint',
        plan: 'PlanConfirmation',
        training: 'TrainingConfirmation',
      } as const)[latestCheckpoint.kind] === snapshot.currentState
        ? latestCheckpoint
        : null;
      if (json) write(checkpoint === null ? null : { ...checkpoint, view: presentConfirmationCard(checkpoint) }, true, output);
      else if (!checkpoint || checkpoint.status !== 'proposed') output.write('当前没有待确认内容。');
      else output.write(renderConfirmationCard(checkpoint));
      if (!json && checkpoint?.status === 'proposed' && ['dataset', 'research', 'plan'].includes(checkpoint.kind) && process.stdin.isTTY) {
        const selected = await promptCheckpointDecision();
        const result = await withActivityUpdates(service, runId, runtimeDb, false, output, () => service.decideCheckpoint({
          runId,
          action: selected.action,
          checkpointId: checkpoint.checkpointId,
          expectedContentHash: checkpoint.contentHash,
          ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }),
          ...(runtimeDb ? { runtimeDb } : {}),
          userId: stringFlag(parsed, 'user-id') ?? 'local_user',
          workspaceId: stringFlag(parsed, 'workspace-id') ?? 'local_workspace',
        }));
        writeOutcome(result, false, output);
      }
      return 0;
    }
    if (parsed.command === 'intake') {
      const runId = requiredFlag(parsed, 'run-id');
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.runIntake(runId, runtimeDb));
      writeOutcome(result, json, output);
      return result.disposition === 'recoverable_error' ? 1 : 0;
    }
    if (parsed.command === 'decide') {
      const runId = requiredFlag(parsed, 'run-id');
      const approve = flag(parsed, 'approve');
      const revise = flag(parsed, 'revise');
      if (approve === revise) throw new Error('Choose exactly one of --approve or --revise.');
      const feedback = stringFlag(parsed, 'text');
      if (revise && !feedback) throw new Error('--revise requires --text <reason>.');
      if (approve && feedback) throw new Error('--approve cannot be combined with --text.');
      const checkpoint = await service.currentCheckpoint(runId, runtimeDb);
      if (!checkpoint) throw new Error('There is no current checkpoint to decide.');
      if (!['dataset', 'research', 'plan'].includes(checkpoint.kind)) {
        throw new Error('Training confirmation remains an independent approval flow and cannot use workflow decide.');
      }
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, () => service.decideCheckpoint({
        runId,
        action: approve ? 'approve' : 'revise',
        checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash,
        ...(feedback === undefined ? {} : { feedback }),
        ...(runtimeDb ? { runtimeDb } : {}),
        userId: stringFlag(parsed, 'user-id') ?? 'local_user',
        workspaceId: stringFlag(parsed, 'workspace-id') ?? 'local_workspace',
      }));
      writeOutcome(result, json, output);
      return 0;
    }
    if (parsed.command === 'conversation') {
      write(await service.conversation(requiredFlag(parsed, 'run-id'), runtimeDb), json, output);
      return 0;
    }
    if (parsed.command === 'activity') {
      const snapshot = await service.activities(requiredFlag(parsed, 'run-id'), runtimeDb);
      if (json) write(snapshot, true, output);
      else output.write(renderActivitySnapshot(snapshot));
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
      if (['DatasetCheckpoint', 'ResearchCheckpoint', 'PlanConfirmation'].includes(snapshot.currentState ?? '')) {
        throw new Error('当前阶段需要明确选择。请运行 theta workflow checkpoint，或使用 workflow decide --approve / --revise --text。');
      }
      const result = await withActivityUpdates(service, runId, runtimeDb, json, output, async () => snapshot.currentState === 'Intake'
        ? service.submitIntakeMessage(request)
        : snapshot.currentState === 'DatasetDiscovery'
        ? service.submitDatasetDiscoveryMessage(request)
        : snapshot.currentState === 'ResearchDialogue'
          ? service.submitResearchMessage(request)
        : snapshot.currentState === 'TrainingConfirmation'
            ? service.submitTrainingConfirmationMessage(request)
          : service.submitCheckpointMessage(request));
      writeOutcome(result, json, output);
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

const promptCheckpointDecision = async (): Promise<{ action: 'approve' | 'revise'; feedback?: string }> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let choice = '';
    while (choice !== '1' && choice !== '2') {
      choice = (await terminal.question('\n请输入 1 或 2：')).trim();
    }
    if (choice === '1') return { action: 'approve' };
    let feedback = '';
    while (!feedback) feedback = (await terminal.question('请说明原因或需要修改的内容：')).trim();
    return { action: 'revise', feedback };
  } finally {
    terminal.close();
  }
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
  const initial = await service.activities(runId, runtimeDb);
  const startingState = (await service.status(runId, runtimeDb)).currentState;
  for (const activity of initial.recent) seen.add(activity.eventId);
  output.write(renderPhaseStart(startingState ?? initial.phase));
  let queue = Promise.resolve();
  const renderNew = async (): Promise<void> => {
    const task = queue.then(async () => {
      const snapshot = await service.activities(runId, runtimeDb);
      for (const activity of snapshot.recent) {
        if (seen.has(activity.eventId)) continue;
        seen.add(activity.eventId);
        output.write(renderActivityLine(activity));
      }
    });
    queue = task.catch(() => undefined);
    await task;
  };
  const timer = setInterval(() => { void renderNew().catch(() => undefined); }, 500);
  try { return await operation(); }
  finally {
    clearInterval(timer);
    await renderNew();
    const endingState = (await service.status(runId, runtimeDb)).currentState;
    output.write(renderPhaseEnd(startingState ?? initial.phase, endingState));
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

const writeOutcome = (
  value: unknown,
  json: boolean,
  output: WorkflowCliOutput,
): void => {
  if (json) write(value, true, output);
  else output.write(renderWorkflowOutcome(value));
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
