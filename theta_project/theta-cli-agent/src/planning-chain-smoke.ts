import {
  assertApprovalChain,
  createApprovalReceipt,
  createDryRunReceipt,
  createTrainingPlanRecord,
} from "./planning/engine.js";
import {
  applyUserParameterOverrides,
  applyValidatorParameterCorrections,
  buildParameterDecisions,
} from "./planning/parameter-decisions.js";
import { createPlanningFixture } from "./planning/test-fixture.js";

const recommendedPlan = {
  modelId: "lda",
  mode: "unsupervised",
  topicCountMode: "fixed",
  numTopics: 10,
  epochs: 100,
};
const recommendedDecisions = buildParameterDecisions({
  recommendedPlan,
  effectivePlan: recommendedPlan,
});
const userDecisions = applyUserParameterOverrides(
  recommendedDecisions,
  { numTopics: 8 },
  { ...recommendedPlan, numTopics: 8 },
  "2026-07-28T00:00:00.000Z",
);
if (
  userDecisions.numTopics?.recommendedValue !== 10 ||
  userDecisions.numTopics.effectiveValue !== 8 ||
  userDecisions.numTopics.source !== "user_override"
) {
  throw new Error("A user parameter override lost its recommendation lineage.");
}
const validatorDecisions = applyValidatorParameterCorrections(
  userDecisions,
  { ...recommendedPlan, numTopics: 8 },
  { ...recommendedPlan, numTopics: 7 },
  "2026-07-28T00:00:01.000Z",
);
if (
  validatorDecisions.numTopics?.recommendedValue !== 10 ||
  validatorDecisions.numTopics.effectiveValue !== 7 ||
  validatorDecisions.numTopics.source !== "validator_correction"
) {
  throw new Error("A validator correction lost its recommendation lineage.");
}

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

const decisionInput = createPlanningFixture();
const materialResolution = {
  resolvedPlan: decisionInput.validatedPlan,
  acceptedFields: ["numTopics"],
  rejectedFields: [],
  source: "deterministic_fallback",
};
decisionInput.plannerResolution = {
  ...materialResolution,
  parameterDecisions: userDecisions,
};
const decisionPlan = createTrainingPlanRecord({
  ...decisionInput,
  createdAt: "2026-07-28T00:00:00.000Z",
});
const decisionPlanWithoutMetadata = createTrainingPlanRecord({
  ...createPlanningFixture(),
  plannerResolution: materialResolution,
  createdAt: "2026-07-28T00:00:00.000Z",
});
if (
  decisionPlan.review.parameterDecisions?.numTopics?.recommendedValue !== 10 ||
  decisionPlan.review.parameterDecisions.numTopics.effectiveValue !== 8 ||
  decisionPlan.review.parameterDecisions.numTopics.source !== "user_override"
) {
  throw new Error("Plan Review did not persist the parameter decision lineage.");
}
if (decisionPlan.planHash !== decisionPlanWithoutMetadata.planHash) {
  throw new Error("Parameter decision metadata changed the canonical plan hash.");
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

const alternateInput = createPlanningFixture();
const primaryRecommendation = (
  alternateInput.recommendation as {
    recommendations: Array<Record<string, unknown>>;
  }
).recommendations[0];
if (!primaryRecommendation) {
  throw new Error("Planning fixture is missing its primary recommendation.");
}
alternateInput.validatedPlan = {
  ...alternateInput.validatedPlan,
  modelId: "dtm",
  numTopics: 5,
};
alternateInput.recommendation = {
  ...(alternateInput.recommendation as Record<string, unknown>),
  recommendations: [
    primaryRecommendation,
    {
      ...primaryRecommendation,
      rank: 2,
      modelId: "dtm",
      modelName: "Dynamic Topic Model",
      recommendedPlanPatch: {
        modelId: "dtm",
        mode: "unsupervised",
        numTopics: 5,
        batchSize: 64,
        epochs: 20,
      },
    },
  ],
};
const alternate = createTrainingPlanRecord({
  ...alternateInput,
  createdAt: "2026-07-28T00:00:00.000Z",
});
if (alternate.canonicalPlan.model.modelId !== "dtm") {
  throw new Error("A compatible alternate recommendation was not selectable.");
}

let unlistedModelRejected = false;
try {
  createTrainingPlanRecord({
    ...alternateInput,
    validatedPlan: {
      ...alternateInput.validatedPlan,
      modelId: "unlisted-model",
    },
    createdAt: "2026-07-28T00:00:00.000Z",
  });
} catch {
  unlistedModelRejected = true;
}
if (!unlistedModelRejected) {
  throw new Error("An unlisted model bypassed recommendation governance.");
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
    alternateModelId: alternate.canonicalPlan.model.modelId,
    parameterDecisionSource: decisionPlan.review.parameterDecisions?.numTopics?.source,
    unlistedModelRejected,
    planReviewApprovalId: planReview.approvalId,
    trainingReviewApprovalId: trainingReview.approvalId,
    dryRunHash: dryRun.dryRunHash,
    staleDryRunRejected,
  }),
);
