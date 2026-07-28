import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { ThetaWorkflowService } from './theta-workflow-service.js';
import { createThetaWorkflowRuntime } from './theta-workflow-runtime.js';
import { runThetaModelCatalog } from './tools/hypha-runner.js';

export type DoctorCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorServiceOptions {
  agentRoot?: string;
  now?: () => string;
}

export class DoctorService {
  private readonly agentRoot: string;
  private readonly projectRoot: string;
  private readonly now: () => string;

  constructor(options: DoctorServiceOptions = {}) {
    this.agentRoot = path.resolve(options.agentRoot ?? process.cwd());
    this.projectRoot = path.resolve(this.agentRoot, '..');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    checks.push(nodeCheck());
    checks.push(await this.pnpmCheck());
    checks.push(await this.hyphaLockCheck());
    checks.push(await this.hyphaBuildCheck());
    checks.push(this.domainPackCheck());
    checks.push(await this.runtimeCheck());
    checks.push(await this.artifactRootCheck());
    checks.push(await this.dataRootsCheck());
    checks.push(await this.thetaConfigCheck());
    checks.push(await this.pythonAndModelCheck());
    checks.push(gpuCheck());
    checks.push(minimaxCheck());

    return {
      status: checks.some((check) => check.status === 'FAIL')
        ? 'blocked'
        : checks.some((check) => check.status === 'WARN')
          ? 'degraded'
          : 'ready',
      checkedAt: this.now(),
      checks,
    };
  }

  private async pnpmCheck(): Promise<DoctorCheck> {
    const workspace = path.join(this.agentRoot, 'pnpm-workspace.yaml');
    const lock = path.join(this.agentRoot, 'pnpm-lock.yaml');
    return (await exists(workspace)) && (await exists(lock))
      ? pass('pnpm.workspace', 'pnpm workspace and lockfile are present.')
      : fail(
          'pnpm.workspace',
          'pnpm workspace metadata is incomplete.',
          'Run pnpm install in theta-cli-agent and commit pnpm-lock.yaml.',
        );
  }

  private async hyphaLockCheck(): Promise<DoctorCheck> {
    try {
      const lockPath = path.join(this.projectRoot, 'hypha.lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
        branch?: unknown;
        commit?: unknown;
      };
      if (
        typeof lock.branch !== 'string' ||
        typeof lock.commit !== 'string' ||
        !/^[0-9a-f]{40}$/i.test(lock.commit)
      ) {
        throw new Error('branch or 40-character commit is missing');
      }
      return pass(
        'hypha.lock',
        `Hypha is pinned to ${lock.branch}@${lock.commit.slice(0, 12)}.`,
      );
    } catch (error) {
      return fail(
        'hypha.lock',
        `Hypha lock is invalid: ${message(error)}`,
        'Restore theta_project/hypha.lock.json from the approved integration baseline.',
      );
    }
  }

  private async hyphaBuildCheck(): Promise<DoctorCheck> {
    const required = ['core', 'domain', 'fsm', 'tools', 'adapters-local', 'harness'];
    const missing: string[] = [];
    for (const name of required) {
      if (
        !(await exists(
          path.join(this.projectRoot, 'Hypha', 'packages', name, 'dist', 'index.js'),
        ))
      ) {
        missing.push(name);
      }
    }
    return missing.length === 0
      ? pass('hypha.build', 'All pinned Hypha package builds are available.')
      : fail(
          'hypha.build',
          `Missing built Hypha packages: ${missing.join(', ')}.`,
          'Run npm run hypha:build in theta-cli-agent.',
        );
  }

  private domainPackCheck(): DoctorCheck {
    try {
      const summary = new ThetaWorkflowService().compileSummary();
      return pass(
        'domain.pack',
        `Compiled ${String(summary.domainPack)} with ${String(summary.stateCount)} states.`,
      );
    } catch (error) {
      return fail(
        'domain.pack',
        `DomainPack compilation failed: ${message(error)}`,
        'Run npm run smoke:theta-domain and repair the DomainPack contract.',
      );
    }
  }

  private async runtimeCheck(): Promise<DoctorCheck> {
    const directory = path.join(this.agentRoot, '.theta_agent');
    const filename = path.join(directory, `doctor-${randomUUID()}.sqlite`);
    try {
      await mkdir(directory, { recursive: true });
      const runtime = await createThetaWorkflowRuntime({ filename });
      runtime.close();
      await cleanupSqlite(filename);
      return pass(
        'runtime.sqlite',
        `Runtime directory and SQLite adapters are writable at ${directory}.`,
      );
    } catch (error) {
      await cleanupSqlite(filename);
      return fail(
        'runtime.sqlite',
        `Runtime SQLite probe failed: ${message(error)}`,
        'Grant write permission to theta-cli-agent/.theta_agent or set THETA_WORKFLOW_DB.',
      );
    }
  }

