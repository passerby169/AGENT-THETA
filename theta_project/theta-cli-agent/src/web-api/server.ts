import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ThetaAgentApplicationService } from '../application/theta-agent-application-service.js';
import { DoctorService } from '../doctor-service.js';
import { loadThetaProjectEnvironment } from '../environment.js';
import { presentConfirmationCard } from '../checkpoints/confirmation-card-presenter.js';
import { thetaWebCheckpointDecisionSchema, thetaWebCreateRunSchema, thetaWebMessageSchema, type ThetaWebApiEnvelope } from './contracts.js';
import { DatasetUploadError, listDatasets, uploadDataset } from './dataset-upload.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAgentRoot = path.resolve(moduleDirectory, '..', '..');

loadThetaProjectEnvironment();

export interface ThetaWebApiOptions {
  agentRoot?: string;
  runtimeDb?: string;
  host?: string;
  port?: number;
  uploadDir?: string;
}

export const resolveThetaWebApiOptions = (): Required<ThetaWebApiOptions> => {
  const agentRoot = path.resolve(process.env.THETA_AGENT_ROOT ?? defaultAgentRoot);
  return {
    agentRoot,
    runtimeDb: path.resolve(
      process.env.THETA_AGENT_EVENT_DB ?? path.join(agentRoot, '.theta_agent', 'theta-agent-v3.sqlite'),
    ),
    host: process.env.THETA_WEB_API_HOST ?? '127.0.0.1',
    port: parsePort(process.env.THETA_WEB_API_PORT),
    uploadDir: path.resolve(process.env.THETA_DATASET_UPLOAD_DIR ?? path.join(agentRoot, '.theta_agent', 'uploads')),
  };
};

