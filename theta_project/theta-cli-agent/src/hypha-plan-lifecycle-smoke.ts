import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApprovalReceipt } from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";
import {
  runApprovedThetaPlanCreate,
  runThetaTrainingDryRun,
} from "./tools/hypha-runner.js";

const datasetPath = resolve("fixtures/recommendation-sample.jsonl");
const datasetSha256 = createHash("sha256")
  .update(await readFile(datasetPath))
  .digest("hex");
const created = await runApprovedThetaPlanCreate(
  createPlanningFixture(datasetSha256),
  {
    invocationId: "theta-plan-lifecycle-create-v2",
    idempotencyKey: "theta-plan-lifecycle-create-v2",
  },
);
if (created.status !== "completed" || !created.output) {
  throw new Error(
    `plan creation failed: ${JSON.stringify(created.error ?? created.status)}`,
  );
}

const planReview = createApprovalReceipt({
  approvalType: "human_plan_review",
  plan: created.output,
  approvedBy: "lifecycle_smoke",
  approvedAt: "2026-07-28T00:00:01.000Z",
});
const dryRun = await runThetaTrainingDryRun({
  plan: created.output,
  planReview,
  datasetPath,
});
if (dryRun.status !== "completed" || !dryRun.output) {
  throw new Error(
    `training dry run failed: ${JSON.stringify(dryRun.error ?? dryRun.status)}`,
  );
}
if (!dryRun.output.passed || dryRun.output.commands.length !== 2) {
  throw new Error("training dry run did not pass or derive two commands.");
}

console.log(
  JSON.stringify({
    status: "ok",
    runner: "GovernedToolRunner",
    planId: created.output.planId,
    planHash: created.output.planHash,
    approvalId: planReview.approvalId,
    dryRunHash: dryRun.output.dryRunHash,
    passed: dryRun.output.passed,
    commandCount: dryRun.output.commands.length,
    trainingStarted: false,
  }),
);
