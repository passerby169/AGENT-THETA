import {
  createApprovalReceipt,
  createDryRunReceipt,
  createTrainingPlanRecord,
} from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";
import {
  requestThetaTrainingCancel,
  requestThetaTrainingStart,
  runThetaTrainingStatus,
} from "./tools/hypha-runner.js";

const plan = createTrainingPlanRecord({
  ...createPlanningFixture(),
  createdAt: "2026-07-28T00:00:00.000Z",
});
const planReview = createApprovalReceipt({
  approvalType: "human_plan_review",
  plan,
  approvedBy: "controls_smoke",
  approvedAt: "2026-07-28T00:00:01.000Z",
});
const dryRun = createDryRunReceipt({
  planId: plan.planId,
  planHash: plan.planHash,
  planReviewApprovalId: planReview.approvalId,
  passed: true,
  checks: [
    { code: "SMOKE", status: "pass", detail: "Synthetic gate fixture." },
  ],
  commands: [
    {
      step: "train",
      cwd: "theta_project",
      argv: ["python", "run_pipeline.py"],
      sideEffect: "external_effect",
    },
  ],
  expectedArtifacts: [],
  notes: [],
  checkedAt: "2026-07-28T00:00:02.000Z",
});
const trainingReview = createApprovalReceipt({
  approvalType: "human_training_review",
  plan,
  approvedBy: "controls_smoke",
  approvedAt: "2026-07-28T00:00:03.000Z",
  dryRunHash: dryRun.dryRunHash,
});

const start = await requestThetaTrainingStart({
  plan,
  planReview,
  dryRun,
  trainingReview,
  idempotencyKey: "training-start-gate-only",
});
if (start.status !== "human_review_required") {
  throw new Error(
    `training.start bypassed human review: ${JSON.stringify(start)}`,
  );
}

const cancel = await requestThetaTrainingCancel(
  {
    trainingRunId: "run_gate_only",
    reason: "Verify cancellation approval gate.",
  },
  { idempotencyKey: "training-cancel-gate-only" },
);
if (cancel.status !== "human_review_required") {
  throw new Error(
    `training.cancel bypassed human review: ${JSON.stringify(cancel)}`,
  );
}

const status = await runThetaTrainingStatus({
  trainingRunId: "run_missing_for_status_smoke",
  logLimit: 10,
});
if (
  status.status !== "completed" ||
  !status.output ||
  status.output.found !== false
) {
  throw new Error(
    `training.status missing-run behavior failed: ${JSON.stringify(status)}`,
  );
}

console.log(
  JSON.stringify({
    status: "ok",
    runner: "GovernedToolRunner",
    startGate: start.status,
    cancelGate: cancel.status,
    distinctApprovalIds: planReview.approvalId !== trainingReview.approvalId,
    missingRunFound: status.output.found,
    processStarted: false,
  }),
);
