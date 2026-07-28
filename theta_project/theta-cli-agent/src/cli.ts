#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requestThetaPlanApprove,
  requestThetaPlanCreate,
  requestThetaTrainingCancel,
  requestThetaTrainingStart,
  runApprovedThetaPlanApprove,
  runApprovedThetaPlanCreate,
  runApprovedThetaTrainingCancel,
  runApprovedThetaTrainingStart,
  runThetaDatasetDetectColumns,
  runThetaDatasetInspect,
  runThetaModelCatalog,
  runThetaModelRecommend,
  runThetaPlanValidate,
  runThetaTrainingDryRun,
  runThetaTrainingStatus,
} from './tools/hypha-runner.js';
import type { ThetaDatasetFileInput } from './tools/dataset-inspect-tool.js';
import type { ThetaModelRecommendInput } from './tools/model-recommend-tool.js';
import type { ThetaPlanApproveInput } from './tools/plan-approve-tool.js';
import type { ThetaPlanCreateInput } from './tools/plan-create-tool.js';
import type { ThetaPlanValidateInput } from './tools/plan-validate-tool.js';
import type { ThetaTrainingCancelInput } from './tools/training-cancel-tool.js';
import type { ThetaTrainingStartInput } from './tools/training-start-tool.js';
import { runThetaWorkflowCliCommand } from './theta-workflow-cli.js';

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface CliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

const consoleOutput: CliOutput = {
  write: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

const helpText = `THETA CLI Agent

Usage:
  theta <command> [options]
  npm run cli -- <command> [options]

Commands:
  dataset inspect --file <path> [--sample-size <number>]
      Inspect an allowed local dataset through Hypha governance.

  dataset detect-columns --file <path> [--sample-size <number>]
      Detect text, time, and metadata column candidates.

  models
      List models exposed by THETA through Hypha governance.

  recommend --profile <file> [--goal <text>] [--max-topics <number>]
      Recommend models from a normalized dataset profile.

  plan validate --file <file>
      Validate a training plan without writing local state.

  plan create --file <file> [--rationale <text>] [--approve]
      Request plan creation. State is written only when --approve is explicit.

  plan approve --plan-id <id> --plan-hash <hash> --approved-by <user> [--approve]
      Approve a stored plan. The operation also requires explicit --approve.

  training dry-run --plan-id <id> --plan-hash <hash>
      Show training commands and expected artifacts without starting training.

  training start --plan-id <id> --plan-hash <hash> --approval-id <id> [--approve]
      Start a real background training process only when --approve is explicit.

  training status --run-id <id> [--log-limit <number>]
      Read progress, logs, artifacts, and lifecycle events for a training run.

  training cancel --run-id <id> --reason <text> [--approve]
      Request cooperative cancellation only when --approve is explicit.

  workflow compile
  workflow run --file <dataset> [--approve-plans] [--approve-training]
  workflow resume --run-id <id> [--answers <json> | --columns <json>]
  workflow resume --run-id <id> [--approve | --reject]
  workflow trace --run-id <id>
  workflow replay --run-id <id>
      Compile and operate the durable event-first THETA training workflow.

  demo [--approve] [--approve-plan]
      Run a local end-to-end showcase. Without --approve, the write stops at
      the Hypha human-review gate. Add both flags for the complete approved
      plan and training dry-run lifecycle.

Global options:
  --json      Print machine-readable JSON.
  -h, --help  Show help.

Examples:
  npm run cli -- dataset inspect --file fixtures/sample.jsonl
  npm run cli -- dataset detect-columns --file fixtures/sample.jsonl
  npm run cli -- models
  npm run cli -- recommend --profile fixtures/data-profile.json
  npm run cli -- plan validate --file fixtures/training-plan.json
  npm run cli -- plan create --file fixtures/training-plan.json
  npm run cli -- plan create --file fixtures/training-plan.json --approve
  npm run cli -- plan approve --plan-id <id> --plan-hash <hash> --approved-by local_user --approve
  npm run cli -- training dry-run --plan-id <id> --plan-hash <hash>
  npm run cli -- training start --plan-id <id> --plan-hash <hash> --approval-id <id>
  npm run cli -- training status --run-id <id>
  npm run cli -- training cancel --run-id <id> --reason "User requested cancellation"
  npm run cli -- demo
`;

const parseArguments = (args: string[]): ParsedArguments => {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex > 2) {
      flags.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
      continue;
    }

    const key = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
};

