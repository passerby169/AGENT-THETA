import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { ThetaAgentApplicationService } from './application/theta-agent-application-service.js';
import { createThetaRuntimeComposition } from './persistence/runtime-composition.js';
import { callThetaBridge } from './tools/bridge.js';
import { createMiniMaxProviderFromEnv } from './providers/minimax.js';
import { probeThetaPythonModules } from './tools/bridge.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import type { CapabilityCatalogModel } from './capabilities/contracts.js';
import { getKnowledgeIndexStatus } from './rag/service.js';

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
    checks.push(this.pythonRuntimeCheck());
    checks.push(await this.pythonAndModelCheck());
    checks.push(await this.capabilityRegistryCheck());
    checks.push(await this.structuredKnowledgeCheck());
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
      const summary = new ThetaAgentApplicationService().compileSummary();
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
      const runtime = await createThetaRuntimeComposition(filename);
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
      const models = await modelCatalog();
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

  private async capabilityRegistryCheck(): Promise<DoctorCheck> {
    try {
      const models = await modelCatalog();
      const registry = new CapabilityRegistry({ agentRoot: this.agentRoot });
      const audit = registry.auditCatalog(models);
      if (audit.status === 'fail') {
        const failures = audit.issues
          .filter((issue) => issue.severity === 'error')
          .slice(0, 5)
          .map(
            (issue) =>
              `${issue.code}${issue.modelId ? `(${issue.modelId})` : ''}`,
          )
          .join(', ');
        return fail(
          'capability.registry',
          `Capability Registry 与 Catalog/CLI 发生漂移：${failures}。`,
          '修正 knowledge/capabilities/models 中的能力卡或对应实现；在审计通过前推荐入口会 fail-closed。',
        );
      }
      return pass(
        'capability.registry',
        `能力真相层已审计 ${audit.auditedModelIds.length} 个核心模型；Planner 可选 ${audit.plannerEligibleModelIds.length} 个（${audit.plannerEligibleModelIds.join(', ')}），安全排除 ${audit.plannerExcludedModelIds.length} 个。另有 ${audit.unauditedCatalogModelIds.length} 个 Catalog 模型尚未进入第一阶段审计。`,
      );
    } catch (error) {
      return fail(
        'capability.registry',
        `Capability Registry 加载失败：${message(error)}`,
        '检查 Capability Card YAML 结构、sourceRefs 与模型 Catalog，然后重新运行 doctor。',
      );
    }
  }

  private pythonRuntimeCheck(): DoctorCheck {
    const requiredModules = [
      'pandas',
      'numpy',
      'sklearn',
      'docx',
    ] as const;
    try {
      const probe = probeThetaPythonModules(requiredModules);
      const missing = requiredModules.filter((name) => !probe.modules[name]);
      if (missing.length > 0) {
        return fail(
          'python.runtime',
          `Python ${probe.executable} 缺少训练依赖：${missing.join(', ')}。`,
          `请在当前 conda 环境安装缺失模块，然后重新运行 doctor。当前环境：${probe.condaEnvironment ?? '未识别'}。`,
        );
      }
      const optionalModules = ['pyarrow'];
      const optionalProbe = probeThetaPythonModules(optionalModules);
      const missingOptional = optionalModules.filter(
        (name) => !optionalProbe.modules[name],
      );
      if (missingOptional.length > 0) {
        return warn(
          'python.runtime',
          `训练将使用 ${probe.executable}（conda=${probe.condaEnvironment ?? '未识别'}）；可选格式依赖未安装：${missingOptional.join(', ')}。CSV 训练不受影响。`,
          `仅在读取 Parquet/Arrow 数据时安装：${probe.executable} -m pip install ${missingOptional.join(' ')}`,
        );
      }
      return pass(
        'python.runtime',
        `训练将使用 ${probe.executable}（Python ${probe.version}，conda=${probe.condaEnvironment ?? '未识别'}）。`,
      );
    } catch (error) {
      return fail(
        'python.runtime',
        `无法确认训练 Python：${message(error)}`,
        '请先 conda activate theta，并确认 python 可以从当前终端启动。',
      );
    }
  }

  private async structuredKnowledgeCheck(): Promise<DoctorCheck> {
    try {
      const status = await getKnowledgeIndexStatus();
      if (status.status !== 'ready' || status.totalObjects === 0) {
        return warn(
          'knowledge.structured-v1',
          '结构化知识库尚未构建；推荐仍可使用确定性后备，但 MiniMax Planner 缺少本地证据集。',
          '在 theta-cli-agent 目录运行：pnpm run rag:build',
        );
      }
      const requiredTypes = [
        'model', 'parameter', 'rule', 'recipe', 'evaluation_metric',
        'failure_mode', 'implementation_capability', 'project_constraint',
        'conflict_group',
      ];
      const missing = requiredTypes.filter((type) => !status.objectTypes[type]);
      if (missing.length) {
        return fail(
          'knowledge.structured-v1',
          `结构化知识库缺少对象类型：${missing.join(', ')}。`,
          '修正 knowledge/structured/v1.yaml 后重新运行 pnpm run rag:build。',
        );
      }
      return pass(
        'knowledge.structured-v1',
        `结构化知识库 V1 已就绪：${status.totalObjects} 个对象、${Object.keys(status.objectTypes).length} 种类型；多路 FTS 索引位于 ${status.database}。`,
      );
    } catch (error) {
      return fail(
        'knowledge.structured-v1',
        `结构化知识库状态不可读：${message(error)}`,
        '重新运行 pnpm run rag:build，并检查 knowledge/manifest.yaml。',
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

const minimaxCheck = (): DoctorCheck => {
  if (!process.env.MINIMAX_API_KEY?.trim()) {
    return warn(
      'minimax.optional',
      'MiniMax is not configured; deterministic CLI operation is unaffected.',
      'Set MINIMAX_API_KEY in theta_project/.env only when bounded language inference or MiniMax Planner is required.',
    );
  }
  try {
    const provider = createMiniMaxProviderFromEnv();
    return pass(
      'minimax.optional',
      `MiniMax provider configuration is valid for bounded language tasks and Planner model ${provider?.model ?? 'unknown'} (60s default timeout).`,
    );
  } catch (error) {
    return fail(
      'minimax.optional',
      `MiniMax configuration is invalid: ${message(error)}`,
      'Correct MINIMAX_API_BASE, MINIMAX_MODEL, or MINIMAX_TIMEOUT_MS without exposing MINIMAX_API_KEY.',
    );
  }
};

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

const modelCatalog = async (): Promise<CapabilityCatalogModel[]> => {
  const response = await callThetaBridge('model.catalog', {}, {
    runId: 'theta-v6-doctor',
    stepId: 'model-catalog',
  });
  if (response.status !== 'ok' || !response.data || typeof response.data !== 'object') {
    throw new Error(response.error?.message ?? 'Model catalog bridge call failed.');
  }
  const models = (response.data as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) throw new Error('Model catalog is empty.');
  return models as CapabilityCatalogModel[];
};
