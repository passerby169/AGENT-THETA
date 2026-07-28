import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  EventCreateInput,
  FrameworkEvent,
  PersistedFrameworkEvent,
  RuntimeJsonValue,
  RuntimeOrchestrationProjection,
  RuntimeScope,
} from '@hypha/core';
import type {
  BoundedFSMDriverResult,
  BoundedStateExecutionDecision,
  BoundedStateExecutorInput,
} from '@hypha/harness';
import type { ToolCallResult } from '@hypha/tools';
import {
  THETA_APPROVAL_KEYS,
  THETA_WORKFLOW_STATES,
  compileThetaTrainingDomain,
  resolveThetaStateToolScope,
} from './theta-domain.js';
import {
  JsonlToolTraceRecorder,
  createThetaWorkflowRuntime,
  defaultThetaWorkflowDb,
  thetaToolTraceFile,
} from './theta-workflow-runtime.js';
import {
  createThetaGovernedToolRunner,
  createThetaToolCallContext,
} from './tools/hypha-runner.js';
import type { ThetaTrainingPlan } from './tools/plan-validate-tool.js';
import { THETA_TOOL_IDS } from './tools/tool-ids.js';

const USER_ID = 'local_user';
const WORKSPACE_ID = 'local_workspace';
const AGENT_ID = 'agent.theta.cli';
const DRIVER_OWNER = 'theta-cli-workflow-driver';
const LEASE_TTL_MS = 60_000;
const STATE_CLAIM_TTL_MS = 30_000;
const MAX_STEPS = 64;

export interface ThetaWorkflowInput {
  filePath: string;
  datasetId?: string;
  researchGoal?: string;
  constraints?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  sampleSize?: number;
}

export interface ThetaWorkflowRunRequest {
  input: ThetaWorkflowInput;
  runId?: string;
  runtimeDb?: string;
  approvalKeys?: readonly string[];
  approvedBy?: string;
}

export interface ThetaWorkflowResumeRequest {
  runId: string;
  runtimeDb?: string;
  approve?: boolean;
  reject?: boolean;
  approvedBy?: string;
  approvalKeys?: readonly string[];
}

export interface ThetaWorkflowToolRequest {
  toolId: string;
  input: Record<string, unknown>;
  runId: string;
  sessionId: string;
  stateId: string;
  stateAttempt: number;
  approvedBy?: string;
}

export interface ThetaWorkflowToolPort {
  invoke(request: ThetaWorkflowToolRequest): Promise<Record<string, unknown>>;
  listTrace(runId: string): Promise<FrameworkEvent[]>;
}

export interface ThetaWorkflowRunResult {
  runId: string;
  runtimeDb: string;
  disposition: BoundedFSMDriverResult['disposition'];
  status: RuntimeOrchestrationProjection['runStatus'];
  currentState?: string;
  pendingActionRef?: string;
  statePath: string[];
  output?: RuntimeJsonValue;
}

export interface ThetaWorkflowEvidence {
  runId: string;
  runtimeDb: string;
  orchestrationEvents: PersistedFrameworkEvent[];
  toolEvents: FrameworkEvent[];
}

export interface ThetaWorkflowReplay {
  runId: string;
  eventTypes: string[];
  statePath: string[];
  toolCalls: string[];
  policyDecisions: string[];
  output?: RuntimeJsonValue;
  digest: string;
}

export interface ThetaWorkflowServiceOptions {
  toolPort?: ThetaWorkflowToolPort;
  now?: () => string;
}

class GovernedThetaWorkflowToolPort implements ThetaWorkflowToolPort {
  private readonly runner;

  constructor(private readonly trace: JsonlToolTraceRecorder) {
    this.runner = createThetaGovernedToolRunner(trace);
  }

  async invoke(
    request: ThetaWorkflowToolRequest,
  ): Promise<Record<string, unknown>> {
    const compilation = compileThetaTrainingDomain();
    const executionScope = resolveThetaStateToolScope(
      compilation,
      request.stateId,
    );
    const binding = compilation.bindings.workflowStates.find(
      (candidate) => candidate.stateId === request.stateId,
    );
    const invocationId = invocationKey(request);
    const context = {
      ...createThetaToolCallContext(request.runId, request.stateId, {
        invocationId,
        idempotencyKey: invocationId,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        permissionScopes: binding?.permissionScopes ?? [],
      }),
      sessionId: request.sessionId,
      agentId: AGENT_ID,
      fsmState: request.stateId,
      executionScope,
      operationId: `theta-workflow:${request.stateId}:${request.stateAttempt}`,
      correlationId: request.runId,
    };
    let result = await this.runner.run({
      toolId: request.toolId,
      input: request.input,
      context,
    });
    if (result.status === 'human_review_required' && request.approvedBy) {
      result = await this.runner.approveAndResume(
        invocationId,
        request.approvedBy,
      );
    }
    return completedOutput(request.toolId, result);
  }