export const createThetaWebApiServer = (options: ThetaWebApiOptions = {}) => {
  const resolved = { ...resolveThetaWebApiOptions(), ...options };
  const application = new ThetaAgentApplicationService();
  return createServer(async (request, response) => {
    try {
      await route(request, response, resolved, application);
    } catch (error) {
      const uploadError = error instanceof DatasetUploadError ? error : undefined;
      const client = error instanceof ZodError || error instanceof SyntaxError;
      writeJson(response, uploadError?.status ?? (client ? 400 : 500), {
        ok: false,
        error: {
          code: uploadError?.code ?? (client ? 'THETA_V3_INVALID_REQUEST' : 'THETA_V3_INTERNAL_ERROR'),
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
};

const route = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<ThetaWebApiOptions>,
  application: ThetaAgentApplicationService,
): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${options.host}:${options.port}`);
  if (method === 'OPTIONS') {
    cors(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/api/v3/health' && method === 'GET') {
    const report = await new DoctorService({ agentRoot: options.agentRoot }).run();
    writeJson(response, 200, { ok: true, data: { service: 'theta-agent-api', version: 'v3', ...report } });
    return;
  }
  if (url.pathname === '/api/v3/datasets' && method === 'GET') {
    writeJson(response, 200, {
      ok: true,
      data: { datasets: listDatasets(options.runtimeDb, { userId: 'local_user', workspaceId: 'local_workspace' }) },
    });
    return;
  }
  if (url.pathname === '/api/v3/datasets/upload' && method === 'POST') {
    const dataset = await uploadDataset({
      request,
      runtimeDb: options.runtimeDb,
      uploadDir: options.uploadDir,
      userId: 'local_user',
      workspaceId: 'local_workspace',
    });
    writeJson(response, 201, { ok: true, data: dataset });
    return;
  }
  if (url.pathname === '/api/v3/runs' && method === 'POST') {
    const input = thetaWebCreateRunSchema.parse(await body(request));
    if (input.filePath && process.env.THETA_WEB_ALLOW_LOCAL_FILE_PATH !== 'true') {
      throw new DatasetUploadError(
        'THETA_LOCAL_FILE_PATH_DISABLED',
        'Web Run creation by filePath is disabled. Upload the dataset and use datasetRef.',
        400,
      );
    }
    let created;
    try {
      created = await application.createRun({
        ...(input.datasetRef ? { datasetRef: input.datasetRef } : {}),
        ...(input.filePath ? { filePath: input.filePath } : {}),
        runtimeDb: options.runtimeDb,
        initialMessage: input.researchGoal,
        allowRemoteSamples: input.allowRemoteSamples,
      });
    } catch (error) {
      if (input.datasetRef && error instanceof Error && error.message.startsWith('Dataset reference is unknown')) {
        throw new DatasetUploadError('THETA_DATASET_REF_NOT_FOUND', error.message, 404);
      }
      throw error;
    }
    writeJson(response, 201, { ok: true, data: created });
    return;
  }
  const activityStreamMatch = /^\/api\/v3\/runs\/([^/]+)\/activities\/stream$/u.exec(url.pathname);
  if (activityStreamMatch && method === 'GET') {
    const runId = decodeURIComponent(activityStreamMatch[1]);
    await streamActivities(request, response, application, runId, options.runtimeDb);
    return;
  }
  const activityMatch = /^\/api\/v3\/runs\/([^/]+)\/(activities|progress)$/u.exec(url.pathname);
  if (activityMatch && method === 'GET') {
    const runId = decodeURIComponent(activityMatch[1]);
    const snapshot = await application.activities(runId, options.runtimeDb);
    writeJson(response, 200, { ok: true, data: activityMatch[2] === 'progress' ? snapshot.progress : snapshot });
    return;
  }
  const actionMatch = /^\/api\/v3\/runs\/([^/]+)\/(messages|checkpoint|checkpoint-decision|conversation|intake|upload-request|discover|research|plan-design|prepare-training|advance-training|cancel-training)$/u.exec(url.pathname);
  if (actionMatch) {
    const runId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    if (action === 'intake' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.runIntake(runId, options.runtimeDb, options.uploadDir) });
      return;
    }
    if (action === 'upload-request' && method === 'GET') {
      writeJson(response, 200, { ok: true, data: application.currentDatasetUploadRequest(runId, options.runtimeDb, options.uploadDir) });
      return;
    }
    if (action === 'messages' && method === 'POST') {
      const input = thetaWebMessageSchema.parse(await body(request));
      const snapshot = await application.status(runId, options.runtimeDb);
      if (['DatasetCheckpoint', 'ResearchCheckpoint', 'PlanConfirmation'].includes(snapshot.currentState ?? '')) {
        throw new Error('This confirmation requires POST /checkpoint-decision with action=approve or action=revise.');
      }
      const data = snapshot.currentState === 'Intake'
        ? await application.submitIntakeMessage({
            runId,
            runtimeDb: options.runtimeDb,
            uploadRoot: options.uploadDir,
            content: input.content,
            messageId: input.messageId,
          })
        : snapshot.currentState === 'DatasetDiscovery'
        ? await application.submitDatasetDiscoveryMessage({
            runId,
            runtimeDb: options.runtimeDb,
            content: input.content,
            messageId: input.messageId,
          })
        : snapshot.currentState === 'ResearchDialogue'
          ? await application.submitResearchMessage({
            runId,
            runtimeDb: options.runtimeDb,
            content: input.content,
            messageId: input.messageId,
          })
        : snapshot.currentState === 'TrainingConfirmation'
          ? await application.submitTrainingConfirmationMessage({
              runId,
              runtimeDb: options.runtimeDb,
              content: input.content,
              messageId: input.messageId,
            })
        : await application.submitCheckpointMessage({
            runId,
            runtimeDb: options.runtimeDb,
            content: input.content,
            messageId: input.messageId,
          });
      writeJson(response, 200, { ok: true, data });
      return;
    }
    if (action === 'checkpoint-decision' && method === 'POST') {
      const input = thetaWebCheckpointDecisionSchema.parse(await body(request));
      writeJson(response, 200, {
        ok: true,
        data: await application.decideCheckpoint({
          runId,
          runtimeDb: options.runtimeDb,
          ...input,
        }),
      });
      return;
    }
    if (action === 'checkpoint' && method === 'GET') {
      const checkpoint = await application.currentCheckpoint(runId, options.runtimeDb);
      const snapshot = await application.status(runId, options.runtimeDb);
      const active = checkpoint !== null && checkpoint.status === 'proposed' && ({
        dataset: 'DatasetCheckpoint',
        research: 'ResearchCheckpoint',
        plan: 'PlanConfirmation',
        training: 'TrainingConfirmation',
      } as const)[checkpoint.kind] === snapshot.currentState;
      writeJson(response, 200, {
        ok: true,
        data: !active || checkpoint === null ? null : { ...checkpoint, view: presentConfirmationCard(checkpoint) },
      });
      return;
    }
    if (action === 'conversation' && method === 'GET') {
      writeJson(response, 200, { ok: true, data: await application.conversation(runId, options.runtimeDb) });
      return;
    }
    if (action === 'discover' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.runDatasetDiscovery(runId, options.runtimeDb) });
      return;
    }
    if (action === 'research' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.runResearchDialogue(runId, options.runtimeDb) });
      return;
    }
    if (action === 'plan-design' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.runPlanDesign(runId, options.runtimeDb) });
      return;
    }
    if (action === 'prepare-training' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.prepareTraining(runId, options.runtimeDb) });
      return;
    }
    if (action === 'advance-training' && method === 'POST') {
      writeJson(response, 200, { ok: true, data: await application.advanceTraining(runId, options.runtimeDb) });
      return;
    }
    if (action === 'cancel-training' && method === 'POST') {
      const input = thetaWebMessageSchema.parse(await body(request));
      writeJson(response, 200, { ok: true, data: await application.cancelTraining(runId, input.content, options.runtimeDb) });
      return;
    }
  }
  const match = /^\/api\/v3\/runs\/([^/]+)(?:\/(evidence))?$/u.exec(url.pathname);
  if (match && method === 'GET') {
    const runId = decodeURIComponent(match[1]);
    const data = match[2]
      ? await application.evidence(runId, options.runtimeDb)
      : await application.status(runId, options.runtimeDb);
    writeJson(response, 200, { ok: true, data });
    return;
  }
  writeJson(response, 404, {
    ok: false,
    error: { code: 'THETA_V3_NOT_FOUND', message: 'Route not found.' },
  });
};

const streamActivities = async (
  request: IncomingMessage,
  response: ServerResponse,
  application: ThetaAgentApplicationService,
  runId: string,
  runtimeDb: string,
): Promise<void> => {
  cors(response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  let lastSignature = '';
  let closed = false;
  request.on('close', () => { closed = true; });
  const send = async (): Promise<void> => {
    const snapshot = await application.activities(runId, runtimeDb);
    const latestEvent = snapshot.recent.at(-1);
    const signature = `${latestEvent?.eventId ?? ''}:${snapshot.current?.eventId ?? ''}:${snapshot.current?.status ?? ''}:${snapshot.progress.percent}`;
    if (signature === lastSignature || closed) return;
    lastSignature = signature;
    response.write(`event: activity\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };
  await send();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void send().catch((error) => {
        if (!closed) response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
      });
      if (closed) {
        clearInterval(timer);
        resolve();
      }
    }, 750);
  });
  if (!response.writableEnded) response.end();
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new Error('Request exceeds 64KB.');
    chunks.push(value);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};

const writeJson = (response: ServerResponse, status: number, envelope: ThetaWebApiEnvelope): void => {
  cors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(envelope));
};

const cors = (response: ServerResponse): void => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3000');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const parsePort = (value: string | undefined): number => {
  const parsed = value ? Number.parseInt(value, 10) : 4318;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('Invalid API port.');
  return parsed;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = resolveThetaWebApiOptions();
  createThetaWebApiServer(options).listen(options.port, options.host, () => {
    console.log(`THETA V3 Agent API listening on http://${options.host}:${options.port}`);
  });
}
