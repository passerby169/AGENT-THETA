import {
  agentInvocationSchema,
  conversationCommandSchema,
  type AgentInvocation,
  type ConversationCommand,
} from './contracts.js';

const startValueOptions = new Set([
  'file',
  'input',
  'dataset-id',
  'goal',
  'sample-size',
  'run-id',
  'runtime-db',
  'approved-by',
]);
const startBooleanOptions = new Set([
  'approve-plans',
  'approve-training',
  'json',
]);
const resumeValueOptions = new Set([
  'run-id',
  'runtime-db',
  'approved-by',
  'answers',
  'columns',
]);
const resumeBooleanOptions = new Set(['approve', 'reject', 'json']);

export class ConversationService {
  parseInvocation(args: readonly string[]): AgentInvocation {
    const [command, ...rest] = args;
    if (command === 'doctor') {
      const options = parseOptions(rest, new Set(), new Set(['json']));
      return agentInvocationSchema.parse({
        kind: 'doctor',
        json: options.booleans.has('json'),
      });
    }
    if (command === 'start') {
      parseOptions(rest, startValueOptions, startBooleanOptions);
      return agentInvocationSchema.parse({
        kind: 'workflow',
        action: 'start',
        args: [...rest],
      });
    }
    if (command === 'resume') {
      parseOptions(rest, resumeValueOptions, resumeBooleanOptions);
      return agentInvocationSchema.parse({
        kind: 'workflow',
        action: 'resume',
        args: [...rest],
      });
    }
    if (command === 'status') {
      const options = parseOptions(
        rest,
        new Set(['run-id', 'runtime-db']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'status',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'audit') {
      if (rest[0] !== 'export') {
        throw new Error('Expected "audit export".');
      }
      const options = parseOptions(
        rest.slice(1),
        new Set(['run-id', 'runtime-db']),
        new Set(['json']),
      );
      return agentInvocationSchema.parse({
        kind: 'audit',
        runId: requiredOption(options.values, 'run-id'),
        runtimeDb: options.values.get('runtime-db'),
        json: options.booleans.has('json'),
      });
    }
    if (command === 'repl') {
      const options = parseOptions(
        rest,
        new Set(['run-id', 'runtime-db']),
        new Set(),
      );
      return agentInvocationSchema.parse({
        kind: 'repl',
        runId: options.values.get('run-id'),
        runtimeDb: options.values.get('runtime-db'),
      });
    }
    throw new Error(`Unsupported THETA Agent command: ${command ?? '(empty)'}`);
  }

  parseReplLine(line: string): ConversationCommand {
    const trimmed = line.trim();
    if (!trimmed) return conversationCommandSchema.parse({ kind: 'help' });
    const separator = trimmed.search(/\s/);
    const name = (separator === -1 ? trimmed : trimmed.slice(0, separator))
      .toLowerCase()
      .replace(/^\//, '');
    const argument =
      separator === -1 ? undefined : optional(trimmed.slice(separator + 1));

    if (name === 'help') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: 'help' });
    }
    if (name === 'start') {
      if (!argument) throw new Error('/start requires a dataset path.');
      return conversationCommandSchema.parse({
        kind: 'start',
        filePath: argument,
      });
    }
    if (
      name === 'status' ||
      name === 'why' ||
      name === 'evidence' ||
      name === 'plan' ||
      name === 'approve' ||
      name === 'save'
    ) {
      return conversationCommandSchema.parse({
        kind: name,
        runId: argument,
      });
    }
    if (name === 'back' || name === 'exit') {
      requireNoArgument(name, argument);
      return conversationCommandSchema.parse({ kind: name });
    }
    throw new Error(
      `Unsupported REPL command "${name}". Use /help for deterministic commands.`,
    );
  }
}

interface ParsedOptions {
  values: Map<string, string>;
  booleans: Set<string>;
}

const parseOptions = (
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
): ParsedOptions => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (booleanOptions.has(name)) {
      if (equals !== -1) {
        throw new Error(`Boolean option --${name} does not accept a value.`);
      }
      booleans.add(name);
      continue;
    }
    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
    const value =
      equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith('--'))) {
      throw new Error(`Option --${name} requires a value.`);
    }
    values.set(name, value);
    if (equals === -1) index += 1;
  }
  return { values, booleans };
};

const requiredOption = (values: Map<string, string>, name: string): string => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
};

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requireNoArgument = (
  command: string,
  argument: string | undefined,
): void => {
  if (argument) throw new Error(`/${command} does not accept an argument.`);
};
