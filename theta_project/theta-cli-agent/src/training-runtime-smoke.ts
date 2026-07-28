import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createApprovalReceipt,
  createDryRunReceipt,
  createTrainingPlanRecord,
} from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";
import type { TrainingStatusOutput } from "./training/contracts.js";
import {
  runApprovedThetaTrainingCancel,
  runApprovedThetaTrainingStart,
  runThetaTrainingStatus,
} from "./tools/hypha-runner.js";
import type { ThetaTrainingStartInput } from "./tools/training-start-tool.js";

const stateRoot = await mkdtemp(
  path.join(os.tmpdir(), "theta-training-runtime-smoke-"),
);
process.env.THETA_AGENT_STATE_DIR = stateRoot;

const completedArtifact = path
  .join(stateRoot, "artifacts", "model.json")
  .replaceAll("\\", "/");
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
  "training-runtime-smoke-completed",
  [
    "from pathlib import Path",
    `target = Path(${JSON.stringify(completedArtifact)})`,
    "target.parent.mkdir(parents=True, exist_ok=True)",
    "target.write_text('{\"status\":\"trained\"}', encoding='utf-8')",
  ].join("; "),
  [
    {
      kind: "model",
      path: completedArtifact,
      description: "Simulated trained model artifact.",
    },
  ],
);

const cancellationInput = createStartInput(
  "training-runtime-smoke-cancelled",
  "import time; time.sleep(30)",
  [],
);

const completedResult = (
  await runApprovedThetaTrainingStart(completedInput, {
    invocationId: "training-runtime-smoke-completed-first",
    idempotencyKey: completedInput.idempotencyKey,
    userId: "runtime.smoke",
  })
).output;
if (!completedResult) throw new Error("Completed smoke run did not start.");

const idempotentResult = (
  await runApprovedThetaTrainingStart(completedInput, {
    invocationId: "training-runtime-smoke-completed-second",
    idempotencyKey: completedInput.idempotencyKey,
    userId: "runtime.smoke",
  })
).output;
if (
  !idempotentResult ||
  idempotentResult.trainingRunId !== completedResult.trainingRunId
) {
  throw new Error("Training start idempotency returned a different run.");
}

const waitForStatus = async (
  trainingRunId: string,
  terminalStatuses: readonly string[],
): Promise<Extract<TrainingStatusOutput, { found: true }>> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await runThetaTrainingStatus(
      { trainingRunId, logLimit: 40 },
      {
        invocationId: `training-runtime-status-${trainingRunId}-${attempt}`,
        userId: "runtime.smoke",
      },
    );
    if (!result.output) throw new Error("Training status returned no output.");
    if (!result.output.found)
      throw new Error(`Training run disappeared: ${trainingRunId}`);
    if (terminalStatuses.includes(result.output.status)) return result.output;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Training run did not become terminal: ${trainingRunId}`);
};

try {
  const completedStatus = await waitForStatus(completedResult.trainingRunId, [
    "completed",
    "failed",
    "quarantined",
  ]);
  if (completedStatus.status !== "completed") {
    throw new Error(
      `Simulated training did not complete: ${JSON.stringify(completedStatus)}`,
    );
  }
  const boundArtifact = completedStatus.receipt.resultArtifacts[0];
  const artifactBytes = await readFile(completedArtifact);
  const expectedHash = createHash("sha256").update(artifactBytes).digest("hex");
  if (
    !boundArtifact ||
    !boundArtifact.exists ||
    boundArtifact.sha256 !== expectedHash
  ) {
    throw new Error("Completed training did not bind the result artifact.");
  }

  const cancellationStart = (
    await runApprovedThetaTrainingStart(cancellationInput, {
      invocationId: "training-runtime-smoke-cancel-start",
      idempotencyKey: cancellationInput.idempotencyKey,
      userId: "runtime.smoke",
    })
  ).output;
  if (!cancellationStart)
    throw new Error("Cancellation smoke run did not start.");

  const cancellation = (
    await runApprovedThetaTrainingCancel(
      {
        trainingRunId: cancellationStart.trainingRunId,
        reason: "Exercise governed cancellation.",
      },
      {
        invocationId: "training-runtime-smoke-cancel",
        idempotencyKey: "training-runtime-smoke-cancel",
        userId: "runtime.smoke",
      },
    )
  ).output;
  if (
    !cancellation ||
    cancellation.cancellation.operator !== "runtime.smoke" ||
    cancellation.cancellation.targetPid === null
  ) {
    throw new Error("Cancellation receipt is missing operator or target PID.");
  }

  const cancelledStatus = await waitForStatus(cancellationStart.trainingRunId, [
    "cancelled",
    "failed",
    "quarantined",
  ]);
  const cancellationReceipt = cancelledStatus.receipt.cancellation;
  if (
    cancelledStatus.status !== "cancelled" ||
    !cancellationReceipt ||
    cancellationReceipt.gracefulResult === "pending" ||
    cancellationReceipt.forcedResult === "pending"
  ) {
    throw new Error(
      `Training cancellation did not settle: ${JSON.stringify(cancelledStatus)}`,
    );
  }

  console.log(
    JSON.stringify({
      status: "ok",
      completedRunId: completedResult.trainingRunId,
      idempotentRunId: idempotentResult.trainingRunId,
      resultSha256: boundArtifact.sha256,
      cancelledRunId: cancellationStart.trainingRunId,
      cancellationId: cancellationReceipt.cancellationId,
      operator: cancellationReceipt.operator,
      lifecycleEvents:
        completedStatus.events.length + cancelledStatus.events.length,
    }),
  );
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
