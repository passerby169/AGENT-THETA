import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ThetaTurnOrchestrator } from '../conversation/turn-orchestrator.js';
import { DoctorService } from '../doctor-service.js';
import { loadThetaProjectEnvironment } from '../environment.js';
import { buildHumanResponse } from '../presentation/human-response-builder.js';
import { ResultService } from '../results/result-service.js';
import { listLocalRuns } from '../storage/run-catalog.js';
import { SQLiteConversationStore } from '../storage/sqlite-conversation-store.js';
import { ThetaWorkflowService } from '../theta-workflow-service.js';
import { resolveDatasetFile } from '../tools/dataset-path-policy.js';
import { runThetaModelCatalog } from '../tools/hypha-runner.js';
import {
  thetaWebCreateRunSchema,
  thetaWebRunActionSchema,
  type ThetaWebApiEnvelope,
  type ThetaWebApiHealth,
  type ThetaWebRunAction,
} from './contracts.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAgentRoot = path.resolve(moduleDirectory, '..', '..');

loadThetaProjectEnvironment();

export interface ThetaWebApiOptions {
  agentRoot?: string;
  runtimeDb?: string;
  host?: string;
  port?: number;
}

export const resolveThetaWebApiOptions = (): Required<ThetaWebApiOptions> => {
  const agentRoot = path.resolve(process.env.THETA_AGENT_ROOT ?? defaultAgentRoot);
  return {
    agentRoot,
    runtimeDb: path.resolve(
      process.env.THETA_WORKFLOW_DB ??
        path.join(agentRoot, '.theta_agent', 'theta-workflow.sqlite'),
    ),
    host: process.env.THETA_WEB_API_HOST ?? '127.0.0.1',
    port: parsePort(process.env.THETA_WEB_API_PORT),
  };
};

