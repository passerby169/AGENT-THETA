#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requestThetaPlanCreate,
  runApprovedThetaPlanCreate,
  runThetaModelCatalog,
  runThetaModelRecommend,
  runThetaPlanValidate,
} from './tools/hypha-runner.js';
import type { ThetaModelRecommendInput } from './tools/model-recommend-tool.js';
import type { ThetaPlanCreateInput } from './tools/plan-create-tool.js';
import type { ThetaPlanValidateInput } from './tools/plan-validate-tool.js';

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
  models
      List models exposed by THETA through Hypha governance.

  recommend --profile <file> [--goal <text>] [--max-topics <number>]
      Recommend models from a normalized dataset profile.

  plan validate --file <file>
      Validate a training plan without writing local state.

  plan create --file <file> [--rationale <text>] [--approve]
      Request plan creation. State is written only when --approve is explicit.

  demo [--approve]
      Run a local end-to-end showcase. Without --approve, the write stops at
      the Hypha human-review gate.

Global options:
  --json      Print machine-readable JSON.
  -h, --help  Show help.

Examples:
  npm run cli -- models
  npm run cli -- recommend --profile fixtures/data-profile.json
  npm run cli -- plan validate --file fixtures/training-plan.json
  npm run cli -- plan create --file fixtures/training-plan.json
  npm run cli -- plan create --file fixtures/training-plan.json --approve
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

const catalogCommand = async (parsed: ParsedArguments, output: CliOutput): Promise<void> => {
  const result = await runThetaModelCatalog();
  const catalog = requireCompleted(result, 'Model catalog');
  writeResult(catalog, parsed, output, () => {
    const rows = catalog.models.map(
      (model) =>
        `  ${model.id.padEnd(10)} ${model.name} [${model.type}]${model.runnable === false ? ' (unavailable)' : ''}`
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

  const result = {
    runner: 'Hypha GovernedToolRunner',
    modelCount: catalog.models.length,
    topRecommendation: recommendation.recommendations[0]?.modelId ?? null,
    planValid: validation.valid,
    planCreationStatus: creationResult.status,
    planId: creationResult.output?.planId ?? null,
    stateWritten: creationResult.status === 'completed',
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
