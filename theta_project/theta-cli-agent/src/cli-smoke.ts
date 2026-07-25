import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface CommandCase {
  args: string[];
  verify(output: unknown): void;
}

const cliPath = resolve(process.cwd(), 'dist', 'cli.js');

const runJsonCommand = (commandCase: CommandCase): void => {
  const result = spawnSync(process.execPath, [cliPath, ...commandCase.args, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `CLI command failed (${commandCase.args.join(' ')}): ${result.stderr || result.stdout}`
    );
  }
  commandCase.verify(JSON.parse(result.stdout) as unknown);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CLI JSON output must be an object.');
  }
  return value as Record<string, unknown>;
};

const cases: CommandCase[] = [
  {
    args: ['models'],
    verify: (output) => {
      const catalog = asRecord(output);
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
        throw new Error('models command returned an empty catalog.');
      }
    },
  },
  {
    args: ['recommend', '--profile', 'fixtures/data-profile.json'],
    verify: (output) => {
      const recommendation = asRecord(output);
      if (!Array.isArray(recommendation.recommendations) || recommendation.recommendations.length === 0) {
        throw new Error('recommend command returned no recommendations.');
      }
    },
  },
  {
    args: ['plan', 'validate', '--file', 'fixtures/training-plan.json'],
    verify: (output) => {
      if (asRecord(output).valid !== true) {
        throw new Error('plan validate command did not validate the fixture.');
      }
    },
  },
  {
    args: ['plan', 'create', '--file', 'fixtures/training-plan.json'],
    verify: (output) => {
      const gate = asRecord(output);
      if (gate.approvalRequired !== true || gate.status !== 'human_review_required') {
        throw new Error('plan create command bypassed the Hypha approval gate.');
      }
    },
  },
  {
    args: [
      'plan',
      'approve',
      '--plan-id',
      'plan_gate_only',
      '--plan-hash',
      'hash_gate_only',
      '--approved-by',
      'local_user',
    ],
    verify: (output) => {
      const gate = asRecord(output);
      if (gate.approvalRequired !== true || gate.status !== 'human_review_required') {
        throw new Error('plan approve command bypassed the Hypha approval gate.');
      }
    },
  },
  {
    args: ['demo'],
    verify: (output) => {
      const demo = asRecord(output);
      if (demo.runner !== 'Hypha GovernedToolRunner' || demo.stateWritten !== false) {
        throw new Error('demo command did not preserve the default no-write boundary.');
      }
    },
  },
];

for (const commandCase of cases) {
  runJsonCommand(commandCase);
}

console.log(
  JSON.stringify({
    status: 'ok',
    commandCount: cases.length,
    writeBoundary: 'human_review_required',
  })
);
