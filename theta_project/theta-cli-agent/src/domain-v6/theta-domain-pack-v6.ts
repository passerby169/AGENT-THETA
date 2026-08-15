import type { SpecRef } from '@hypha/core';
import {
  compileDomainPackToHarnessedSystem,
  resolveWorkflowToolExecutionScope,
  validateDomainPackSpec,
  type DomainCompilationResult,
  type DomainPackSpec,
  type WorkflowStateSpec,
} from '@hypha/domain';
import type { ToolExecutionScope } from '@hypha/tools';
import { thetaHyphaToolSpecs } from '../tools/hypha-registry.js';
import { THETA_STATE_TOOL_PROFILES } from './tool-scopes.js';
import {
  THETA_CHECKPOINT_KEYS,
  THETA_DOMAIN_PACK_ID,
  THETA_DOMAIN_PACK_VERSION,
  THETA_TERMINAL_STATES,
  THETA_WORKFLOW_ID,
  THETA_WORKFLOW_STATES,
  THETA_WORKFLOW_VERSION,
  type ThetaWorkflowState,
} from './workflow-states.js';
import { THETA_V6_GUARDS } from './workflow-guards.js';

export const THETA_V6_AGENT_REF: SpecRef = { id: 'agent.theta.research-training', version: '3.0.0' };

const toolRef = (id: string): SpecRef => {
  const spec = thetaHyphaToolSpecs.find((candidate) => candidate.id === id);
  return { id, ...(spec?.version === undefined ? {} : { version: spec.version }) };
};

const stateGoals: Record<ThetaWorkflowState, string> = {
  Intake: 'Register the dataset and establish immutable Run identity.',
  DatasetDiscovery: 'Let MiniMax autonomously explore verified dataset facts through governed tools.',
  DatasetCheckpoint: 'Wait for optional conversational confirmation or revision of dataset understanding.',
  ResearchDialogue: 'Let MiniMax develop an open research narrative without predefined intent fields.',
  ResearchCheckpoint: 'Wait for optional conversational confirmation or revision of the research synthesis.',
  PlanDesign: 'Let MiniMax design, ground and validate an executable candidate plan.',
  PlanConfirmation: 'Require explicit owner confirmation of the current candidate plan hash.',
  CreatePlan: 'Create the canonical plan from the approved candidate and receipt.',
  DryRun: 'Perform the governed dry run for the canonical plan.',
  TrainingConfirmation: 'Require an independent approval bound to the dry-run hash.',
  VerifyDataset: 'Reconcile the current dataset hash before training starts.',
  StartTraining: 'Start training using the approved canonical plan.',
  MonitorTraining: 'Monitor the durable training execution.',
  EvaluateResults: 'Read and evaluate verified training artifacts.',
  Completed: 'Complete the THETA research training Run.',
  Recovering: 'Perform bounded reconciliation for a recoverable failure.',
  HumanRecovery: 'Wait for an owner recovery decision.',
  Quarantined: 'Quarantine an execution whose side-effect state is unsafe or unknown.',
  Cancelled: 'Record owner cancellation.',
  Failed: 'Record an unrecoverable failure.',
};

const workflowStates: WorkflowStateSpec[] = Object.values(THETA_WORKFLOW_STATES).map((id) => {
  const profile = THETA_STATE_TOOL_PROFILES[id];
  return {
    id,
    goal: stateGoals[id],
    allowedTools: [...profile.allowedToolIds],
    allowedToolRefs: profile.allowedToolIds.map(toolRef),
    permissionScopes: [...profile.permissionScopes],
    policyRefs: [...profile.policyRefs],
    ...(id === THETA_WORKFLOW_STATES.datasetCheckpoint
      ? { humanReviewRef: THETA_CHECKPOINT_KEYS.dataset }
      : id === THETA_WORKFLOW_STATES.researchCheckpoint
        ? { humanReviewRef: THETA_CHECKPOINT_KEYS.research }
        : id === THETA_WORKFLOW_STATES.planConfirmation
          ? { humanReviewRef: THETA_CHECKPOINT_KEYS.plan }
          : id === THETA_WORKFLOW_STATES.trainingConfirmation
            ? { humanReviewRef: THETA_CHECKPOINT_KEYS.training }
            : {}),
  };
});

