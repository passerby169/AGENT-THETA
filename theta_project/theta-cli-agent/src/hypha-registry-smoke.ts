import { THETA_TOOL_IDS } from './tools/tool-ids.js';
import { createThetaHyphaToolRegistry } from './tools/hypha-registry.js';

const registry = createThetaHyphaToolRegistry();
const spec = registry.getSpec(THETA_TOOL_IDS.modelCatalog);
const registeredToolIds = registry.list().map((tool) => tool.id).sort();

if (!spec) {
  throw new Error(`${THETA_TOOL_IDS.modelCatalog} was not registered.`);
}

if (
  !registry.getSpec(THETA_TOOL_IDS.modelRecommend) ||
  !registry.getSpec(THETA_TOOL_IDS.planValidate) ||
  !registry.getSpec(THETA_TOOL_IDS.planCreate) ||
  !registry.getSpec(THETA_TOOL_IDS.planApprove) ||
  !registry.getSpec(THETA_TOOL_IDS.trainingDryRun)
) {
  throw new Error('Expected model, plan, and training dry-run tools to be registered.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    registry: 'ToolRegistry',
    toolId: spec.id,
    sideEffectLevel: spec.sideEffectLevel,
    permissionScope: spec.permissionScope,
    registeredToolIds,
  })
);
