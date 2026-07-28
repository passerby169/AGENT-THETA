import {
  assertApprovalChain,
  createApprovalReceipt,
  createDryRunReceipt,
  createTrainingPlanRecord,
} from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";

const first = createTrainingPlanRecord({
  ...createPlanningFixture(),
  createdAt: "2026-07-28T00:00:00.000Z",
});
const sameMaterial = createTrainingPlanRecord({
  ...createPlanningFixture(),
  createdAt: "2026-07-29T00:00:00.000Z",
});
if (
  first.planHash !== sameMaterial.planHash ||
  first.planId !== sameMaterial.planId
) {
  throw new Error("Display timestamps changed the canonical plan identity.");
}

const changedInput = createPlanningFixture();
changedInput.validatedPlan = { ...changedInput.validatedPlan, numTopics: 9 };
changedInput.recommendation = {
  ...(changedInput.recommendation as Record<string, unknown>),
  recommendations: [
    {
      ...(
        changedInput.recommendation as {
          recommendations: Array<Record<string, unknown>>;
        }
      ).recommendations[0],
      recommendedPlanPatch: {
        modelId: "lda",
        mode: "unsupervised",
        numTopics: 9,
        batchSize: 64,
        epochs: 20,
      },
    },
  ],
};
const changed = createTrainingPlanRecord({
  ...changedInput,
  createdAt: "2026-07-28T00:00:00.000Z",
});
if (changed.planHash === first.planHash) {
  throw new Error("Execution material did not change the canonical plan hash.");
}

const planReview = createApprovalReceipt({
  approvalType: "human_plan_review",
  plan: first,
  approvedBy: "owner.smoke",
  approvedAt: "2026-07-28T00:00:01.000Z",
});
const dryRun = createDryRunReceipt({
  planId: first.planId,
  planHash: first.planHash,
  planReviewApprovalId: planReview.approvalId,
  passed: true,
  checks: [{ code: "PLAN_CHAIN_SMOKE", status: "pass", detail: "Ready." }],
  commands: [
    {
      step: "train",
      cwd: "theta_project/THETA/src/models",
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
  plan: first,
  approvedBy: "owner.smoke",
  approvedAt: "2026-07-28T00:00:03.000Z",
  dryRunHash: dryRun.dryRunHash,
});
assertApprovalChain({ plan: first, planReview, dryRun, trainingReview });
if (planReview.approvalId === trainingReview.approvalId) {
  throw new Error("The two human approvals shared an ID.");
}

let staleDryRunRejected = false;
try {
  assertApprovalChain({
    plan: first,
    planReview,
    dryRun,
    trainingReview: {
      ...trainingReview,
      dryRunHash: "f".repeat(64),
    },
  });
} catch {
  staleDryRunRejected = true;
}
if (!staleDryRunRejected) {
  throw new Error("A stale dry-run approval was accepted.");
}

console.log(
  JSON.stringify({
    status: "ok",
    planId: first.planId,
    planHash: first.planHash,
    changedPlanHash: changed.planHash,
    planReviewApprovalId: planReview.approvalId,
    trainingReviewApprovalId: trainingReview.approvalId,
    dryRunHash: dryRun.dryRunHash,
    staleDryRunRejected,
  }),
);
