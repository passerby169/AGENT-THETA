import {
  requestThetaTrainingCancel,
  requestThetaTrainingStart,
  runThetaTrainingStatus,
} from './tools/hypha-runner.js';

const start = await requestThetaTrainingStart({
  planId: 'plan_gate_only',
  planHash: 'hash_gate_only',
  approvalId: 'approval_gate_only',
  idempotencyKey: 'training-start-gate-only',
});
if (start.status !== 'human_review_required') {
  throw new Error(`training.start bypassed human review: ${JSON.stringify(start)}`);
}

const cancel = await requestThetaTrainingCancel(
  {
    trainingRunId: 'run_gate_only',
    reason: 'Verify cancellation approval gate.',
  },
  {
    idempotencyKey: 'training-cancel-gate-only',
  }
);
if (cancel.status !== 'human_review_required') {
  throw new Error(`training.cancel bypassed human review: ${JSON.stringify(cancel)}`);
}

const status = await runThetaTrainingStatus({
  trainingRunId: 'run_missing_for_status_smoke',
  logLimit: 10,
});
if (status.status !== 'completed' || !status.output || status.output.found !== false) {
  throw new Error(`training.status missing-run behavior failed: ${JSON.stringify(status)}`);
}

console.log(
  JSON.stringify({
    status: 'ok',
    runner: 'GovernedToolRunner',
    startGate: start.status,
    cancelGate: cancel.status,
    missingRunFound: status.output.found,
    processStarted: false,
  })
);
