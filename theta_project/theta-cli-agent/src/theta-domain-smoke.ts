import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
  compileThetaTrainingDomain,
  resolveThetaStateToolScope,
} from "./theta-domain.js";
import {
  THETA_PERMISSION_SCOPES,
  THETA_TOOL_IDS,
} from "./tools/tool-ids.js";

const first = compileThetaTrainingDomain();
const second = compileThetaTrainingDomain();

if (first.processHash !== second.processHash) {
  throw new Error("THETA Domain compilation is not deterministic.");
}
if (first.audit.compilationHash !== second.audit.compilationHash) {
  throw new Error("THETA Domain compilation audit is not deterministic.");
}
if (!first.fsmProcess.states.some((state) => state.id === "Recovering")) {
  throw new Error("THETA FSM is missing the framework recovery envelope.");
}

const inspectScope = resolveThetaStateToolScope(
  first,
  THETA_WORKFLOW_STATES.inspectDataset,
);
const trainingScope = resolveThetaStateToolScope(
  first,
  THETA_WORKFLOW_STATES.startTraining,
);
const columnScope = resolveThetaStateToolScope(
  first,
  THETA_WORKFLOW_STATES.awaitColumnConfirmation,
);
const researchScope = resolveThetaStateToolScope(
  first,
  THETA_WORKFLOW_STATES.awaitResearchClarification,
);
const recommendationScope = resolveThetaStateToolScope(
  first,
  THETA_WORKFLOW_STATES.recommendModel,
);
const workflowDefinition = first.domainPack.workflows.find(
  (workflow) => workflow.id === first.workflowRef.id,
);
const columnStateDefinition = workflowDefinition?.states.find(
  (state) => state.id === THETA_WORKFLOW_STATES.awaitColumnConfirmation,
);
const researchStateDefinition = workflowDefinition?.states.find(
  (state) => state.id === THETA_WORKFLOW_STATES.awaitResearchClarification,
);

if (!inspectScope.allowedToolIds?.includes(THETA_TOOL_IDS.datasetInspect)) {
  throw new Error("InspectDataset does not allow theta.dataset.inspect.");
}
if (inspectScope.allowedToolIds?.includes(THETA_TOOL_IDS.trainingStart)) {
  throw new Error("InspectDataset improperly allows theta.training.start.");
}
if (
  columnScope.allowedToolIds?.length !== 2 ||
  !columnScope.allowedToolIds.includes(THETA_TOOL_IDS.datasetInspect) ||
  !columnScope.allowedToolIds.includes(THETA_TOOL_IDS.conversationLanguage) ||
  columnScope.allowedToolIds.includes(THETA_TOOL_IDS.trainingStart)
) {
  throw new Error(
    "ColumnConfirmation tool scope exceeds dataset inspection and bounded language interpretation.",
  );
}
if (
  columnStateDefinition?.permissionScopes?.length !== 2 ||
  !columnStateDefinition.permissionScopes.includes(
    THETA_PERMISSION_SCOPES.datasetRead,
  ) ||
  !columnStateDefinition.permissionScopes.includes(
    THETA_PERMISSION_SCOPES.inferenceUse,
  ) ||
  columnScope.policyRefs?.length !== 2 ||
  !columnScope.policyRefs.includes("policy.theta.readonly") ||
  !columnScope.policyRefs.includes("policy.theta.language-inference")
) {
  throw new Error("ColumnConfirmation is missing its least-privilege policy boundary.");
}
if (
  researchScope.allowedToolIds?.length !== 1 ||
  researchScope.allowedToolIds[0] !== THETA_TOOL_IDS.conversationLanguage ||
  researchStateDefinition?.permissionScopes?.length !== 1 ||
  researchStateDefinition.permissionScopes[0] !==
    THETA_PERMISSION_SCOPES.inferenceUse ||
  researchScope.policyRefs?.length !== 1 ||
  researchScope.policyRefs[0] !== "policy.theta.language-inference"
) {
  throw new Error(
    "ResearchClarification may only use policy-bounded language interpretation.",
  );
}
if (
  !recommendationScope.allowedToolIds?.includes(THETA_TOOL_IDS.ragSearch) ||
  !recommendationScope.allowedToolIds.includes(THETA_TOOL_IDS.modelRecommend)
) {
  throw new Error("RecommendModel must retrieve evidence before recommending.");
}
if (recommendationScope.allowedToolIds.includes(THETA_TOOL_IDS.trainingStart)) {
  throw new Error("RecommendModel improperly allows training side effects.");
}
if (
  trainingScope.allowedToolIds?.length !== 1 ||
  trainingScope.allowedToolIds[0] !== THETA_TOOL_IDS.trainingStart
) {
  throw new Error("StartTraining scope is not least privilege.");
}

const workflowStateIds = first.bindings.workflowStates.map(
  (state) => state.stateId,
);
for (const expected of Object.values(THETA_WORKFLOW_STATES)) {
  if (!workflowStateIds.includes(expected)) {
    throw new Error(`Compiled workflow is missing state ${expected}.`);
  }
}

const approvalKeys = Object.values(THETA_APPROVAL_KEYS);
if (new Set(approvalKeys).size !== approvalKeys.length) {
  throw new Error("THETA approval keys must be unique.");
}

console.log(
  JSON.stringify({
    status: "ok",
    domainPack: `${first.domainPack.id}@${first.domainPack.version}`,
    compilerVersion: first.compilerVersion,
    processHash: first.processHash,
    compilationHash: first.audit.compilationHash,
    workflowStates: workflowStateIds.length,
    fsmStates: first.fsmProcess.states.length,
    toolRefs: first.dependencySnapshot.toolRefs.map((ref) => ref.id),
    startTrainingScope: trainingScope,
  }),
);
