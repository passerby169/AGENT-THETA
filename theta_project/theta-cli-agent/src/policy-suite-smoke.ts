import assert from "node:assert/strict";
import { compileThetaTrainingDomain, resolveThetaStateToolScope } from "./theta-domain.js";
import { thetaCliPolicyEngine } from "./tools/hypha-runner.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tools/tool-ids.js";

const evaluate = async (
  capabilityId: string,
  sideEffectLevel: "none" | "read" | "write" | "external_effect" | "irreversible",
) =>
  thetaCliPolicyEngine.evaluate({
    capabilityId,
    sideEffectLevel,
  } as never);

const localRead = await evaluate(THETA_TOOL_IDS.modelCatalog, "read");
assert.equal(localRead.allowed, true);
assert.equal(localRead.requiresHumanReview ?? false, false);
assert.equal(localRead.ruleId, "allow-local-capability");

for (const toolId of [
  THETA_TOOL_IDS.trainingStart,
  THETA_TOOL_IDS.trainingCancel,
  THETA_TOOL_IDS.languageGenerate,
]) {
  const decision = await evaluate(toolId, "external_effect");
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresHumanReview, true);
  assert.equal(decision.ruleId, "allow-approved-external-effect");
}

const unlistedExternal = await evaluate(
  "theta.unlisted.external",
  "external_effect",
);
assert.equal(unlistedExternal.allowed, false);
assert.equal(unlistedExternal.ruleId, "deny-unlisted-external-effects");

const compilation = compileThetaTrainingDomain();
const recommendScope = resolveThetaStateToolScope(
  compilation,
  "RecommendModel",
);
const recommendToolIds = recommendScope.allowedToolIds ?? [];
const recommendBinding = compilation.bindings.workflowStates.find(
  (binding) => binding.stateId === "RecommendModel",
);
assert.ok(recommendToolIds.includes(THETA_TOOL_IDS.ragSearch));
assert.ok(
  (recommendBinding?.permissionScopes ?? []).includes(
    THETA_PERMISSION_SCOPES.ragRead,
  ),
);
assert.equal(
  recommendToolIds.includes(THETA_TOOL_IDS.trainingStart),
  false,
);

const trainingScope = resolveThetaStateToolScope(
  compilation,
  "StartTraining",
);
const trainingBinding = compilation.bindings.workflowStates.find(
  (binding) => binding.stateId === "StartTraining",
);
assert.deepEqual(trainingScope.allowedToolIds ?? [], [
  THETA_TOOL_IDS.trainingStart,
]);
assert.ok(
  (trainingBinding?.permissionScopes ?? []).includes(
    THETA_PERMISSION_SCOPES.trainingWrite,
  ),
);

console.log(
  JSON.stringify({
    status: "ok",
    localReadRule: localRead.ruleId,
    reviewedExternalTools: 3,
    deniedExternalRule: unlistedExternal.ruleId,
    stateScopesChecked: 2,
  }),
);