const transition = (from: ThetaWorkflowState, to: ThetaWorkflowState, guard?: string) => ({
  from,
  to,
  ...(guard === undefined ? {} : { guard }),
});

const normalTransitions = [
  transition(THETA_WORKFLOW_STATES.intake, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(
    THETA_WORKFLOW_STATES.datasetDiscovery,
    THETA_WORKFLOW_STATES.datasetCheckpoint,
    THETA_V6_GUARDS.datasetReady,
  ),
  transition(
    THETA_WORKFLOW_STATES.datasetDiscovery,
    THETA_WORKFLOW_STATES.researchDialogue,
    THETA_V6_GUARDS.datasetReady,
  ),
  transition(THETA_WORKFLOW_STATES.datasetCheckpoint, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(
    THETA_WORKFLOW_STATES.datasetCheckpoint,
    THETA_WORKFLOW_STATES.researchDialogue,
    THETA_V6_GUARDS.datasetCheckpointResolved,
  ),
  transition(
    THETA_WORKFLOW_STATES.researchDialogue,
    THETA_WORKFLOW_STATES.researchCheckpoint,
    THETA_V6_GUARDS.researchReady,
  ),
  transition(
    THETA_WORKFLOW_STATES.researchDialogue,
    THETA_WORKFLOW_STATES.planDesign,
    THETA_V6_GUARDS.researchReady,
  ),
  transition(THETA_WORKFLOW_STATES.researchCheckpoint, THETA_WORKFLOW_STATES.researchDialogue),
  transition(
    THETA_WORKFLOW_STATES.researchCheckpoint,
    THETA_WORKFLOW_STATES.planDesign,
    THETA_V6_GUARDS.researchCheckpointResolved,
  ),
  transition(
    THETA_WORKFLOW_STATES.planDesign,
    THETA_WORKFLOW_STATES.planConfirmation,
    THETA_V6_GUARDS.planValid,
  ),
  transition(THETA_WORKFLOW_STATES.planDesign, THETA_WORKFLOW_STATES.researchDialogue),
  transition(THETA_WORKFLOW_STATES.planConfirmation, THETA_WORKFLOW_STATES.planDesign),
  transition(
    THETA_WORKFLOW_STATES.planConfirmation,
    THETA_WORKFLOW_STATES.createPlan,
    THETA_V6_GUARDS.planApproved,
  ),
  transition(
    THETA_WORKFLOW_STATES.createPlan,
    THETA_WORKFLOW_STATES.dryRun,
    THETA_V6_GUARDS.canonicalPlanCreated,
  ),
  transition(THETA_WORKFLOW_STATES.createPlan, THETA_WORKFLOW_STATES.planDesign),
  transition(THETA_WORKFLOW_STATES.createPlan, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(
    THETA_WORKFLOW_STATES.dryRun,
    THETA_WORKFLOW_STATES.trainingConfirmation,
    THETA_V6_GUARDS.dryRunPassed,
  ),
  transition(THETA_WORKFLOW_STATES.dryRun, THETA_WORKFLOW_STATES.planDesign),
  transition(THETA_WORKFLOW_STATES.dryRun, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(THETA_WORKFLOW_STATES.dryRun, THETA_WORKFLOW_STATES.humanRecovery),
  transition(THETA_WORKFLOW_STATES.dryRun, THETA_WORKFLOW_STATES.dryRun),
  transition(THETA_WORKFLOW_STATES.trainingConfirmation, THETA_WORKFLOW_STATES.planDesign),
  transition(
    THETA_WORKFLOW_STATES.trainingConfirmation,
    THETA_WORKFLOW_STATES.verifyDataset,
    THETA_V6_GUARDS.trainingApproved,
  ),
  transition(THETA_WORKFLOW_STATES.verifyDataset, THETA_WORKFLOW_STATES.startTraining, THETA_V6_GUARDS.datasetVerified),
  transition(THETA_WORKFLOW_STATES.verifyDataset, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(THETA_WORKFLOW_STATES.startTraining, THETA_WORKFLOW_STATES.monitorTraining, THETA_V6_GUARDS.trainingStarted),
  transition(THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.monitorTraining),
  transition(THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.evaluateResults, THETA_V6_GUARDS.artifactsVerified),
  transition(THETA_WORKFLOW_STATES.monitorTraining, THETA_WORKFLOW_STATES.humanRecovery),
  transition(THETA_WORKFLOW_STATES.evaluateResults, THETA_WORKFLOW_STATES.completed, THETA_V6_GUARDS.resultsEvaluated),
  transition(THETA_WORKFLOW_STATES.recovering, THETA_WORKFLOW_STATES.humanRecovery),
  transition(THETA_WORKFLOW_STATES.humanRecovery, THETA_WORKFLOW_STATES.datasetDiscovery),
  transition(THETA_WORKFLOW_STATES.humanRecovery, THETA_WORKFLOW_STATES.researchDialogue),
  transition(THETA_WORKFLOW_STATES.humanRecovery, THETA_WORKFLOW_STATES.planDesign),
];

const recoveryTransitions = Object.values(THETA_WORKFLOW_STATES)
  .filter((state) => !THETA_TERMINAL_STATES.includes(state) && state !== THETA_WORKFLOW_STATES.recovering)
  .flatMap((from) => [
    transition(from, THETA_WORKFLOW_STATES.recovering),
    transition(from, THETA_WORKFLOW_STATES.cancelled),
    transition(from, THETA_WORKFLOW_STATES.failed),
    transition(from, THETA_WORKFLOW_STATES.quarantined),
  ]);

const readonlyPolicy = {
  id: 'policy.theta.v6.readonly',
  version: '1.0.0',
  defaultEffect: 'deny' as const,
  rules: [{ id: 'allow-read', version: '1.0.0', effect: 'allow' as const, sideEffectLevels: ['none', 'read'] as const }],
};

const stateWritePolicy = {
  id: 'policy.theta.v6.state-write',
  version: '1.0.0',
  defaultEffect: 'deny' as const,
  rules: [{ id: 'allow-plan-write', version: '1.0.0', effect: 'allow' as const, sideEffectLevels: ['write'] as const }],
};

const trainingPolicy = {
  id: 'policy.theta.v6.training-control',
  version: '1.0.0',
  defaultEffect: 'deny' as const,
  rules: [{ id: 'allow-approved-training', version: '1.0.0', effect: 'allow' as const, sideEffectLevels: ['external_effect'] as const }],
};

export const thetaTrainingDomainPackV6: DomainPackSpec = validateDomainPackSpec({
  id: THETA_DOMAIN_PACK_ID,
  version: THETA_DOMAIN_PACK_VERSION,
  name: 'THETA LLM-led research training domain',
  description: 'Hypha-governed THETA workflow where MiniMax leads research decisions and FSM guards legality.',
  taskSchemas: [
    {
      id: 'task.theta.training.v6',
      version: '1.0.0',
      taskType: 'theta_research_training',
      inputSchema: {
        type: 'object',
        required: ['datasetRef'],
        properties: {
          datasetRef: { type: 'string', minLength: 1 },
          initialMessage: { type: 'string' },
          allowRemoteSamples: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      outputContractRef: 'output.theta.training.v6',
      defaultWorkflowRef: THETA_WORKFLOW_ID,
    },
  ],
  outputContracts: [
    {
      id: 'output.theta.training.v6',
      version: '1.0.0',
      schema: {
        type: 'object',
        required: ['runId', 'status'],
        properties: { runId: { type: 'string' }, status: { type: 'string' } },
        additionalProperties: true,
      },
    },
  ],
  sessionProfiles: [
    {
      id: 'session.theta.local.v6',
      version: '1.0.0',
      defaultMetadata: { runtimeMode: 'single-user', agentContract: '3.0.0' },
      defaultPolicyRefs: [readonlyPolicy.id, stateWritePolicy.id, trainingPolicy.id],
    },
  ],
  memoryProfiles: [
    {
      id: 'theta-native-default',
      version: '1.0.0',
      description: 'Hypha Native Memory with MongoDB durable records, Redis working state, governed context and asynchronous indexing.',
      providers: [{ id: 'theta-hypha-native', type: 'hybrid', providerRef: 'memory.provider.theta-native' }],
      memoryTypes: ['working', 'episodic', 'semantic', 'artifact'],
      structuredStoreRef: 'memory.store.record.mongodb',
      vectorIndexRef: 'memory.vector.local',
      artifactStoreRef: 'memory.artifact.local',
      embeddingProviderRef: 'memory.embedding.local',
      provenancePolicy: 'required',
      retrievalStrategy: 'hybrid-scope-first',
      retrievalPolicy: { defaultTopK: 12, requireScope: true, allowedTypes: ['working', 'episodic', 'semantic', 'artifact'] },
      writePolicyConfig: { allowLongTerm: true, requireProvenance: true },
    },
  ],
  contextProfiles: [
    {
      id: 'context.theta.reality.v1',
      version: '1.0.0',
      sources: [
        { id: 'context.theta.system', version: '1.0.0', type: 'system', provenanceRequired: true, trustLevel: 'trusted' },
        { id: 'context.theta.user', version: '1.0.0', type: 'user_input', provenanceRequired: true, trustLevel: 'untrusted' },
        { id: 'context.theta.memory', version: '1.0.0', type: 'memory', provenanceRequired: true, trustLevel: 'reviewed' },
        { id: 'context.theta.domain', version: '1.0.0', type: 'domain', provenanceRequired: true, trustLevel: 'trusted' },
      ],
      tokenBudget: 32_000,
      provenancePolicy: 'required',
      instructionBoundaryPolicy: 'strict',
    },
  ],
  workflows: [
    {
      id: THETA_WORKFLOW_ID,
      version: THETA_WORKFLOW_VERSION,
      initialState: THETA_WORKFLOW_STATES.intake,
      terminalStates: [...THETA_TERMINAL_STATES],
      states: workflowStates,
      transitions: [...normalTransitions, ...recoveryTransitions],
    },
  ],
  defaultWorkflow: THETA_WORKFLOW_ID,
  tools: [...thetaHyphaToolSpecs],
  policies: [readonlyPolicy, stateWritePolicy, trainingPolicy],
  deploymentProfile: {
    id: 'deployment.theta.local.v6',
    version: '1.0.0',
    mode: 'local',
    runtimeMode: 'single-user',
  },
});

export const compileThetaTrainingDomain = (): DomainCompilationResult =>
  compileDomainPackToHarnessedSystem(thetaTrainingDomainPackV6, {
    agentRef: THETA_V6_AGENT_REF,
    taskSchemaId: 'task.theta.training.v6',
    workflowId: THETA_WORKFLOW_ID,
    sessionProfileId: 'session.theta.local.v6',
    memoryProfileId: 'theta-native-default',
    contextProfileId: 'context.theta.reality.v1',
    metadata: { owner: 'theta-cli-agent', architecture: 'business-fsm-plus-react-quantum' },
  });

export const resolveThetaStateToolScope = (
  compilation: DomainCompilationResult,
  stateId: string,
): ToolExecutionScope =>
  resolveWorkflowToolExecutionScope(compilation.bindings.workflowStates, stateId);
