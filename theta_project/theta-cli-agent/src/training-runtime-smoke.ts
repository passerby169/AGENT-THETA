import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createApprovalReceipt,
  createDryRunReceipt,
  createTrainingPlanRecord,
} from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";
import { runApprovedThetaTrainingStart } from "./tools/hypha-runner.js";
import type { ThetaTrainingStartInput } from "./tools/training-start-tool.js";

const stateRoot = await mkdtemp(
  path.join(os.tmpdir(), "theta-training-runtime-smoke-"),
);
process.env.THETA_AGENT_STATE_DIR = stateRoot;

const plan = createTrainingPlanRecord({
  ...createPlanningFixture(),
  createdAt: "2026-07-28T00:00:00.000Z",
});
const planReview = createApprovalReceipt({
  approvalType: "human_plan_review",
  plan,
  approvedBy: "runtime.smoke",
  approvedAt: "2026-07-28T00:00:01.000Z",
});

const createStartInput = (
  idempotencyKey: string,
  command: string,
  expectedArtifacts: Array<{
    kind: string;
    path: string;
    description: string;
  }>,
): ThetaTrainingStartInput => {
  const dryRun = createDryRunReceipt({
    planId: plan.planId,
    planHash: plan.planHash,
    planReviewApprovalId: planReview.approvalId,
    passed: true,
    checks: [
      {
        code: "RUNTIME_SMOKE_PREFLIGHT",
        status: "pass",
        detail: "The simulated training command is locally executable.",
      },
    ],
    commands: [
      {
        step: "simulated_training",
        cwd: process.cwd(),
        argv: ["python", "-c", command],
        sideEffect: "external_effect",
      },
    ],
    expectedArtifacts,
    notes: [],
    checkedAt: "2026-07-28T00:00:02.000Z",
  });
  const trainingReview = createApprovalReceipt({
    approvalType: "human_training_review",
    plan,
    approvedBy: "runtime.smoke",
    approvedAt: "2026-07-28T00:00:03.000Z",
    dryRunHash: dryRun.dryRunHash,
  });
  return {
    plan,
    planReview,
    dryRun,
    trainingReview,
    idempotencyKey,
  };
};

const completedInput = createStartInput(
  "training-runtime-smoke-forged-command",
  "print('forged training')",
  [],
);

try {
  const call = await runApprovedThetaTrainingStart(completedInput, {
    invocationId: "training-runtime-smoke-forged-command",
    idempotencyKey: completedInput.idempotencyKey,
    userId: "runtime.smoke",
  });
  const error =
    typeof call.error === "string"
      ? { code: "UNKNOWN", message: call.error }
      : call.error;
  if (
    call.status !== "failed" ||
    error?.code !== "TOOL_EXECUTION_FAILED" ||
    !error.message.includes("prepare_data command")
  ) {
    throw new Error(
      `Forged training command was not rejected by the canonical compiler boundary: ${JSON.stringify(call)}.`,
    );
  }

  console.log(
    JSON.stringify({
      status: "ok",
      forgedCommandRejected: true,
      errorCode: error.code,
      approvalIdsDistinct:
        completedInput.planReview.approvalId !==
        completedInput.trainingReview.approvalId,
      processStarted: false,
    }),
  );
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
