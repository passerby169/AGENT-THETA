import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createThetaWebApiServer, isUserFacingRun } from './web-api/server.js';
import { SQLiteConversationStore } from './storage/sqlite-conversation-store.js';
import {
  buildResultAnalysisContext,
  resultAnalysisTimeoutMs,
} from './results/result-analysis-service.js';
import type { RunResultOverview } from './results/result-service.js';
import {
  thetaResultAnalysisRequestSchema,
  thetaWebRunActionSchema,
} from './web-api/contracts.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-web-api-smoke-'));

assert.equal(isUserFacingRun({ runId: 'theta-stage-c2-ready' }), false);
assert.equal(isUserFacingRun({
  runId: 'theta-run-example',
  identity: { datasetName: 'recommendation-sample' },
}), false);
assert.equal(isUserFacingRun({
  runId: 'theta-run-user',
  identity: { datasetName: '我的数据集' },
}), true);

const originalResultTimeout = process.env.THETA_RESULT_ANALYSIS_TIMEOUT_MS;
delete process.env.THETA_RESULT_ANALYSIS_TIMEOUT_MS;
assert.equal(resultAnalysisTimeoutMs(), 120_000);
process.env.THETA_RESULT_ANALYSIS_TIMEOUT_MS = '999999';
assert.equal(resultAnalysisTimeoutMs(), 180_000);
if (originalResultTimeout === undefined) {
  delete process.env.THETA_RESULT_ANALYSIS_TIMEOUT_MS;
} else {
  process.env.THETA_RESULT_ANALYSIS_TIMEOUT_MS = originalResultTimeout;
}
const server = createThetaWebApiServer({
  agentRoot: process.cwd(),
  runtimeDb: path.join(root, 'runtime.sqlite'),
  host: '127.0.0.1',
  port: 4318,
});

try {
  assert.deepEqual(thetaWebRunActionSchema.parse({ action: 'poll' }), { action: 'poll' });
  const analysisRequest = thetaResultAnalysisRequestSchema.parse({
    question: '这些主题之间有什么差异？',
    selection: { topicIds: ['topic-1'] },
  });
  assert.deepEqual(analysisRequest.selection.topicIds, ['topic-1']);
  assert.equal(analysisRequest.history.length, 0);
  assert.throws(() => thetaResultAnalysisRequestSchema.parse({
    question: '请分析结果',
    selection: {},
  }));
  const selectedContext = buildResultAnalysisContext({
    kind: 'run.results',
    runId: 'run-analysis-smoke',
    status: 'completed',
    progress: 100,
    artifacts: [],
    visualizations: [],
    metrics: { coherence: 0.71, ignored: 0.2 },
    topics: [
      { id: 'topic-1', name: '治理', strength: 0.4, keywords: ['政策', '监管'] },
      { id: 'topic-2', name: '市场', strength: 0.3, keywords: ['价格'] },
    ],
    capabilities: {},
    experiments: [],
    goalAssessment: [],
    comparison: [],
    parameterDecisions: {},
    warnings: [],
    message: 'completed',
  } satisfies RunResultOverview, analysisRequest.selection);
  assert.match(selectedContext.text, /治理/u);
  assert.doesNotMatch(selectedContext.text, /市场/u);
  assert.equal(selectedContext.selected.topics, 1);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const conversationRunId = 'theta-run-conversation-smoke';
  const conversationStore = new SQLiteConversationStore(
    path.join(root, 'runtime.sqlite'),
  );
  conversationStore.getOrCreateSession(`theta-web-${conversationRunId}`, {
    activeRunId: conversationRunId,
  });
  conversationStore.appendMessage({
    messageId: 'message.user.smoke',
    sessionId: `theta-web-${conversationRunId}`,
    runId: conversationRunId,
    role: 'user',
    messageKind: 'research.answer',
    content: '我希望比较不同时间阶段。',
    createdAt: '2026-08-06T00:00:00.000Z',
  });
  conversationStore.appendMessage({
    messageId: 'message.assistant.smoke',
    sessionId: `theta-web-${conversationRunId}`,
    runId: conversationRunId,
    role: 'assistant',
    messageKind: 'research.progress',
    content: '已记录比较需求。',
    createdAt: '2026-08-06T00:00:01.000Z',
  });
  conversationStore.close();

  const conversationResponse = await requestJson(
    `${baseUrl}/api/v2/runs/${conversationRunId}/conversation?limit=20`,
  );
  const conversation = conversationResponse.body as {
    ok: boolean;
    data: { messages: Array<{ role: string; content: string }> };
  };
  assert.equal(conversationResponse.statusCode, 200);
  assert.equal(conversation.ok, true);
  assert.deepEqual(
    conversation.data.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: '我希望比较不同时间阶段。' },
      { role: 'assistant', content: '已记录比较需求。' },
    ],
  );

  const runsResponse = await requestJson(`${baseUrl}/api/v2/runs?limit=3`);
  const runs = runsResponse.body as {
    ok: boolean;
    data: { runs: unknown[] };
  };
  assert.equal(runsResponse.statusCode, 200);
  assert.equal(runs.ok, true);
  assert.deepEqual(runs.data.runs, []);

  const datasetsResponse = await requestJson(`${baseUrl}/api/v2/datasets`);
  assert.equal(datasetsResponse.statusCode, 200);

  const invalidCreate = await requestJson(
    `${baseUrl}/api/v2/runs`,
    'POST',
    {},
  );
  assert.equal(invalidCreate.statusCode, 400);

  const writeResponse = await requestJson(`${baseUrl}/api/v2/missing`, 'POST');
  assert.equal(writeResponse.statusCode, 405);

  const missingResponse = await requestJson(`${baseUrl}/api/v2/missing`);
  assert.equal(missingResponse.statusCode, 404);

  console.log(JSON.stringify({ status: 'ok', governedActions: true, version: 'v2' }));
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(root, { recursive: true, force: true });
}

async function requestJson(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method,
        headers: body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      },
      (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (error) {
          reject(error);
        }
      });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
