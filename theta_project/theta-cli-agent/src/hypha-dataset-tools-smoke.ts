import {
  createThetaHyphaRuntime,
  createThetaToolCallContext,
  runThetaDatasetDetectColumns,
  runThetaDatasetInspect,
} from './tools/hypha-runner.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tools/tool-ids.js';

const fixture = 'theta-cli-agent/fixtures/sample.jsonl';

const inspected = await runThetaDatasetInspect({
  filePath: fixture,
  sampleSize: 10,
});
if (
  inspected.status !== 'completed' ||
  !inspected.output ||
  inspected.output.rowCount !== 3 ||
  !inspected.output.columns.includes('text')
) {
  throw new Error(`dataset.inspect failed: ${JSON.stringify(inspected)}`);
}

const detected = await runThetaDatasetDetectColumns({
  filePath: fixture,
  sampleSize: 10,
});
if (
  detected.status !== 'completed' ||
  !detected.output ||
  detected.output.recommendedTextColumn !== 'text'
) {
  throw new Error(`dataset.detect_columns failed: ${JSON.stringify(detected)}`);
}

const denied = await runThetaDatasetInspect({ filePath: fixture }, { permissionScopes: [] });
if (denied.status !== 'denied') {
  throw new Error(`dataset.inspect permission boundary failed: ${JSON.stringify(denied)}`);
}

const previousPython = process.env.THETA_AGENT_BRIDGE_PYTHON;
process.env.THETA_AGENT_BRIDGE_PYTHON = 'theta-python-must-not-start-for-denied-path';
const escaped = await runThetaDatasetInspect({
  filePath: 'theta-cli-agent/README.md',
});
const escapedMessage = typeof escaped.error === 'string' ? escaped.error : escaped.error?.message;
if (escaped.status !== 'failed' || !escapedMessage?.includes('outside THETA_ALLOWED_DATA_ROOTS')) {
  throw new Error(`Dataset path boundary failed: ${JSON.stringify(escaped)}`);
}
if (previousPython === undefined) {
  delete process.env.THETA_AGENT_BRIDGE_PYTHON;
} else {
  process.env.THETA_AGENT_BRIDGE_PYTHON = previousPython;
}

const runtime = createThetaHyphaRuntime();
const traceResult = await runtime.runner.run({
  toolId: THETA_TOOL_IDS.datasetInspect,
  input: { filePath: fixture, sampleSize: 10 },
  context: createThetaToolCallContext('dataset-audit-smoke', 'dataset_inspect', {
    permissionScopes: [THETA_PERMISSION_SCOPES.datasetRead],
  }),
});
if (traceResult.status !== 'completed') {
  throw new Error(`Dataset trace execution failed: ${JSON.stringify(traceResult)}`);
}
const trace = await runtime.trace.list({ runId: 'dataset-audit-smoke' });
const serializedTrace = JSON.stringify(trace);
if (
  serializedTrace.includes('The model discovers recurring themes') ||
  serializedTrace.includes('sampleRows') ||
  serializedTrace.includes('sampleValues')
) {
  throw new Error('Dataset audit trace contains raw sample data.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    runner: 'GovernedToolRunner',
    inspectedRows: inspected.output.rowCount,
    recommendedTextColumn: detected.output.recommendedTextColumn,
    permissionBoundary: denied.status,
    pathBoundary: escaped.status,
    rawSamplesInTrace: false,
  })
);
