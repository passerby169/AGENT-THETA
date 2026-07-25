import {
  runApprovedThetaPlanApprove,
  runApprovedThetaPlanCreate,
  runThetaTrainingDryRun,
} from './tools/hypha-runner.js';

const planInput = {
  plan: {
    datasetId: 'demo-dataset',
    modelId: 'lda',
    mode: 'unsupervised' as const,
    numTopics: 8,
    textColumn: 'content',
  },
  rationale: 'Full lifecycle smoke test.',
};

const created = await runApprovedThetaPlanCreate(planInput, {
  invocationId: 'theta-plan-lifecycle-create',
  idempotencyKey: 'theta-plan-lifecycle-create',
});
if (created.status !== 'completed' || !created.output) {
  throw new Error(`plan creation failed: ${JSON.stringify(created.error ?? created.status)}`);
}

const approved = await runApprovedThetaPlanApprove(
  {
    planId: created.output.planId,
    planHash: created.output.planHash,
    approvedBy: 'lifecycle_smoke',
    approvalNote: 'Approved only for the governed lifecycle smoke test.',
  },
  {
    invocationId: 'theta-plan-lifecycle-approve',
    idempotencyKey: 'theta-plan-lifecycle-approve',
  }
);
if (approved.status !== 'completed' || !approved.output) {
  throw new Error(`plan approval failed: ${JSON.stringify(approved.error ?? approved.status)}`);
}

const dryRun = await runThetaTrainingDryRun({
  planId: created.output.planId,
  planHash: created.output.planHash,
});
if (dryRun.status !== 'completed' || !dryRun.output) {
  throw new Error(`training dry run failed: ${JSON.stringify(dryRun.error ?? dryRun.status)}`);
}
if (!dryRun.output.approved || dryRun.output.commands.length !== 2) {
  throw new Error('training dry run did not observe the approval or derive two commands.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    runner: 'GovernedToolRunner',
    planId: created.output.planId,
    approvalId: approved.output.approvalId,
    approved: dryRun.output.approved,
    commandCount: dryRun.output.commands.length,
    trainingStarted: false,
  })
);
