import { unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  buildDatasetFacts,
  buildDeterministicUnderstanding,
} from './dataset-understanding/service.js';
import { SQLiteDatasetRegistry } from './storage/dataset-registry.js';
import { runThetaDatasetExplore } from './tools/hypha-runner.js';

const runtimeDb = path.resolve('.theta_agent', 'dataset-understanding-v2-smoke.sqlite');
try {
  unlinkSync(runtimeDb);
} catch {}
process.env.THETA_WORKFLOW_DB = runtimeDb;

const registry = new SQLiteDatasetRegistry(runtimeDb);
const record = await registry.registerLocalFile(
  'theta-cli-agent/fixtures/sample.jsonl',
  { userId: 'local_user', workspaceId: 'local_workspace' },
);
registry.close();

const first = await runThetaDatasetExplore({
  datasetRef: record.datasetRef,
  sampleSize: 3,
  sampleSeed: 'stable-seed',
});
const second = await runThetaDatasetExplore({
  datasetRef: record.datasetRef,
  sampleSize: 3,
  sampleSeed: 'stable-seed',
});
if (first.status !== 'completed' || !first.output) {
  throw new Error(`dataset.explore failed: ${JSON.stringify(first)}`);
}
if (second.status !== 'completed' || !second.output) {
  throw new Error(`dataset.explore replay failed: ${JSON.stringify(second)}`);
}
if (JSON.stringify(first.output.sample) !== JSON.stringify(second.output.sample)) {
  throw new Error('Deterministic dataset sampling is not stable.');
}
if (JSON.stringify(first.output).includes(record.managedPath)) {
  throw new Error('dataset.explore leaked the managed local path.');
}
const facts = buildDatasetFacts(first.output);
const understanding = buildDeterministicUnderstanding(facts, first.output);
if (understanding.datasetHash !== record.sha256) {
  throw new Error('Dataset understanding lost dataset hash provenance.');
}

const denied = await runThetaDatasetExplore(
  { datasetRef: record.datasetRef },
  { permissionScopes: [] },
);
if (denied.status !== 'denied') {
  throw new Error(`dataset.explore permission boundary failed: ${JSON.stringify(denied)}`);
}

console.log(
  JSON.stringify({
    status: 'ok',
    datasetRef: record.datasetRef,
    deterministicSample: true,
    localPathExposed: false,
    domain: understanding.domain.label,
    textColumn: understanding.textColumns[0]?.column ?? null,
  }),
);
