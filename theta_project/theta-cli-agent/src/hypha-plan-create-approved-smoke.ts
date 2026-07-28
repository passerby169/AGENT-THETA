import { runApprovedThetaPlanCreate } from "./tools/hypha-runner.js";
import { createPlanningFixture } from "./planning/test-fixture.js";

const result = await runApprovedThetaPlanCreate(createPlanningFixture());

if (result.status !== "completed" || !result.output) {
  throw new Error(
    `approved theta.plan.create did not complete: ${JSON.stringify(result.error ?? result.status)}`,
  );
}

console.log(
  JSON.stringify({
    status: "ok",
    runner: "GovernedToolRunner",
    toolId: result.toolId,
    planId: result.output.planId,
    planVersion: result.output.planVersion,
    datasetSha256: result.output.canonicalPlan.datasetSha256,
  }),
);
