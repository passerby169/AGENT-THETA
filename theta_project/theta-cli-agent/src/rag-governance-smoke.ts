import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runThetaRagBuild,
  runThetaRagStatus,
} from './tools/hypha-runner.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-rag-governance-'));
const previousIndex = process.env.THETA_KNOWLEDGE_INDEX;
process.env.THETA_KNOWLEDGE_INDEX = path.join(root, 'knowledge.sqlite');

try {
  const before = await runThetaRagStatus();
  if (
    before.status !== 'completed' ||
    before.output?.status !== 'not_built'
  ) {
    throw new Error('Governed RAG status did not report a missing index.');
  }

  const built = await runThetaRagBuild();
  if (
    built.status !== 'completed' ||
    built.output?.status !== 'ready' ||
    built.output.totalSources < 1 ||
    built.output.totalChunks < 1
  ) {
    throw new Error('Governed RAG build did not produce an evidence index.');
  }

  const after = await runThetaRagStatus();
  if (
    after.status !== 'completed' ||
    after.output?.status !== 'ready' ||
    after.output.totalSources !== built.output.totalSources ||
    after.output.totalChunks !== built.output.totalChunks
  ) {
    throw new Error('Governed RAG status did not match the built index.');
  }

  console.log(
    JSON.stringify({
      status: 'ok',
      toolBoundary: 'GovernedToolRunner',
      totalSources: after.output.totalSources,
      totalChunks: after.output.totalChunks,
    }),
  );
} finally {
  if (previousIndex === undefined) {
    delete process.env.THETA_KNOWLEDGE_INDEX;
  } else {
    process.env.THETA_KNOWLEDGE_INDEX = previousIndex;
  }
  await rm(root, { recursive: true, force: true });
}