  private async artifactRootCheck(): Promise<DoctorCheck> {
    const root = path.resolve(
      process.env.THETA_AGENT_STATE_DIR ??
        path.join(this.projectRoot, '.theta_agent'),
      'runs',
    );
    try {
      await mkdir(root, { recursive: true });
      return pass('artifact.root', `Training artifact root is writable: ${root}.`);
    } catch (error) {
      return fail(
        'artifact.root',
        `Training artifact root is not writable: ${message(error)}`,
        'Set THETA_AGENT_STATE_DIR to a writable local directory.',
      );
    }
  }

  private async dataRootsCheck(): Promise<DoctorCheck> {
    const configured = process.env.THETA_ALLOWED_DATA_ROOTS;
    const roots = configured?.trim()
      ? configured
          .split(path.delimiter)
          .map((root) => path.resolve(root.trim()))
          .filter(Boolean)
      : [
          path.join(this.agentRoot, 'fixtures'),
          path.join(this.projectRoot, 'THETA', 'data'),
        ];
    const missing: string[] = [];
    for (const root of roots) {
      if (!(await exists(root))) missing.push(root);
    }
    return missing.length === 0
      ? pass('dataset.roots', `Allowed dataset roots: ${roots.join(', ')}.`)
      : fail(
          'dataset.roots',
          `Allowed dataset roots do not exist: ${missing.join(', ')}.`,
          'Create the directories or correct THETA_ALLOWED_DATA_ROOTS.',
        );
  }

  private async thetaConfigCheck(): Promise<DoctorCheck> {
    const config = path.join(
      this.projectRoot,
      'THETA',
      'src',
      'models',
      'config.py',
    );
    return (await exists(config))
      ? pass('theta.config', `THETA model configuration found at ${config}.`)
      : fail(
          'theta.config',
          'THETA model configuration is missing.',
          'Restore theta_project/THETA/src/models/config.py.',
        );
  }

  private async pythonAndModelCheck(): Promise<DoctorCheck> {
    try {
      const result = await runThetaModelCatalog();
      const models = result.output?.models ?? [];
      if (result.status !== 'completed' || models.length === 0) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : (result.error?.message ?? `status=${result.status}`),
        );
      }
      return pass(
        'python.models',
        `Governed Python Bridge loaded ${models.length} THETA models.`,
      );
    } catch (error) {
      return fail(
        'python.models',
        `Governed Python/model probe failed: ${message(error)}`,
        'Verify THETA_AGENT_BRIDGE_PYTHON, install requirements.txt, then run npm run smoke:hypha-import.',
      );
    }
  }
}

const nodeCheck = (): DoctorCheck => {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((value) => Number.parseInt(value, 10));
  return major > 22 || (major === 22 && minor >= 5)
    ? pass('node.version', `Node.js ${process.versions.node} is supported.`)
    : fail(
        'node.version',
        `Node.js ${process.versions.node} is below 22.5.`,
        'Install Node.js 22.5 or newer.',
      );
};

const gpuCheck = (): DoctorCheck => {
  const visible =
    process.env.CUDA_VISIBLE_DEVICES ?? process.env.NVIDIA_VISIBLE_DEVICES;
  return visible && visible !== '-1' && visible.toLowerCase() !== 'none'
    ? pass('gpu.visibility', `GPU visibility is configured as ${visible}.`)
    : warn(
        'gpu.visibility',
        'No explicit GPU visibility is configured; CPU-safe commands remain available.',
        'Set CUDA_VISIBLE_DEVICES when GPU training is required.',
      );
};

const minimaxCheck = (): DoctorCheck =>
  process.env.MINIMAX_API_KEY
    ? pass('minimax.optional', 'Optional MiniMax configuration is present.')
    : warn(
        'minimax.optional',
        'MiniMax is not configured; deterministic CLI operation is unaffected.',
        'Set MINIMAX_API_KEY only when an approved provider-neutral inference path uses it.',
      );

const exists = async (filename: string): Promise<boolean> => {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
};

const cleanupSqlite = async (filename: string): Promise<void> => {
  await Promise.all(
    ['', '-shm', '-wal'].map((suffix) =>
      rm(`${filename}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
};

const pass = (id: string, text: string): DoctorCheck => ({
  id,
  status: 'PASS',
  message: text,
});

const warn = (
  id: string,
  text: string,
  remediation: string,
): DoctorCheck => ({
  id,
  status: 'WARN',
  message: text,
  remediation,
});

const fail = (
  id: string,
  text: string,
  remediation: string,
): DoctorCheck => ({
  id,
  status: 'FAIL',
  message: text,
  remediation,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