export const createThetaWebApiServer = (options: ThetaWebApiOptions = {}) => {
  const defaults = resolveThetaWebApiOptions();
  const resolved = { ...defaults, ...options };
  const workflow = new ThetaWorkflowService();

  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolved, workflow);
    } catch (error) {
      const clientError = error instanceof ZodError || error instanceof SyntaxError;
      writeJson(response, clientError ? 400 : 500, {
        ok: false,
        error: {
          code: clientError
            ? 'THETA_WEB_API_INVALID_REQUEST'
            : 'THETA_WEB_API_INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
};

const routeRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<ThetaWebApiOptions>,
  workflow: ThetaWorkflowService,
): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${options.host}:${options.port}`);

  if (method === 'OPTIONS') {
    writeCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === '/api/v2/health') {
    if (method !== 'GET') return methodNotAllowed(response);
    const report = await new DoctorService({ agentRoot: options.agentRoot }).run();
    const health: ThetaWebApiHealth = {
      service: 'theta-agent-api',
      version: 'v2',
      ...report,
    };
    writeJson(response, 200, { ok: true, data: health });
    return;
  }

  if (url.pathname === '/api/v2/runs') {
    if (method === 'POST') {
      const input = thetaWebCreateRunSchema.parse(await readJsonBody(request));
      const dataset = await resolveDatasetFile(input.filePath);
      const result = await workflow.run({
        input: {
          filePath: dataset.filePath,
          researchGoal: input.researchGoal,
          plannerMode: input.useMiniMax ? 'minimax' : 'deterministic',
        },
        runtimeDb: options.runtimeDb,
      });
      writeJson(response, 201, {
        ok: true,
        data: presentRun(result),
      });
      return;
    }
    if (method !== 'GET') return methodNotAllowed(response);
    const limit = boundedLimit(url.searchParams.get('limit'));
    const catalog = listLocalRuns(options.runtimeDb, limit);
    const runs = await Promise.all(
      catalog.map(async (run) => {
        try {
          const status = await workflow.status(run.runId, options.runtimeDb);
          return {
            ...run,
            status: status.status,
            currentState: status.currentState,
            pendingReason: status.pendingReason,
            lastEventType: status.lastEventType,
            lastEventAt: status.lastEventAt,
            presentation: buildHumanResponse(status),
          };
        } catch {
          return {
            ...run,
            status: 'unknown',
          };
        }
      }),
    );
    writeJson(response, 200, {
      ok: true,
      data: { runs },
    });
    return;
  }

  if (url.pathname === '/api/v2/datasets' && method === 'GET') {
    writeJson(response, 200, {
      ok: true,
      data: { datasets: await listDatasets(options.agentRoot) },
    });
    return;
  }

  if (url.pathname === '/api/v2/models' && method === 'GET') {
    const result = await runThetaModelCatalog({ includeExperimental: false });
    if (result.status !== 'completed' || !result.output) {
      throw new Error('无法读取本地 THETA 模型目录。');
    }
    writeJson(response, 200, { ok: true, data: result.output });
    return;
  }

  const statusMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/status$/);
  if (statusMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(statusMatch[1]);
    const status = await workflow.status(runId, options.runtimeDb);
    writeJson(response, 200, {
      ok: true,
      data: {
        ...status,
        runtimeDb: undefined,
        presentation: buildHumanResponse(status),
      },
    });
    return;
  }


  const planMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/plan$/);
  if (planMatch && method === 'GET') {
    const runId = decodeURIComponent(planMatch[1]);
    const plan = await workflow.plan(runId, options.runtimeDb);
    writeJson(response, 200, {
      ok: true,
      data: { ...plan, runtimeDb: undefined, presentation: buildHumanResponse(plan) },
    });
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/actions$/);
  if (actionMatch && method === 'POST') {
    const runId = decodeURIComponent(actionMatch[1]);
    const action = thetaWebRunActionSchema.parse(await readJsonBody(request));
    const value = await executeRunAction(
      runId,
      action,
      options.runtimeDb,
      workflow,
    );
    const nextStatus = await workflow.status(
      typeof value === 'object' && value && 'runId' in value
        ? String((value as { runId: unknown }).runId)
        : runId,
      options.runtimeDb,
    );
    writeJson(response, 200, {
      ok: true,
      data: { result: value, status: presentRun(nextStatus) },
    });
    return;
  }

  if (method !== 'GET') return methodNotAllowed(response);

  writeJson(response, 404, {
    ok: false,
    error: {
      code: 'THETA_WEB_API_NOT_FOUND',
      message: 'The requested THETA 2.0 API route does not exist.',
    },
  });
};

const writeJson = (
  response: ServerResponse,
  status: number,
  payload: ThetaWebApiEnvelope,
): void => {
  writeCors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

const writeCors = (response: ServerResponse): void => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4320');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
};

const presentRun = (value: unknown): Record<string, unknown> => {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    ...record,
    runtimeDb: undefined,
    presentation: buildHumanResponse(value),
  };
};

const executeRunAction = async (
  runId: string,
  action: ThetaWebRunAction,
  runtimeDb: string,
  workflow: ThetaWorkflowService,
): Promise<unknown> => {
  if (action.action === 'retry') {
    return new ResultService(workflow).retry(runId, runtimeDb);
  }
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    const orchestrator = new ThetaTurnOrchestrator(store, workflow);
    const command = action.action === 'answer'
      ? { kind: 'answer' as const, text: action.text }
      : action.action === 'columns'
        ? { kind: 'columns' as const, text: action.text }
        : action.action === 'finishInterview'
          ? { kind: 'done' as const }
          : action.action === 'adjustPlan'
            ? { kind: 'adjust' as const, text: action.text }
            : action.action === 'approvePlan'
              ? {
                  kind: 'approvePlan' as const,
                  acceptDegradation: action.acceptDegradation,
                }
              : { kind: 'startTraining' as const };
    const result = await orchestrator.execute(command, {
      sessionId: `theta-web-${runId}`,
      activeRunId: runId,
      runtimeDb,
    });
    return result.value;
  } finally {
    store.close();
  }
};

const listDatasets = async (agentRoot: string): Promise<Array<{
  name: string;
  filePath: string;
  sizeBytes: number;
}>> => {
  const roots = [path.join(agentRoot, 'fixtures'), path.join(agentRoot, '..', 'THETA', 'data')];
  const datasets: Array<{ name: string; filePath: string; sizeBytes: number }> = [];
  for (const [rootIndex, root] of roots.entries()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(csv|tsv|json|jsonl|txt)$/iu.test(entry.name)) continue;
      if (rootIndex === 0 && entry.name.toLowerCase().endsWith('.json')) continue;
      const resolved = await resolveDatasetFile(path.join(root, entry.name));
      datasets.push({ name: entry.name, filePath: resolved.filePath, sizeBytes: resolved.sizeBytes });
    }
  }
  return datasets.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('请求内容超过 64KB 限制。');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const methodNotAllowed = (response: ServerResponse): void => {
  writeJson(response, 405, {
    ok: false,
    error: {
      code: 'THETA_WEB_API_METHOD_NOT_ALLOWED',
      message: '当前接口不允许该操作。',
    },
  });
};

const boundedLimit = (value: string | null): number => {
  const parsed = value ? Number.parseInt(value, 10) : 30;
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 30;
};

const parsePort = (value: string | undefined): number => {
  const parsed = value ? Number.parseInt(value, 10) : 4318;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('THETA_WEB_API_PORT must be an integer between 1 and 65535.');
  }
  return parsed;
};

const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
};

if (isDirectExecution()) {
  const options = resolveThetaWebApiOptions();
  createThetaWebApiServer(options).listen(options.port, options.host, () => {
    console.log(`THETA 2.0 Agent API listening on http://${options.host}:${options.port}`);
  });
}
