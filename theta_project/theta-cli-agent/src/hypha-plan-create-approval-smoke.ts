import { requestThetaPlanCreate } from "./tools/hypha-runner.js";
import { createPlanningFixture } from "./planning/test-fixture.js";

const result = await requestThetaPlanCreate(createPlanningFixture());

if (result.status !== "human_review_required") {
  throw new Error(
    `theta.plan.create should require human review before execution: ${JSON.stringify(result)}`,
  );
}

console.log(
  JSON.stringify({
    status: "ok",
    runner: "GovernedToolRunner",
    toolId: result.toolId,
    gate: "human_review_required",
    errorCode: typeof result.error === "object" ? result.error.code : undefined,
  }),
);