const hasFlag = (parsed: ParsedArguments, name: string): boolean => parsed.flags.get(name) === true;

const stringFlag = (
  parsed: ParsedArguments,
  name: string,
  options: { required?: boolean } = {}
): string | undefined => {
  const value = parsed.flags.get(name);
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (options.required) {
    throw new Error(`Missing required option --${name}.`);
  }
  return undefined;
};

const requiredStringFlag = (parsed: ParsedArguments, name: string): string => {
  const value = stringFlag(parsed, name, { required: true });
  if (value === undefined) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
};

const integerFlag = (parsed: ParsedArguments, name: string): number | undefined => {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Option --${name} must be a positive integer.`);
  }
  return parsedValue;
};

const readJsonObject = async (filename: string): Promise<Record<string, unknown>> => {
  const fullPath = resolve(process.cwd(), filename);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fullPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read JSON file ${fullPath}: ${reason}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON file ${fullPath} must contain an object.`);
  }
  return parsed as Record<string, unknown>;
};

const requireCompleted = <T>(
  result: { status: string; output?: T; error?: unknown },
  operation: string
): T => {
  if (result.status !== 'completed' || result.output === undefined) {
    throw new Error(`${operation} failed: ${JSON.stringify(result.error ?? result.status)}`);
  }
  return result.output;
};

const writeResult = (
  value: unknown,
  parsed: ParsedArguments,
  output: CliOutput,
  render: () => string
): void => {
  output.write(hasFlag(parsed, 'json') ? JSON.stringify(value, null, 2) : render());
};

const datasetInput = (parsed: ParsedArguments): ThetaDatasetFileInput => {
  const sampleSize = integerFlag(parsed, 'sample-size');
  return {
    filePath: resolve(process.cwd(), requiredStringFlag(parsed, 'file')),
    ...(sampleSize === undefined ? {} : { sampleSize }),
  };
};

const inspectDatasetCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const result = await runThetaDatasetInspect(datasetInput(parsed));
  const profile = requireCompleted(result, 'Dataset inspection');
  writeResult(profile, parsed, output, () => {
    const rows = profile.columnProfiles.map(
      (column) =>
        `  ${column.name}: ${column.inferredType}, missing ${(
          column.missingSampleRatio * 100
        ).toFixed(1)}%, avg length ${column.avgLength}`
    );
    return [
      `Dataset: ${profile.fileName}`,
      `Rows: ${profile.rowCount}`,
      `Columns: ${profile.columns.join(', ')}`,
      `Sample rows returned: ${profile.sampleRows.length}`,
      'Column profiles:',
      ...rows,
    ].join('\n');
  });
};

const detectDatasetColumnsCommand = async (
  parsed: ParsedArguments,
  output: CliOutput
): Promise<void> => {
  const result = await runThetaDatasetDetectColumns(datasetInput(parsed));
  const detected = requireCompleted(result, 'Dataset column detection');
  writeResult(detected, parsed, output, () => {
    const candidates = detected.textColumns.map(
      (column) => `  ${column.name}: ${(column.score * 100).toFixed(0)}% - ${column.reason}`
    );
    return [
      `Recommended text column: ${detected.recommendedTextColumn ?? 'none'}`,
      `Time columns: ${detected.timeColumns.map((column) => column.name).join(', ') || 'none'}`,
      `Metadata columns: ${
        detected.metadataColumns.map((column) => column.name).join(', ') || 'none'
      }`,
      'Text candidates:',
      ...candidates,
      ...detected.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n');
  });
};

const catalogCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const result = await runThetaModelCatalog();
  const catalog = requireCompleted(result, 'Model catalog');
  writeResult(catalog, parsed, output, () => {
    const rows = catalog.models.map(
      (model) =>
        `  ${model.id.padEnd(10)} ${model.name} [${model.type}]${
          model.runnable === false ? ' (unavailable)' : ''
        }`
    );
    return [`THETA models (${catalog.models.length})`, ...rows].join('\n');
  });
};

const recommendCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const profileFile = requiredStringFlag(parsed, 'profile');
  const dataProfile = await readJsonObject(profileFile);
  const maxTopics = integerFlag(parsed, 'max-topics');
  const researchGoal = stringFlag(parsed, 'goal');
  const input: ThetaModelRecommendInput = {
    dataProfile,
    ...(researchGoal === undefined ? {} : { researchGoal }),
    ...(maxTopics === undefined ? {} : { constraints: { maxTopics } }),
  };
  const result = await runThetaModelRecommend(input);
  const recommendation = requireCompleted(result, 'Model recommendation');
  writeResult(recommendation, parsed, output, () => {
    const rows = recommendation.recommendations.map((item) => {
      const rank = typeof item.rank === 'number' ? item.rank : '-';
      const modelId = typeof item.modelId === 'string' ? item.modelId : 'unknown';
      const score = typeof item.score === 'number' ? item.score : '-';
      const reasons = Array.isArray(item.reasons) ? item.reasons.join('; ') : '';
      return `  ${rank}. ${modelId} (score ${score})${reasons ? ` - ${reasons}` : ''}`;
    });
    return ['Recommended models', ...rows].join('\n');
  });
};

const readPlanInput = async (parsed: ParsedArguments): Promise<ThetaPlanCreateInput> => {
  const filename = requiredStringFlag(parsed, 'file');
  const value = await readJsonObject(filename);
  const input = 'plan' in value ? value : { plan: value };
  return input as unknown as ThetaPlanCreateInput;
};

const validatePlanCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const planInput = await readPlanInput(parsed);
  const input: ThetaPlanValidateInput = {
    plan: planInput.plan,
    ...(planInput.dataProfile === undefined ? {} : { dataProfile: planInput.dataProfile }),
  };
  const result = await runThetaPlanValidate(input);
  const validation = requireCompleted(result, 'Plan validation');
  writeResult(validation, parsed, output, () =>
    [
      `Plan valid: ${validation.valid ? 'yes' : 'no'}`,
      `Errors: ${validation.errors.length ? validation.errors.join('; ') : 'none'}`,
      `Warnings: ${validation.warnings.length ? validation.warnings.join('; ') : 'none'}`,
    ].join('\n')
  );
  if (!validation.valid) {
    process.exitCode = 2;
  }
};

const planInvocationKey = (input: ThetaPlanCreateInput): string => {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
  return `theta-cli-plan-create-${digest}`;
};

const approvalInvocationKey = (input: ThetaPlanApproveInput): string => {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
  return `theta-cli-plan-approve-${digest}`;
};

const trainingStartInvocationKey = (
  input: Omit<ThetaTrainingStartInput, 'idempotencyKey'>
): string => {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
  return `theta-cli-training-start-${digest}`;
};

const trainingCancelInvocationKey = (input: ThetaTrainingCancelInput): string => {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
  return `theta-cli-training-cancel-${digest}`;
};

const createPlanCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const input = await readPlanInput(parsed);
  const rationale = stringFlag(parsed, 'rationale');
  if (rationale) {
    input.rationale = rationale;
  }
  const invocationKey = planInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, 'approve')) {
    const result = await requestThetaPlanCreate(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === 'human_review_required',
      message: 'Review the plan, then rerun this command with --approve to write local state.',
    };
    writeResult(gate, parsed, output, () =>
      [
        `Plan creation status: ${result.status}`,
        'No state was written.',
        'After review, rerun with --approve.',
      ].join('\n')
    );
    return;
  }

  const result = await runApprovedThetaPlanCreate(input, options);
  const created = requireCompleted(result, 'Approved plan creation');
  writeResult(created, parsed, output, () =>
    [
      'Plan created after Hypha approval.',
      `Plan ID: ${created.planId}`,
      `Plan hash: ${created.planHash}`,
      `Valid: ${created.valid ? 'yes' : 'no'}`,
    ].join('\n')
  );
};

const approvePlanCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const approvalNote = stringFlag(parsed, 'note');
  const input: ThetaPlanApproveInput = {
    planId: requiredStringFlag(parsed, 'plan-id'),
    planHash: requiredStringFlag(parsed, 'plan-hash'),
    approvedBy: requiredStringFlag(parsed, 'approved-by'),
    ...(approvalNote === undefined ? {} : { approvalNote }),
  };
  const invocationKey = approvalInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, 'approve')) {
    const result = await requestThetaPlanApprove(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === 'human_review_required',
      message: 'Review the approval request, then rerun this command with --approve.',
    };
    writeResult(gate, parsed, output, () =>
      [
        `Plan approval status: ${result.status}`,
        'No approval record was written.',
        'After review, rerun with --approve.',
      ].join('\n')
    );
    return;
  }

  const result = await runApprovedThetaPlanApprove(input, options);
  const approved = requireCompleted(result, 'Approved plan approval');
  writeResult(approved, parsed, output, () =>
    [
      'Plan approved through Hypha governance.',
      `Approval ID: ${approved.approvalId}`,
      `Plan ID: ${approved.planId}`,
      `Approved by: ${approved.approvedBy}`,
    ].join('\n')
  );
};

const trainingDryRunCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const result = await runThetaTrainingDryRun({
    planId: requiredStringFlag(parsed, 'plan-id'),
    planHash: requiredStringFlag(parsed, 'plan-hash'),
  });
  const dryRun = requireCompleted(result, 'Training dry run');
  writeResult(dryRun, parsed, output, () => {
    const commands = dryRun.commands.map(
      (command, index) =>
        `  ${index + 1}. ${command.step}: ${command.argv.join(' ')}\n     cwd: ${command.cwd}`
    );
    const artifacts = dryRun.expectedArtifacts.map(
      (artifact) => `  - ${artifact.kind}: ${artifact.path}`
    );
    return [
      `Training dry run for ${dryRun.planId}`,
      `Plan valid: ${dryRun.valid ? 'yes' : 'no'}`,
      `Business approval present: ${dryRun.approved ? 'yes' : 'no'}`,
      'Commands:',
      ...commands,
      'Expected artifacts:',
      ...artifacts,
      'No training process was started.',
    ].join('\n');
  });
};

const trainingStartCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const startIdentity = {
    planId: requiredStringFlag(parsed, 'plan-id'),
    planHash: requiredStringFlag(parsed, 'plan-hash'),
    approvalId: requiredStringFlag(parsed, 'approval-id'),
  };
  const generatedKey = trainingStartInvocationKey(startIdentity);
  const idempotencyKey = stringFlag(parsed, 'idempotency-key') ?? generatedKey;
  const input: ThetaTrainingStartInput = {
    ...startIdentity,
    idempotencyKey,
  };
  const options = {
    invocationId: idempotencyKey,
    idempotencyKey,
  };

  if (!hasFlag(parsed, 'approve')) {
    const result = await requestThetaTrainingStart(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === 'human_review_required',
      processStarted: false,
      message: 'Review the run details, then rerun this command with --approve.',
    };
    writeResult(gate, parsed, output, () =>
      [
        `Training start status: ${result.status}`,
        'No training process was started.',
        'After review, rerun with --approve.',
      ].join('\n')
    );
    return;
  }

  const result = await runApprovedThetaTrainingStart(input, options);
  const started = requireCompleted(result, 'Approved training start');
  writeResult(started, parsed, output, () =>
    [
      'Training start approved through Hypha governance.',
      `Run ID: ${started.trainingRunId}`,
      `Status: ${started.status}`,
      `Process started: ${started.processStarted ? 'yes' : 'no'}`,
      `PID: ${String(started.pid ?? 'not reported')}`,
    ].join('\n')
  );
};

const trainingStatusCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const logLimit = integerFlag(parsed, 'log-limit');
  const result = await runThetaTrainingStatus({
    trainingRunId: requiredStringFlag(parsed, 'run-id'),
    ...(logLimit === undefined ? {} : { logLimit }),
  });
  const status = requireCompleted(result, 'Training status');
  writeResult(status, parsed, output, () => {
    if (!status.found) {
      return [`Training run: ${status.trainingRunId}`, 'Status: not found'].join('\n');
    }
    return [
      `Training run: ${status.trainingRunId}`,
      `Status: ${status.status}`,
      `Progress: ${String(status.progress ?? 0)}%`,
      `Current step: ${status.currentStep ?? 'unknown'}`,
      `PID: ${String(status.pid ?? 'not running')}`,
      `Artifacts: ${status.artifacts.length}`,
      `Events: ${status.events?.length ?? 0}`,
      `Recent log lines: ${status.logs.length}`,
      ...status.logs.map((line) => `  ${line}`),
    ].join('\n');
  });
};

const trainingCancelCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const input: ThetaTrainingCancelInput = {
    trainingRunId: requiredStringFlag(parsed, 'run-id'),
    reason: requiredStringFlag(parsed, 'reason'),
  };
  const invocationKey = trainingCancelInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, 'approve')) {
    const result = await requestThetaTrainingCancel(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === 'human_review_required',
      cancellationRecorded: false,
      message: 'Review the cancellation reason, then rerun this command with --approve.',
    };
    writeResult(gate, parsed, output, () =>
      [
        `Training cancellation status: ${result.status}`,
        'No cancellation was recorded.',
        'After review, rerun with --approve.',
      ].join('\n')
    );
    return;
  }

  const result = await runApprovedThetaTrainingCancel(input, options);
  const cancelled = requireCompleted(result, 'Approved training cancellation');
  writeResult(cancelled, parsed, output, () =>
    [
      'Training cancellation processed through Hypha governance.',
      `Run ID: ${cancelled.trainingRunId}`,
      `Status: ${cancelled.status}`,
      `Changed: ${cancelled.changed ? 'yes' : 'no'}`,
      `Message: ${cancelled.message}`,
    ].join('\n')
  );
};

const demoProfile: Record<string, unknown> = {
  rowCount: 240,
  columns: ['content', 'created_at', 'source'],
  recommendedTextColumn: 'content',
  textColumns: [{ name: 'content' }],
  timeColumns: [{ name: 'created_at' }],
  metadataColumns: [{ name: 'source' }],
  columnProfiles: [{ name: 'content', avgLength: 92 }],
};

const demoPlan: ThetaPlanCreateInput = {
  plan: {
    datasetId: 'demo-dataset',
    modelId: 'lda',
    mode: 'unsupervised',
    numTopics: 8,
    textColumn: 'content',
  },
  rationale: 'THETA CLI governed local demonstration.',
  dataProfile: demoProfile,
};

const demoCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  if (hasFlag(parsed, 'approve-plan') && !hasFlag(parsed, 'approve')) {
    throw new Error(
      '--approve-plan requires --approve so the plan exists before business approval.'
    );
  }
  const catalog = requireCompleted(await runThetaModelCatalog(), 'Demo model catalog');
  const recommendation = requireCompleted(
    await runThetaModelRecommend({
      dataProfile: demoProfile,
      researchGoal: 'time trend topic modeling',
      constraints: { maxTopics: 12 },
    }),
    'Demo model recommendation'
  );
  const validation = requireCompleted(
    await runThetaPlanValidate({
      plan: demoPlan.plan,
      dataProfile: demoPlan.dataProfile,
    }),
    'Demo plan validation'
  );
  const invocationKey = planInvocationKey(demoPlan);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };
  const creationResult = hasFlag(parsed, 'approve')
    ? await runApprovedThetaPlanCreate(demoPlan, options)
    : await requestThetaPlanCreate(demoPlan, options);
  let planApprovalStatus = 'not_requested';
  let approvalId: string | null = null;
  let dryRunApproved: boolean | null = null;
  let commandCount = 0;

  if (
    hasFlag(parsed, 'approve-plan') &&
    creationResult.status === 'completed' &&
    creationResult.output
  ) {
    const approvalInput: ThetaPlanApproveInput = {
      planId: creationResult.output.planId,
      planHash: creationResult.output.planHash,
      approvedBy: 'local_user',
      approvalNote: 'THETA CLI complete governed demonstration.',
    };
    const approvalKey = approvalInvocationKey(approvalInput);
    const approvalResult = await runApprovedThetaPlanApprove(approvalInput, {
      invocationId: approvalKey,
      idempotencyKey: approvalKey,
    });
    const approval = requireCompleted(approvalResult, 'Demo plan approval');
    planApprovalStatus = approvalResult.status;
    approvalId = approval.approvalId;

    const dryRun = requireCompleted(
      await runThetaTrainingDryRun({
        planId: creationResult.output.planId,
        planHash: creationResult.output.planHash,
      }),
      'Demo training dry run'
    );
    dryRunApproved = dryRun.approved;
    commandCount = dryRun.commands.length;
  }

  const result = {
    runner: 'Hypha GovernedToolRunner',
    modelCount: catalog.models.length,
    topRecommendation: recommendation.recommendations[0]?.modelId ?? null,
    planValid: validation.valid,
    planCreationStatus: creationResult.status,
    planId: creationResult.output?.planId ?? null,
    stateWritten: creationResult.status === 'completed',
    planApprovalStatus,
    approvalId,
    dryRunApproved,
    trainingCommandCount: commandCount,
    trainingStarted: false,
  };
  writeResult(result, parsed, output, () =>
    [
      'THETA CLI governed demo',
      `1. Model catalog: ${result.modelCount} models`,
      `2. Recommendation: ${String(result.topRecommendation)}`,
      `3. Plan validation: ${result.planValid ? 'passed' : 'failed'}`,
      `4. Plan creation: ${result.planCreationStatus}`,
      result.stateWritten
        ? `   Local state written for ${String(result.planId)}.`
        : '   No state written. Add --approve after reviewing the plan.',
      `5. Business plan approval: ${result.planApprovalStatus}`,
      result.dryRunApproved === null
        ? '6. Training dry run: not requested'
        : `6. Training dry run: ${result.trainingCommandCount} commands, approved=${result.dryRunApproved}`,
      '7. Training process started: no',
    ].join('\n')
  );
};

