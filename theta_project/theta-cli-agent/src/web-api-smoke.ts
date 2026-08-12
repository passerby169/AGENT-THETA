import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createThetaWebApiServer, isUserFacingRun } from './web-api/server.js';
import { SQLiteConversationStore } from './storage/sqlite-conversation-store.js';
import {
  buildRestrictedProjectSummary,
  buildResultAnalysisContext,
  resultAnalysisTimeoutMs,
} from './results/result-analysis-service.js';
import type { RunResultOverview } from './results/result-service.js';
import {
  thetaResultAnalysisRequestSchema,
  thetaWebRunActionSchema,
} from './web-api/contracts.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-web-api-smoke-'));
const agentRoot = path.join(root, 'theta-cli-agent');
const dataRoot = path.join(root, 'THETA', 'data');
await mkdir(path.join(agentRoot, 'fixtures'), { recursive: true });
await mkdir(dataRoot, { recursive: true });
const originalAllowedRoots = process.env.THETA_ALLOWED_DATA_ROOTS;
process.env.THETA_ALLOWED_DATA_ROOTS = [path.join(agentRoot, 'fixtures'), dataRoot].join(path.delimiter);

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
  agentRoot,
  runtimeDb: path.join(root, 'runtime.sqlite'),
  host: '127.0.0.1',
  port: 4318,
});

