import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FrameworkEvent } from '@hypha/core';
import { SQLiteV2ResearchStore } from './storage/v2-research-store.js';
import { THETA_APPROVAL_KEYS } from './theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowToolPort,
  type ThetaWorkflowToolRequest,
} from './theta-workflow-service.js';
import { THETA_TOOL_IDS } from './tools/tool-ids.js';

class V2FakeTools implements ThetaWorkflowToolPort {
  async invoke(request: ThetaWorkflowToolRequest): Promise<Record<string, unknown>> {
    if (request.toolId !== THETA_TOOL_IDS.datasetExplore) {
      throw new Error(`Unexpected V2 workflow tool: ${request.toolId}`);
    }
    return {
      datasetRef: request.input.datasetRef,
      datasetHash: DATASET_HASH,
      fileName: 'research.csv',
      format: 'csv',
      sizeBytes: 128,
      rowCount: 3,
      columns: ['text', 'timestamp', 'source'],
      profiles: [
        {
          name: 'text',
          inferredType: 'text',
          missingRatio: 0,
          uniqueCount: 3,
          averageLength: 12,
          maximumLength: 16,
        },
        {
          name: 'timestamp',
          inferredType: 'datetime',
          missingRatio: 0,
          uniqueCount: 3,
          averageLength: 10,
          maximumLength: 10,
        },
        {
          name: 'source',
          inferredType: 'string',
          missingRatio: 0,
          uniqueCount: 2,
          averageLength: 1,
          maximumLength: 1,
        },
      ],
      head: [{ text: '已脱敏样本', timestamp: '2026-01-01', source: 'A' }],
      sample: [{ text: '已脱敏样本', timestamp: '2026-01-02', source: 'B' }],
      sampleSeed: DATASET_HASH.slice(0, 16),
      sampleTruncated: false,
      redaction: {
        applied: true,
        redactedValueCount: 0,
        rules: ['email', 'phone', 'id'],
      },
      columnRoles: {
        text: [{ name: 'text', score: 0.98, reason: '主要自然语言列' }],
        time: [{ name: 'timestamp', score: 0.95, reason: '时间字段' }],
        id: [],
        metadata: [{ name: 'source', score: 0.8, reason: '低基数分组字段' }],
      },
      languageDistribution: [{ language: 'zh', ratio: 1 }],
      duplicateRatio: 0,
      timeCoverage: { start: '2026-01-01', end: '2026-01-03' },
      inferredDomain: {
        label: '社会文本研究',
        confidence: 0.78,
        evidence: ['中文自然语言记录'],
      },
      qualityWarnings: [],
    };
  }

  async listTrace(_runId: string): Promise<FrameworkEvent[]> {
    return [];
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-v2-workflow-'));
const previousAllowedRoots = process.env.THETA_ALLOWED_DATA_ROOTS;
process.env.THETA_ALLOWED_DATA_ROOTS = root;
const filePath = path.join(root, 'research.csv');
const fileBody = 'text,timestamp,source\n主题甲,2026-01-01,A\n主题乙,2026-01-02,B\n主题丙,2026-01-03,A\n';
const DATASET_HASH = createHash('sha256').update(fileBody).digest('hex');
const runtimeDb = path.join(root, 'workflow.sqlite');
const runId = 'theta-v2-workflow-smoke';

try {
  await writeFile(filePath, fileBody, 'utf8');
  const service = new ThetaWorkflowService({ toolPort: new V2FakeTools() });
  let result = await service.run({
    runId,
    runtimeDb,
    input: { filePath },
  });
  assert.equal(
    result.pendingActionRef,
    THETA_APPROVAL_KEYS.datasetUnderstanding,
  );
  const initialStatus = await service.status(runId, runtimeDb);
  assert.equal(initialStatus.workflowVersion, '2.0.0');
  assert.equal(initialStatus.metrics?.datasetExploreToolCalls, 1);
  assert.equal(initialStatus.metrics?.datasetUnderstandingValidationFailures, 0);

  result = await service.resume({
    runId,
    runtimeDb,
    datasetConfirmation: {
      status: 'confirmed',
      domainLabel: '社会文本研究',
      analysisUnit: '每一行是一条独立文本记录',
      textColumns: ['text'],
      timeColumns: ['timestamp'],
      idColumns: [],
      metadataColumns: ['source'],
    },
    approvedBy: 'owner.smoke',
  });
  assert.equal(result.pendingActionRef, THETA_APPROVAL_KEYS.researchIntent);

  for (const answer of ['识别主要主题和关键词', '按 source 比较', '不知道']) {
    result = await service.resume({
      runId,
      runtimeDb,
      decisionAnswer: answer,
      approvedBy: 'owner.smoke',
    });
    assert.equal(result.pendingActionRef, THETA_APPROVAL_KEYS.researchIntent);
  }

  const store = new SQLiteV2ResearchStore(runtimeDb);
  try {
    assert.equal(store.latestFacts(runId)?.value.datasetHash, DATASET_HASH);
    assert.equal(store.latestUnderstanding(runId)?.value.datasetHash, DATASET_HASH);
    assert.equal(store.confirmation(runId)?.textColumns[0], 'text');
    assert.ok(store.latestIntent(runId));
    assert.equal(store.interviewMemory(runId)?.resolvedGapIds.length, 3);
  } finally {
    store.close();
  }

  console.log(
    JSON.stringify({
      status: 'ok',
      runId,
      pendingActionRef: result.pendingActionRef,
      statePath: result.statePath,
    }),
  );
} finally {
  if (previousAllowedRoots === undefined) {
    delete process.env.THETA_ALLOWED_DATA_ROOTS;
  } else {
    process.env.THETA_ALLOWED_DATA_ROOTS = previousAllowedRoots;
  }
  await rm(root, { recursive: true, force: true });
}
