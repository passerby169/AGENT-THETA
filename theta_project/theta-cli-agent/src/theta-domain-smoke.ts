import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
  compileThetaTrainingDomain,
  resolveThetaStateToolScope,
} from './theta-domain.js';
import { THETA_TOOL_IDS } from './tools/tool-ids.js';

const first = compileThetaTrainingDomain();
const second = compileThetaTrainingDomain();

if (first.processHash !== second.processHash) {
  throw new Error('THETA Domain compilation is not deterministic.');
}
if (first.audit.compilationHash !== second.audit.compilationHash) {
  throw new Error('THETA Domain compilation audit is not deterministic.');
}
if (!first.fsmProcess.states.some((state) => state.id === 'Recovering')) {
  throw new Error('THETA FSM is missing the framework recovery envelope.');
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

if (!inspectScope.allowedToolIds?.includes(THETA_TOOL_IDS.datasetInspect)) {
  throw new Error('InspectDataset does not allow theta.dataset.inspect.');
}
if (inspectScope.allowedToolIds?.includes(THETA_TOOL_IDS.trainingStart)) {
  throw new Error('InspectDataset improperly allows theta.training.start.');
}
if (
  columnScope.allowedToolIds?.length !== 1 ||
  columnScope.allowedToolIds[0] !== THETA_TOOL_IDS.datasetInspect
) {
  throw new Error('ColumnConfirmation may only re-read dataset identity.');
}
if ((researchScope.allowedToolIds?.length ?? 0) !== 0) {
  throw new Error('ResearchClarification must not execute tools.');
}
if (
  trainingScope.allowedToolIds?.length !== 1 ||
  trainingScope.allowedToolIds[0] !== THETA_TOOL_IDS.trainingStart
) {
  throw new Error('StartTraining scope is not least privilege.');
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
  throw new Error('THETA approval keys must be unique.');
}

console.log(
  JSON.stringify({
    status: 'ok',
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
