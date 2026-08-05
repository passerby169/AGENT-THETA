import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoctorService } from '../doctor-service.js';
import { loadThetaProjectEnvironment } from '../environment.js';
import { listLocalRuns } from '../storage/run-catalog.js';
import { ThetaWorkflowService } from '../theta-workflow-service.js';
import type { ThetaWebApiEnvelope, ThetaWebApiHealth } from './contracts.js';

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
      writeJson(response, 500, {
        ok: false,
        error: {
          code: 'THETA_WEB_API_INTERNAL_ERROR',
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

  if (method !== 'GET') {
    writeJson(response, 405, {
      ok: false,
      error: {
        code: 'THETA_WEB_API_METHOD_NOT_ALLOWED',
        message: 'The THETA 2.0 preview API is read-only.',
      },
    });
    return;
  }

  if (url.pathname === '/api/v2/health') {
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

  const statusMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/status$/);
  if (statusMatch) {
    const runId = decodeURIComponent(statusMatch[1]);
    const status = await workflow.status(runId, options.runtimeDb);
    writeJson(response, 200, {
      ok: true,
      data: {
        ...status,
        runtimeDb: undefined,
      },
    });
    return;
  }

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
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
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