  listTrace(runId: string): Promise<FrameworkEvent[]> {
    return this.trace.list({ runId });
  }
}

export class ThetaWorkflowService {
  private readonly now: () => string;

  constructor(private readonly options: ThetaWorkflowServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  compileSummary(): Record<string, unknown> {
    const compilation = compileThetaTrainingDomain();
    return {
      domainPack: `${compilation.domainPack.id}@${compilation.domainPack.version}`,
      workflow: `${compilation.workflowRef.id}@${compilation.workflowRef.version}`,
      processHash: compilation.processHash,
      compilationHash: compilation.audit.compilationHash,
      initialState: compilation.fsmProcess.initialState,
      terminalStates: compilation.fsmProcess.terminalStates,
      stateCount: compilation.fsmProcess.states.length,
      toolRefs: compilation.dependencySnapshot.toolRefs.map((ref) => ref.id),
    };
  }

  async run(request: ThetaWorkflowRunRequest): Promise<ThetaWorkflowRunResult> {
    validateInput(request.input);
    const runId = request.runId?.trim() || `theta-run-${randomUUID()}`;
    const runtimeDb = path.resolve(
      request.runtimeDb ?? defaultThetaWorkflowDb(),
    );
    const scope = runtimeScope(runId);
    const runtime = await createThetaWorkflowRuntime({ filename: runtimeDb });
    try {
      await seedRun(runtime.events, scope, request.input, this.now());
      return await this.drive(
        runtime,
        scope,
        this.toolPort(runtimeDb, runId),
        request.approvalKeys ?? [],
        request.approvedBy ?? USER_ID,
      );
    } finally {
      runtime.close();
    }
  }

  async resume(
    request: ThetaWorkflowResumeRequest,
  ): Promise<ThetaWorkflowRunResult> {
    const runId = required(request.runId, 'runId');
    const runtimeDb = path.resolve(
      request.runtimeDb ?? defaultThetaWorkflowDb(),
    );
    const scope = runtimeScope(runId);
    const runtime = await createThetaWorkflowRuntime({ filename: runtimeDb });
    try {
      await runtime.timers.sweep({
        ownerId: `${DRIVER_OWNER}:timer`,
        leaseTtlMs: LEASE_TTL_MS,
        limit: 100,
        firedAt: this.now(),
      });
      const tools = this.toolPort(runtimeDb, runId);
      let result = await this.runDriver(runtime, scope, tools);
      if (
        result.disposition === 'waiting' &&
        result.projection.pendingWait?.type === 'human' &&
        (request.approve || request.reject)
      ) {
        await this.resolveHumanWait(
          runtime,
          scope,
          result.projection,
          request.reject ? 'rejected' : 'approved',
          request.approvedBy ?? USER_ID,
        );
        result = await this.runDriver(runtime, scope, tools);
      }
      result = await this.autoApprove(
        runtime,
        scope,
        tools,
        result,
        new Set(request.approvalKeys ?? []),
        request.approvedBy ?? USER_ID,
      );
      return toRunResult(
        runId,
        runtimeDb,
        result,
        await terminalOutput(runtime, scope),
      );
    } finally {
      runtime.close();
    }
  }

  async evidence(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowEvidence> {
    const resolvedRunId = required(runId, 'runId');
    const resolvedDb = path.resolve(runtimeDb);
    const runtime = await createThetaWorkflowRuntime({ filename: resolvedDb });
    try {
      const orchestrationEvents = await runtime.events.read({
        scope: streamScope(runtimeScope(resolvedRunId)),
      });
      return {
        runId: resolvedRunId,
        runtimeDb: resolvedDb,
        orchestrationEvents,
        toolEvents: await this.toolPort(resolvedDb, resolvedRunId).listTrace(
          resolvedRunId,
        ),
      };
    } finally {
      runtime.close();
    }
  }

  async replay(
    runId: string,
    runtimeDb = defaultThetaWorkflowDb(),
  ): Promise<ThetaWorkflowReplay> {
    const evidence = await this.evidence(runId, runtimeDb);
    const statePath = evidence.orchestrationEvents
      .filter((event) => event.type === 'fsm.state.entered')
      .map((event) => stringProperty(event.payload, 'stateId'))
      .filter((value): value is string => value !== undefined);
    const toolCalls = unique(
      evidence.toolEvents
        .filter((event) => event.type === 'tool.call.completed')
        .map((event) => stringProperty(event.payload, 'toolId'))
        .filter((value): value is string => value !== undefined),
    );
    const policyDecisions = evidence.toolEvents
      .filter((event) => event.type === 'tool.policy.checked')
      .map((event) => {
        const decision = recordProperty(event.payload, 'decision');
        return (
          stringValue(decision?.ruleId) ??
          stringProperty(event.payload, 'ruleId') ??
          event.id
        );
      });
    const terminal = [...evidence.orchestrationEvents]
      .reverse()
      .find((event) => event.type === 'run.completed');
    const output = recordProperty(terminal?.payload, 'output') as
      | RuntimeJsonValue
      | undefined;
    const fixture = {
      runId: evidence.runId,
      eventTypes: evidence.orchestrationEvents.map((event) => event.type),
      statePath,
      toolCalls,
      policyDecisions,
      ...(output === undefined ? {} : { output }),
    };
    return {
      ...fixture,
      digest: createHash('sha256').update(canonicalJson(fixture)).digest('hex'),
    };
  }

  private toolPort(runtimeDb: string, runId: string): ThetaWorkflowToolPort {
    return (
      this.options.toolPort ??
      new GovernedThetaWorkflowToolPort(
        new JsonlToolTraceRecorder(thetaToolTraceFile(runtimeDb, runId)),
      )
    );
  }

  private async drive(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
    approvalKeys: readonly string[],
    approvedBy: string,
  ): Promise<ThetaWorkflowRunResult> {
    let result = await this.runDriver(runtime, scope, tools);
    result = await this.autoApprove(
      runtime,
      scope,
      tools,
      result,
      new Set(approvalKeys),
      approvedBy,
    );
    return toRunResult(
      scope.runId,
      runtime.filename,
      result,
      await terminalOutput(runtime, scope),
    );
  }

  private async autoApprove(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
    initial: BoundedFSMDriverResult,
    approvals: ReadonlySet<string>,
    approvedBy: string,
  ): Promise<BoundedFSMDriverResult> {
    let result = initial;
    for (let count = 0; count < 3; count += 1) {
      const pending = result.projection.pendingWait;
      if (
        result.disposition !== 'waiting' ||
        pending?.type !== 'human' ||
        !pending.pendingActionRef ||
        !approvals.has(pending.pendingActionRef)
      ) {
        return result;
      }
      await this.resolveHumanWait(
        runtime,
        scope,
        result.projection,
        'approved',
        approvedBy,
      );
      result = await this.runDriver(runtime, scope, tools);
    }
    return result;
  }

  private async resolveHumanWait(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    projection: RuntimeOrchestrationProjection,
    decision: 'approved' | 'rejected',
    principalId: string,
  ): Promise<void> {
    const pending = projection.pendingWait;
    if (pending?.type !== 'human' || !pending.pendingActionRef) {
      throw new Error(
        'THETA workflow is not waiting for a resolvable human action.',
      );
    }
    await runtime.humanWaits.resolve({
      commandId: `theta-human-${pending.waitId}-${decision}`,
      scope,
      ownerId: `${DRIVER_OWNER}:human`,
      leaseTtlMs: LEASE_TTL_MS,
      waitId: pending.waitId,
      pendingActionRef: pending.pendingActionRef,
      principalId,
      decision,
      resolvedAt: this.now(),
      idempotencyKey: `theta-human-${pending.waitId}-${decision}`,
    });
  }

  private runDriver(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    tools: ThetaWorkflowToolPort,
  ): Promise<BoundedFSMDriverResult> {
    const compilation = compileThetaTrainingDomain();
    const driver = runtime.createDriver((input) =>
      executeThetaState(input, runtime.events, tools),
    );
    return driver.run({
      scope,
      process: compilation.fsmProcess,
      ownerId: DRIVER_OWNER,
      maxSteps: MAX_STEPS,
      leaseTtlMs: LEASE_TTL_MS,
      stateClaimTtlMs: STATE_CLAIM_TTL_MS,
    });
  }
}

const executeThetaState = async (
  execution: BoundedStateExecutorInput,
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>['events'],
  tools: ThetaWorkflowToolPort,
): Promise<BoundedStateExecutionDecision> => {
  const variables = await hydrateVariables(events, execution.scope);
  const invoke = (
    toolId: string,
    input: Record<string, unknown>,
    approvedBy?: string,
  ) =>
    tools.invoke({
      toolId,
      input,
      runId: execution.scope.runId,
      sessionId: execution.scope.sessionId,
      stateId: execution.state.id,
      stateAttempt: execution.projection.stateAttempt,
      approvedBy,
    });
  try {
    switch (execution.state.id) {
      case THETA_WORKFLOW_STATES.intake:
        validateInput(
          requireRecord(
            variables.input,
            'workflow input',
          ) as unknown as ThetaWorkflowInput,
        );
        return transition(THETA_WORKFLOW_STATES.inspectDataset);
      case THETA_WORKFLOW_STATES.inspectDataset: {
        const input = requireRecord(variables.input, 'workflow input');
        const toolInput = {
          filePath: requiredString(input.filePath, 'input.filePath'),
          ...(numberValue(input.sampleSize) === undefined
            ? {}
            : { sampleSize: numberValue(input.sampleSize) }),
        };
        const [inspection, columns] = await Promise.all([
          invoke(THETA_TOOL_IDS.datasetInspect, toolInput),
          invoke(THETA_TOOL_IDS.datasetDetectColumns, toolInput),
        ]);
        return transition(THETA_WORKFLOW_STATES.recommendModel, {
          datasetProfile: sanitizeDatasetProfile(inspection, columns),
        });
      }
      case THETA_WORKFLOW_STATES.recommendModel: {
        const input = requireRecord(variables.input, 'workflow input');
        const datasetProfile = requireRecord(
          variables.datasetProfile,
          'dataset profile',
        );
        const [catalog, recommendation] = await Promise.all([
          invoke(THETA_TOOL_IDS.modelCatalog, {}),
          invoke(THETA_TOOL_IDS.modelRecommend, {
            dataProfile: datasetProfile,
            ...(stringValue(input.researchGoal)
              ? { researchGoal: input.researchGoal }
              : {}),
            ...(isRecord(input.constraints)
              ? { constraints: input.constraints }
              : {}),
          }),
        ]);
        return transition(THETA_WORKFLOW_STATES.validatePlan, {
          modelCatalog: sanitizeCatalog(catalog),
          recommendation: sanitizeRecommendation(recommendation),
          candidatePlan: candidatePlan(input, datasetProfile, recommendation),
        });
      }
      case THETA_WORKFLOW_STATES.validatePlan: {
        const candidate = requireRecord(
          variables.candidatePlan,
          'candidate plan',
        );
        const validation = await invoke(THETA_TOOL_IDS.planValidate, {
          plan: candidate,
          dataProfile: requireRecord(
            variables.datasetProfile,
            'dataset profile',
          ),
        });
        if (validation.valid !== true) {
          return failed(
            'RUNTIME_INVARIANT_FAILED',
            `Candidate plan is invalid: ${stringArray(validation.errors).join('; ')}`,
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.awaitPlanCreationApproval, {
          validatedPlan: requireRecord(
            validation.normalizedPlan,
            'normalized plan',
          ),
          validation: {
            valid: true,
            warnings: stringArray(validation.warnings),
            catalogSource: stringValue(validation.catalogSource) ?? 'unknown',
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitPlanCreationApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.planCreate,
          THETA_WORKFLOW_STATES.createPlan,
        );
      case THETA_WORKFLOW_STATES.createPlan: {
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.planCreate,
        );
        const created = await invoke(
          THETA_TOOL_IDS.planCreate,
          {
            plan: requireRecord(variables.validatedPlan, 'validated plan'),
            rationale: 'Created by the approved THETA event-first workflow.',
            dataProfile: requireRecord(
              variables.datasetProfile,
              'dataset profile',
            ),
          },
          approvedBy,
        );
        return transition(THETA_WORKFLOW_STATES.awaitPlanApproval, {
          planRecord: {
            planId: requiredString(created.planId, 'created planId'),
            planHash: requiredString(created.planHash, 'created planHash'),
            normalizedPlan: requireRecord(
              created.normalizedPlan,
              'created normalizedPlan',
            ),
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitPlanApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.planApprove,
          THETA_WORKFLOW_STATES.approvePlan,
        );
      case THETA_WORKFLOW_STATES.approvePlan: {
        const plan = requireRecord(variables.planRecord, 'plan record');
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.planApprove,
        );
        const approval = await invoke(
          THETA_TOOL_IDS.planApprove,
          {
            planId: requiredString(plan.planId, 'planId'),
            planHash: requiredString(plan.planHash, 'planHash'),
            approvedBy,
            approvalNote: 'Approved through the THETA runtime human wait.',
          },
          approvedBy,
        );
        return transition(THETA_WORKFLOW_STATES.dryRun, {
          planApproval: {
            approvalId: requiredString(approval.approvalId, 'approvalId'),
            approvedBy,
            approvedAt:
              stringValue(approval.approvedAt) ?? new Date().toISOString(),
          },
        });
      }
      case THETA_WORKFLOW_STATES.dryRun: {
        const plan = requireRecord(variables.planRecord, 'plan record');
        const preview = await invoke(THETA_TOOL_IDS.trainingDryRun, {
          planId: requiredString(plan.planId, 'planId'),
          planHash: requiredString(plan.planHash, 'planHash'),
        });
        if (preview.valid !== true || preview.approved !== true) {
          return failed(
            'RUNTIME_INVARIANT_FAILED',
            'Training dry run did not confirm a valid approved plan.',
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.awaitTrainingStartApproval, {
          dryRunSummary: {
            commandCount: arrayValue(preview.commands).length,
            expectedArtifacts: arrayValue(preview.expectedArtifacts).map(
              sanitizeArtifact,
            ),
            notes: stringArray(preview.notes),
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitTrainingStartApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.trainingStart,
          THETA_WORKFLOW_STATES.startTraining,
        );
      case THETA_WORKFLOW_STATES.startTraining: {
        const plan = requireRecord(variables.planRecord, 'plan record');
        const approval = requireRecord(variables.planApproval, 'plan approval');
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.trainingStart,
        );
        const started = await invoke(
          THETA_TOOL_IDS.trainingStart,
          {
            planId: requiredString(plan.planId, 'planId'),
            planHash: requiredString(plan.planHash, 'planHash'),
            approvalId: requiredString(approval.approvalId, 'approvalId'),
            idempotencyKey: `theta-workflow-training-${execution.scope.runId}`,
          },
          approvedBy,
        );
        return transition(THETA_WORKFLOW_STATES.monitorTraining, {
          training: {
            trainingRunId: requiredString(
              started.trainingRunId,
              'trainingRunId',
            ),
            status: stringValue(started.status) ?? 'running',
            progress: numberValue(started.progress) ?? 0,
            currentStep: stringValue(started.currentStep) ?? 'starting',
          },
        });
      }
      case THETA_WORKFLOW_STATES.monitorTraining: {
        const training = requireRecord(variables.training, 'training state');
        const status = await invoke(THETA_TOOL_IDS.trainingStatus, {
          trainingRunId: requiredString(
            training.trainingRunId,
            'trainingRunId',
          ),
          logLimit: 20,
        });
        const normalizedStatus = (
          stringValue(status.status) ?? 'unknown'
        ).toLowerCase();
        if (['completed', 'succeeded', 'success'].includes(normalizedStatus)) {
          const plan = requireRecord(variables.planRecord, 'plan record');
          const validatedPlan = requireRecord(
            variables.validatedPlan,
            'validated plan',
          );
          return transition(
            THETA_WORKFLOW_STATES.completed,
            {
              training: sanitizeTrainingStatus(status),
            },
            {
              runId: execution.scope.runId,
              status: normalizedStatus,
              modelId: requiredString(validatedPlan.modelId, 'modelId'),
              planId: requiredString(plan.planId, 'planId'),
              trainingRunId: requiredString(
                status.trainingRunId,
                'trainingRunId',
              ),
              artifacts: arrayValue(status.artifacts).map(sanitizeArtifact),
            },
          );
        }
        if (['failed', 'error'].includes(normalizedStatus)) {
          return failed(
            'RUNTIME_INTERNAL_ERROR',
            `Training run failed in state ${stringValue(status.currentStep) ?? 'unknown'}.`,
            execution.state.id,
          );
        }
        if (normalizedStatus === 'cancelled') {
          return transition(THETA_WORKFLOW_STATES.cancelled, {
            training: sanitizeTrainingStatus(status),
          });
        }
        return {
          result: {
            kind: 'waiting',
            wait: {
              type: 'timer',
              expiresAt: new Date(Date.now() + 1_000).toISOString(),
              reason:
                'Training is still running; poll again after the durable timer fires.',
              metadata: sanitizeTrainingStatus(status) as Record<
                string,
                RuntimeJsonValue
              >,
            },
          },
        };
      }
      default:
        return failed(
          'RUNTIME_STATE_NOT_FOUND',
          `THETA workflow has no executor for state ${execution.state.id}.`,
          execution.state.id,
        );
    }
  } catch (error) {
    return failed(
      'RUNTIME_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      execution.state.id,
    );
  }
};

const approvalDecision = (
  execution: BoundedStateExecutorInput,
  variables: Record<string, unknown>,
  pendingActionRef: string,
  approvedTarget: string,
): BoundedStateExecutionDecision => {
  const payload = isRecord(execution.projection.lastResume?.payload)
    ? execution.projection.lastResume.payload
    : undefined;
  if (payload?.pendingActionRef === pendingActionRef) {
    if (payload.decision === 'rejected') {
      return failed(
        'RUNTIME_CANCELLED',
        `Human rejected ${pendingActionRef}.`,
        execution.state.id,
      );
    }
    if (payload.decision === 'approved') {
      const priorActors = isRecord(variables.approvalActors)
        ? variables.approvalActors
        : {};
      return transition(approvedTarget, {
        approvalActors: {
          ...priorActors,
          [pendingActionRef]:
            execution.projection.lastResume?.principalId ?? USER_ID,
        },
      });
    }
  }
  return {
    result: {
      kind: 'waiting',
      wait: {
        type: 'human',
        pendingActionRef,
        reason: `Explicit owner approval is required for ${pendingActionRef}.`,
        metadata: { stateId: execution.state.id },
      },
    },
  };
};

const transition = (
  to: string,
  variablesPatch?: Record<string, unknown>,
  output?: unknown,
): BoundedStateExecutionDecision => ({
  result: {
    kind: 'completed',
    ...(variablesPatch === undefined
      ? {}
      : { variablesPatch: variablesPatch as Record<string, RuntimeJsonValue> }),
    ...(output === undefined ? {} : { output: output as RuntimeJsonValue }),
  },
  transition: { to },
});

const failed = (
  code:
    | 'RUNTIME_INVARIANT_FAILED'
    | 'RUNTIME_INTERNAL_ERROR'
    | 'RUNTIME_STATE_NOT_FOUND'
    | 'RUNTIME_CANCELLED',
  message: string,
  stateId: string,
): BoundedStateExecutionDecision => ({
  result: {
    kind: 'failed',
    error: { code, message, retryable: false, stateId },
  },
});

const seedRun = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>['events'],
  scope: RuntimeScope,
  input: ThetaWorkflowInput,
  timestamp: string,
): Promise<void> => {
  const existing = await events.getStreamHead(streamScope(scope));
  if (existing) return;
  const event = (
    id: string,
    type: EventCreateInput['type'],
    payload: Record<string, unknown>,
  ): EventCreateInput => ({
    id,
    type,
    version: '1.0.0',
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    runId: scope.runId,
    agentId: scope.agentId,
    correlationId: scope.runId,
    timestamp,
    payload,
  });
  await events.append({
    scope: streamScope(scope),
    events: [
      event(`${scope.runId}:created`, 'run.created', { runId: scope.runId }),
      event(`${scope.runId}:started`, 'run.started', {
        runId: scope.runId,
        input,
      }),
    ],
    expectedLastSequence: 0,
    idempotencyKey: `theta-workflow-seed:${scope.runId}`,
  });
};

const hydrateVariables = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>['events'],
  scope: RuntimeScope,
): Promise<Record<string, unknown>> => {
  const stream = await events.read({ scope: streamScope(scope) });
  const variables: Record<string, unknown> = {};
  for (const event of stream) {
    if (event.type === 'run.started') {
      const input = recordProperty(event.payload, 'input');
      if (input) variables.input = input;
    }
    if (event.type === 'fsm.transition.accepted') {
      const patch = recordProperty(event.payload, 'variablesPatch');
      if (patch) Object.assign(variables, patch);
    }
  }
  return variables;
};

const sanitizeDatasetProfile = (
  inspection: Record<string, unknown>,
  columns: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  fileName: stringValue(inspection.fileName) ?? 'unknown',
  suffix: stringValue(inspection.suffix) ?? '',
  supported: inspection.supported === true,
  rowCount: numberValue(inspection.rowCount) ?? 0,
  sampleRowCount: numberValue(inspection.sampleRowCount) ?? 0,
  columns: stringArray(inspection.columns),
  columnProfiles: arrayValue(inspection.columnProfiles).map((value) => {
    const profile = isRecord(value) ? value : {};
    return {
      name: stringValue(profile.name) ?? '',
      nonEmptySampleCount: numberValue(profile.nonEmptySampleCount) ?? 0,
      missingSampleCount: numberValue(profile.missingSampleCount) ?? 0,
      missingSampleRatio: numberValue(profile.missingSampleRatio) ?? 0,
      uniqueSampleCount: numberValue(profile.uniqueSampleCount) ?? 0,
      avgLength: numberValue(profile.avgLength) ?? 0,
      maxLength: numberValue(profile.maxLength) ?? 0,
      inferredType: stringValue(profile.inferredType) ?? 'string',
      estimatedTotalRows: numberValue(profile.estimatedTotalRows) ?? 0,
    };
  }),
  textColumnCandidates: sanitizeCandidates(inspection.textColumnCandidates),
  detectedColumns: {
    ...(stringValue(columns.recommendedTextColumn) === undefined
      ? {}
      : { recommendedTextColumn: stringValue(columns.recommendedTextColumn) }),
    textColumns: sanitizeCandidates(columns.textColumns),
    timeColumns: sanitizeCandidates(columns.timeColumns),
    metadataColumns: sanitizeCandidates(columns.metadataColumns),
    warnings: stringArray(columns.warnings),
  },
});

const sanitizeCandidates = (value: unknown): RuntimeJsonValue[] =>
  arrayValue(value).map((candidate) => {
    const item = isRecord(candidate) ? candidate : {};
    return {
      name: stringValue(item.name) ?? '',
      score: numberValue(item.score) ?? 0,
      reason: stringValue(item.reason) ?? '',
    };
  });

const sanitizeCatalog = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  source: stringValue(value.source) ?? 'unknown',
  supportedModelIds: stringArray(value.supportedModelIds),
});

const sanitizeRecommendation = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  deterministic: value.deterministic === true,
  catalogSource: stringValue(value.catalogSource) ?? 'unknown',
  recommendations: arrayValue(value.recommendations) as RuntimeJsonValue[],
  warnings: stringArray(value.warnings),
  constraintsApplied: (isRecord(value.constraintsApplied)
    ? value.constraintsApplied
    : {}) as Record<string, RuntimeJsonValue>,
});

const candidatePlan = (
  input: Record<string, unknown>,
  datasetProfile: Record<string, unknown>,
  recommendation: Record<string, unknown>,
): ThetaTrainingPlan => {
  if (isRecord(input.plan)) return input.plan as ThetaTrainingPlan;
  const top = isRecord(arrayValue(recommendation.recommendations)[0])
    ? (arrayValue(recommendation.recommendations)[0] as Record<string, unknown>)
    : {};
  const patch = isRecord(top.recommendedPlanPatch)
    ? top.recommendedPlanPatch
    : {};
  const detected = isRecord(datasetProfile.detectedColumns)
    ? datasetProfile.detectedColumns
    : {};
  const constraints = isRecord(input.constraints) ? input.constraints : {};
  const fileName = stringValue(datasetProfile.fileName) ?? 'dataset';
  return {
    ...patch,
    datasetId: stringValue(input.datasetId) ?? path.parse(fileName).name,
    modelId:
      stringValue(top.modelId) ?? stringValue(patch.modelId) ?? 'bertopic',
    mode: normalizedMode(patch.mode),
    numTopics:
      numberValue(patch.numTopics) ?? numberValue(constraints.maxTopics) ?? 10,
    ...(stringValue(detected.recommendedTextColumn)
      ? { textColumn: detected.recommendedTextColumn }
      : {}),
  };
};

const normalizedMode = (value: unknown): ThetaTrainingPlan['mode'] => {
  const mode = stringValue(value);
  return mode &&
    ['zero_shot', 'finetune', 'supervised', 'unsupervised'].includes(mode)
    ? (mode as ThetaTrainingPlan['mode'])
    : 'unsupervised';
};

const sanitizeArtifact = (value: unknown): Record<string, RuntimeJsonValue> => {
  const artifact = isRecord(value) ? value : {};
  return {
    kind: stringValue(artifact.kind) ?? 'artifact',
    path: stringValue(artifact.path) ?? '',
    description: stringValue(artifact.description) ?? '',
  };
};

const sanitizeTrainingStatus = (
  status: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  trainingRunId: requiredString(status.trainingRunId, 'trainingRunId'),
  status: stringValue(status.status) ?? 'unknown',
  progress: numberValue(status.progress) ?? 0,
  currentStep: stringValue(status.currentStep) ?? 'unknown',
  artifacts: arrayValue(status.artifacts).map(sanitizeArtifact),
});

const approvalActor = (
  variables: Record<string, unknown>,
  key: string,
): string => {
  const actors = requireRecord(variables.approvalActors, 'approval actors');
  return requiredString(actors[key], `approval actor for ${key}`);
};

const completedOutput = (
  toolId: string,
  result: ToolCallResult,
): Record<string, unknown> => {
  if (result.status !== 'completed' || !isRecord(result.output)) {
    const detail =
      typeof result.error === 'string'
        ? result.error
        : (result.error?.message ?? `status=${result.status}`);
    throw new Error(`Governed tool ${toolId} did not complete: ${detail}`);
  }
  return result.output;
};

const toRunResult = (
  runId: string,
  runtimeDb: string,
  result: BoundedFSMDriverResult,
  output?: RuntimeJsonValue,
): ThetaWorkflowRunResult => ({
  runId,
  runtimeDb,
  disposition: result.disposition,
  status: result.projection.runStatus,
  ...(result.projection.currentState
    ? { currentState: result.projection.currentState }
    : {}),
  ...(result.projection.pendingWait?.pendingActionRef
    ? { pendingActionRef: result.projection.pendingWait.pendingActionRef }
    : {}),
  statePath: result.projection.statePath,
  ...(output === undefined ? {} : { output }),
});

const terminalOutput = async (
  runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
  scope: RuntimeScope,
): Promise<RuntimeJsonValue | undefined> => {
  const terminal = [
    ...(await runtime.events.read({ scope: streamScope(scope) })),
  ]
    .reverse()
    .find((event) => event.type === 'run.completed');
  return recordProperty(terminal?.payload, 'output') as
    | RuntimeJsonValue
    | undefined;
};

const invocationKey = (request: ThetaWorkflowToolRequest): string =>
  createHash('sha256')
    .update(
      `${request.runId}:${request.stateId}:${request.stateAttempt}:${request.toolId}`,
    )
    .digest('hex');

const runtimeScope = (runId: string): RuntimeScope => ({
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: `session:${runId}`,
  runId,
  agentId: AGENT_ID,
});

const streamScope = (scope: RuntimeScope) => ({
  ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
  userId: scope.userId,
  runId: scope.runId,
});

const validateInput = (input: ThetaWorkflowInput): void => {
  if (!input || typeof input !== 'object')
    throw new Error('Workflow input must be an object.');
  required(input.filePath, 'input.filePath');
  if (
    input.sampleSize !== undefined &&
    (!Number.isInteger(input.sampleSize) ||
      input.sampleSize < 1 ||
      input.sampleSize > 1000)
  ) {
    throw new Error('input.sampleSize must be an integer from 1 to 1000.');
  }
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const stringArray = (value: unknown): string[] =>
  arrayValue(value).filter((item): item is string => typeof item === 'string');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const requiredString = (value: unknown, label: string): string => {
  const resolved = stringValue(value);
  if (!resolved) throw new Error(`${label} is required.`);
  return resolved;
};
const required = (value: string, label: string): string =>
  requiredString(value, label);
const recordProperty = (
  value: unknown,
  property: string,
): Record<string, unknown> | undefined => {
  const record = isRecord(value) ? value : undefined;
  return isRecord(record?.[property]) ? record[property] : undefined;
};
const stringProperty = (
  value: unknown,
  property: string,
): string | undefined =>
  isRecord(value) ? stringValue(value[property]) : undefined;