try {
  assert.deepEqual(thetaWebRunActionSchema.parse({ action: 'poll' }), { action: 'poll' });
  assert.deepEqual(
    thetaWebRunActionSchema.parse({ action: 'message', text: '你能做什么？' }),
    { action: 'message', text: '你能做什么？', useMiniMax: true },
  );
  assert.deepEqual(
    thetaWebRunActionSchema.parse({
      action: 'confirmDataset',
      status: 'confirmed',
      domainLabel: '社会文本研究',
      analysisUnit: '每行一条文本记录',
      textColumns: ['text'],
    }),
    {
      action: 'confirmDataset',
      status: 'confirmed',
      domainLabel: '社会文本研究',
      analysisUnit: '每行一条文本记录',
      textColumns: ['text'],
      timeColumns: [],
      idColumns: [],
      metadataColumns: [],
      groupColumns: [],
      covariateColumns: [],
      evaluationColumns: [],
      ignoredColumns: [],
    },
  );
  assert.deepEqual(
    thetaWebRunActionSchema.parse({ action: 'decisionAnswer', text: '不比较不同群体。' }),
    { action: 'decisionAnswer', text: '不比较不同群体。' },
  );
  const analysisRequest = thetaResultAnalysisRequestSchema.parse({
    question: '这些主题之间有什么差异？',
    selection: { topicIds: ['topic-1'] },
  });
  assert.deepEqual(analysisRequest.selection.topicIds, ['topic-1']);
  assert.equal(analysisRequest.history.length, 0);
  const unscopedAnalysisRequest = thetaResultAnalysisRequestSchema.parse({
    question: '请分析结果',
    selection: {},
  });
  assert.deepEqual(unscopedAnalysisRequest.selection, {
    topicIds: [],
    metricKeys: [],
    visualizationIds: [],
    includeGoalAssessment: false,
    includeWarnings: false,
  });
  const restrictedProjectSummary = buildRestrictedProjectSummary({
    brief: {
      researchDomain: '教育与学习',
      researchQuestion: '识别主要主题并观察时间变化',
      analysisUnit: '每行一条文本记录',
      textFieldIntent: 'text 是正文列',
      candidateTimeColumns: ['timestamp'],
      candidateGroupColumns: ['source'],
      trendAnalysis: true,
      successCriteria: ['主题可解释'],
    },
    messages: [
      { role: 'system', messageKind: 'system.prompt', content: '不得进入摘要' },
      { role: 'user', messageKind: 'research.answer', content: '希望比较不同年份。' },
      { role: 'assistant', messageKind: 'research.question', content: '已记录时间比较需求。' },
      { role: 'tool', messageKind: 'tool.result', content: '原始工具输出不得进入摘要' },
    ],
  });
  assert.match(restrictedProjectSummary, /受限项目摘要/u);
  assert.match(restrictedProjectSummary, /教育与学习/u);
  assert.match(restrictedProjectSummary, /字段理解/u);
  assert.match(restrictedProjectSummary, /text 是正文列/u);
  assert.match(restrictedProjectSummary, /timestamp/u);
  assert.match(restrictedProjectSummary, /source/u);
  assert.match(restrictedProjectSummary, /希望比较不同年份/u);
  assert.doesNotMatch(restrictedProjectSummary, /不得进入摘要/u);
  assert.doesNotMatch(restrictedProjectSummary, /原始工具输出/u);
  const resultOverview = {
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
  } satisfies RunResultOverview;
  const selectedContext = buildResultAnalysisContext(
    resultOverview,
    analysisRequest.selection,
  );
  assert.match(selectedContext.text, /治理/u);
  assert.doesNotMatch(selectedContext.text, /市场/u);
  assert.equal(selectedContext.selected.topics, 1);
  const genericContext = buildResultAnalysisContext(
    resultOverview,
    unscopedAnalysisRequest.selection,
  );
  assert.match(genericContext.text, /未附加具体结果项/u);
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

  const runtimeDatabase = new DatabaseSync(path.join(root, 'runtime.sqlite'));
  runtimeDatabase.exec(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
  runtimeDatabase.prepare(`
    INSERT INTO runtime_events (run_id, type, event_json, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(
    conversationRunId,
    'run.started',
    JSON.stringify({
      eventId: 'event.run.started.smoke',
      runId: conversationRunId,
      type: 'run.started',
      timestamp: '2026-08-06T00:00:00.000Z',
      data: { datasetName: '用户数据集' },
    }),
    '2026-08-06T00:00:00.000Z',
  );
  runtimeDatabase.close();

  const deleteResponse = await requestJson(
    `${baseUrl}/api/v2/runs/${conversationRunId}/delete`,
    'POST',
    {},
  );
  assert.equal(deleteResponse.statusCode, 200);
  const deletedDatabase = new DatabaseSync(path.join(root, 'runtime.sqlite'));
  const remainingEvents = deletedDatabase.prepare(
    'SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?',
  ).get(conversationRunId) as { count: number };
  const remainingMessages = deletedDatabase.prepare(
    'SELECT COUNT(*) AS count FROM theta_conversation_messages WHERE run_id = ?',
  ).get(conversationRunId) as { count: number };
  assert.equal(Number(remainingEvents.count), 0);
  assert.equal(Number(remainingMessages.count), 0);
  deletedDatabase.close();

  const datasetsResponse = await requestJson(`${baseUrl}/api/v2/datasets`);
  assert.equal(datasetsResponse.statusCode, 200);

  const uploadBody = new FormData();
  uploadBody.set('file', new File(['text,timestamp\nhello,2026-08-07\n'], 'smoke.csv'));
  const uploadResponse = await fetch(`${baseUrl}/api/v2/datasets/upload`, {
    method: 'POST',
    body: uploadBody,
  });
  const uploaded = await uploadResponse.json() as {
    ok: boolean;
    data: { datasetRef: string; name: string; suffix: string; filePath?: string };
  };
  assert.equal(uploadResponse.status, 201);
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.data.datasetRef, /^dataset_/u);
  assert.equal(uploaded.data.name.endsWith('smoke.csv'), true);
  assert.equal(uploaded.data.suffix, '.csv');
  assert.equal(uploaded.data.filePath, undefined);

  const registeredResponse = await requestJson(`${baseUrl}/api/v2/datasets`);
  const registered = registeredResponse.body as {
    ok: boolean;
    data: { datasets: Array<{ datasetRef: string; filePath?: string }> };
  };
  assert.equal(registered.data.datasets.some(
    (dataset) => dataset.datasetRef === uploaded.data.datasetRef && dataset.filePath === undefined,
  ), true);

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
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  if (originalAllowedRoots === undefined) delete process.env.THETA_ALLOWED_DATA_ROOTS;
  else process.env.THETA_ALLOWED_DATA_ROOTS = originalAllowedRoots;
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