export const runCli = async (
  args: string[],
  output: CliOutput = consoleOutput
): Promise<number> => {
  try {
    const parsed = parseArguments(args);
    if (hasFlag(parsed, 'help') || parsed.positionals.length === 0) {
      output.write(helpText);
      return 0;
    }

    const [command, subcommand, ...extraPositionals] = parsed.positionals;
    if (extraPositionals.length > 0) {
      throw new Error(`Unexpected arguments: ${extraPositionals.join(' ')}`);
    }

    if (command === 'dataset' && subcommand === 'inspect') {
      await inspectDatasetCommand(parsed, output);
      return 0;
    }
    if (command === 'dataset' && subcommand === 'detect-columns') {
      await detectDatasetColumnsCommand(parsed, output);
      return 0;
    }
    if (command === 'models' && subcommand === undefined) {
      await catalogCommand(parsed, output);
      return 0;
    }
    if (command === 'recommend' && subcommand === undefined) {
      await recommendCommand(parsed, output);
      return 0;
    }
    if (command === 'plan' && subcommand === 'validate') {
      await validatePlanCommand(parsed, output);
      return process.exitCode === 2 ? 2 : 0;
    }
    if (command === 'plan' && subcommand === 'create') {
      await createPlanCommand(parsed, output);
      return 0;
    }
    if (command === 'plan' && subcommand === 'approve') {
      await approvePlanCommand(parsed, output);
      return 0;
    }
    if (command === 'training' && subcommand === 'dry-run') {
      await trainingDryRunCommand(parsed, output);
      return 0;
    }
    if (command === 'training' && subcommand === 'start') {
      await trainingStartCommand(parsed, output);
      return 0;
    }
    if (command === 'training' && subcommand === 'status') {
      await trainingStatusCommand(parsed, output);
      return 0;
    }
    if (command === 'training' && subcommand === 'cancel') {
      await trainingCancelCommand(parsed, output);
      return 0;
    }
    if (command === 'workflow' && subcommand !== undefined) {
      return runThetaWorkflowCliCommand(args.slice(1), output);
    }
    if (command === 'demo' && subcommand === undefined) {
      await demoCommand(parsed, output);
      return 0;
    }

    throw new Error(`Unknown command: ${parsed.positionals.join(' ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.writeError(`Error: ${message}`);
    output.writeError('Run "theta --help" for usage.');
    return 1;
  }
};

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  const exitCode = await runCli(process.argv.slice(2));
  if (process.exitCode === undefined) {
    process.exitCode = exitCode;
  }
}
