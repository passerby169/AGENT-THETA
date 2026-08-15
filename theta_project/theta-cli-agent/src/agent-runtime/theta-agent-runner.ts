import { hashCanonicalJson, type ContinueReActCommandPayloadV1 } from '@hypha/core';
import type {
  InitialReActQuantumDescriptor,
  ReActQuantumDescriptor,
  SessionCommandRecord,
} from '@hypha/core';
import type { InferenceProvider } from '@hypha/inference';
import {
  EventFirstRuntime,
  RunManager,
  type ExecuteReActQuantumResult,
  ReActQuantumExecutor,
  ArtifactReActContextSnapshotStore,
  createContinuationReActQuantumDescriptor,
  type ReActQuantumRuntimeState,
} from '@hypha/harness';
import { ReActRunner, type ReActRunContext } from '@hypha/kernel';
import { LocalFilesystemExecutionArtifactStore } from '@hypha/adapters-local';
import type { ThetaRuntimeComposition } from '../persistence/runtime-composition.js';
import {
  THETA_DOMAIN_PACK_ID,
  THETA_DOMAIN_PACK_VERSION,
  THETA_WORKFLOW_ID,
  THETA_WORKFLOW_VERSION,
} from '../domain-v6/workflow-states.js';
import { ThetaReActAgentRuntime } from './theta-react-runtime.js';
import type { BuiltThetaPhaseContext } from './context-builder.js';
import type { ThetaPhaseBudget } from './contracts.js';
import { ThetaActivityEventRepository } from '../activities/activity-event-store.js';
import { toolActivityCopy } from '../activities/activity-copy.js';

export interface ThetaAgentRunnerOptions {
  composition: ThetaRuntimeComposition;
  inference: InferenceProvider;
  artifactRoot: string;
  quantumIterations?: number;
  now?: () => string;
}

export interface ThetaAgentQuantumRequest {
  runId: string;
  sessionId: string;
  userId: string;
  built: BuiltThetaPhaseContext;
  budget: ThetaPhaseBudget;
  resume?: boolean;
}

export class ThetaAgentRunner {
  private readonly runManager: RunManager;
  private readonly executor: ReActQuantumExecutor;
  private readonly snapshotStore: ArtifactReActContextSnapshotStore;
  private readonly now: () => string;
  private readonly states = new Map<string, ReActQuantumRuntimeState>();

  constructor(private readonly options: ThetaAgentRunnerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.runManager = new RunManager({
      runtime: new EventFirstRuntime(options.composition.eventBridge),
    });
    this.snapshotStore = new ArtifactReActContextSnapshotStore({
      artifacts: new LocalFilesystemExecutionArtifactStore({ rootPath: options.artifactRoot }),
    });
    this.executor = new ReActQuantumExecutor({
      checkpoints: options.composition.reactCheckpoints,
      contextSnapshots: this.snapshotStore,
      runtime: { replay: async (descriptor) => this.runtimeState(descriptor) },
      runnerFactory: {
        create: async ({ snapshot }) => ({
          run: (context, control) => this.createRunner(snapshot.context).run(context, control),
        }),
      },
      outcomeRecorder: {
        record: async ({ descriptor, react, disposition }) => {
          await this.recordOutcome(descriptor, react, disposition);
        },
      },
      quantumIterations: options.quantumIterations ?? 4,
      now: this.now,
    });
  }

  async initializeRun(request: ThetaAgentQuantumRequest): Promise<void> {
    if (await this.runManager.projectRun(request.runId)) return;
    await this.runManager.createSession({
      id: request.sessionId,
      userId: request.userId,
      domainPackRef: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
      timestamp: this.now(),
    });
    const run = await this.runManager.createRun({
      id: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      domainPackRef: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
      workflowRef: { id: THETA_WORKFLOW_ID, version: THETA_WORKFLOW_VERSION },
      agentRef: { id: request.built.context.agent.id, version: request.built.context.agent.version },
      input: { phase: request.built.context.metadata?.phase },
      timestamp: this.now(),
    });
    await this.runManager.startRun(run, this.now());
  }

  async runQuantum(request: ThetaAgentQuantumRequest): Promise<ExecuteReActQuantumResult> {
    // A top-level awaited Promise does not keep a short-lived Node CLI alive by
    // itself. Keep one referenced handle for the complete Hypha quantum so a
    // sequence of model/tool awaits cannot make the process exit mid-phase.
    const processLease = setInterval(() => undefined, 30_000);
    try {
      await this.initializeRun(request);
      const state = this.buildRuntimeState(request);
      this.states.set(stateKey(request.runId, request.built.context.stepId), state);
      if (!request.resume) {
        await this.snapshotStore.put({
          version: '1.0.0',
          runId: request.runId,
          stepId: request.built.context.stepId,
          scopeHash: request.built.scopeHash,
          agentRef: { id: request.built.context.agent.id, version: request.built.context.agent.version },
          context: request.built.context,
          createdAt: this.now(),
        });
      }
      if (request.resume) return this.resumeQuantum(request);
      const descriptor: InitialReActQuantumDescriptor = {
      version: '1.0.0',
      trigger: 'initial',
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      stepId: request.built.context.stepId,
      scopeHash: request.built.scopeHash,
      agentRef: { id: request.built.context.agent.id, version: request.built.context.agent.version },
      domainPackRef: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
      workflowRef: { id: THETA_WORKFLOW_ID, version: THETA_WORKFLOW_VERSION },
      promptSnapshotRef: `prompt:${request.built.promptSnapshotHash}`,
      promptSnapshotHash: request.built.promptSnapshotHash,
      capabilitySnapshotRef: `capability:${request.built.capabilitySnapshotHash}`,
      capabilitySnapshotHash: request.built.capabilitySnapshotHash,
      workspaceRef: String(request.built.context.metadata?.workspaceHash ?? ''),
      globalBudget: {
        iterations: request.budget.maxIterations,
        modelCalls: request.budget.maxModelCalls,
        toolCalls: request.budget.maxToolCalls,
        totalTokens: request.budget.maxTotalTokens,
      },
      cancellationRevision: 0,
      createdAt: this.now(),
      };
      return await this.executor.runOneQuantum({ descriptor, signal: new AbortController().signal });
    } finally {
      clearInterval(processLease);
    }
  }

  private async resumeQuantum(request: ThetaAgentQuantumRequest): Promise<ExecuteReActQuantumResult> {
    const checkpoint = await this.options.composition.reactCheckpoints.get(
      request.runId,
      request.built.context.stepId,
      request.built.scopeHash,
    );
    if (!checkpoint) throw new Error(`ReAct continuation checkpoint was not found: ${request.runId}.`);
    const createdAt = this.now();
    const payload: ContinueReActCommandPayloadV1 = {
      version: '1.0.0',
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      stepId: checkpoint.stepId,
      checkpointRef: `react-checkpoint:${checkpoint.runId}:${checkpoint.stepId}:${checkpoint.stepSequence}`,
      checkpointHash: hashCanonicalJson(checkpoint),
      checkpointSequence: checkpoint.stepSequence,
      scopeHash: checkpoint.scopeHash,
      agentRef: checkpoint.agentRef,
      domainPackRef: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
      workflowRef: { id: THETA_WORKFLOW_ID, version: THETA_WORKFLOW_VERSION },
      promptSnapshotRef: `prompt:${request.built.promptSnapshotHash}`,
      promptSnapshotHash: request.built.promptSnapshotHash,
      capabilitySnapshotRef: `capability:${request.built.capabilitySnapshotHash}`,
      capabilitySnapshotHash: request.built.capabilitySnapshotHash,
      workspaceRef: String(request.built.context.metadata?.workspaceHash ?? ''),
      globalBudget: {
        iterations: request.budget.maxIterations,
        modelCalls: request.budget.maxModelCalls,
        toolCalls: request.budget.maxToolCalls,
        totalTokens: request.budget.maxTotalTokens,
      },
      cancellationRevision: 0,
      createdAt,
    };
    const command: SessionCommandRecord = {
      id: `continue:${request.runId}:${checkpoint.stepSequence}`,
      commandType: 'continue_react',
      idempotencyKey: hashCanonicalJson({ runId: request.runId, checkpoint: payload.checkpointHash }),
      userId: request.userId,
      sessionId: request.sessionId,
      targetRunId: request.runId,
      enqueueSequence: checkpoint.stepSequence,
      priority: 50,
      attempts: 1,
      maxAttempts: 5,
      leaseEpoch: 1,
      payloadHash: hashCanonicalJson(payload),
      status: 'claimed',
      claimedBy: 'theta-v6-local-continuation',
      claimToken: hashCanonicalJson({ runId: request.runId, step: checkpoint.stepSequence }),
      leaseExpiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
      createdAt,
      availableAt: createdAt,
    };
    const descriptor = createContinuationReActQuantumDescriptor(command, payload);
    return this.executor.runOneQuantum({
      descriptor,
      command,
      signal: new AbortController().signal,
    });
  }

  private createRunner(context: ReActRunContext): ReActRunner {
    const executionScope = context.toolExecutionScope;
    return new ReActRunner(new ThetaReActAgentRuntime(this.options.composition.toolRegistry), {
      inference: this.options.inference,
      toolRunner: this.options.composition.toolRunner,
      checkpointStore: this.options.composition.reactCheckpoints,
      continueAfterTool: true,
      resolveToolExecutionScope: () => executionScope,
      onStep: async (step) => {
        await this.runManager.recordReactStep(runExecutionContext(context), step);
        if (step.phase === 'act') await this.recordCompletedToolActivity(context, step.input);
      },
      onCheckpoint: async (checkpoint) => {
        await this.runManager.recordReactContinuationCheckpoint(runExecutionContext(context), checkpoint);
      },
      onResume: async (checkpoint) => {
        await this.runManager.recordReactContinuationResumed(
          runExecutionContext(context),
          checkpoint,
          this.now(),
        );
      },
      now: this.now,
    });
  }

  private async recordCompletedToolActivity(context: ReActRunContext, input: unknown): Promise<void> {
    const action = record(input);
    if (action.type !== 'tool' || typeof action.target !== 'string') return;
    const toolId = action.target;
    const copy = toolActivityCopy(toolId, this.options.composition.toolRegistry.getSpec(toolId)?.displayName);
    await new ThetaActivityEventRepository(this.options.composition.eventBridge).record({
      runId: context.runId,
      sessionId: context.memoryScope?.sessionId ?? `session:${context.runId}`,
      userId: context.memoryScope?.userId ?? 'local_user',
      activityId: `tool:${context.runId}:${context.stepId}:${typeof action.toolCallId === 'string' ? action.toolCallId : toolId}`,
      phase: typeof context.metadata?.phase === 'string' ? context.metadata.phase : 'unknown',
      kind: 'tool_completed',
      toolId,
      displayName: copy.displayName,
      userMessage: copy.completed,
      status: 'completed',
      completedAt: this.now(),
      safeOutputSummary: '工具结果已写入受治理的运行记录',
    });
  }

  private buildRuntimeState(request: ThetaAgentQuantumRequest): ReActQuantumRuntimeState {
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      status: 'running',
      cancellationRevision: 0,
      agentRef: { id: request.built.context.agent.id, version: request.built.context.agent.version },
      domainPackRef: { id: THETA_DOMAIN_PACK_ID, version: THETA_DOMAIN_PACK_VERSION },
      workflowRef: { id: THETA_WORKFLOW_ID, version: THETA_WORKFLOW_VERSION },
      promptSnapshotHash: request.built.promptSnapshotHash,
      capabilitySnapshotHash: request.built.capabilitySnapshotHash,
    };
  }

  private async runtimeState(descriptor: Readonly<ReActQuantumDescriptor>): Promise<ReActQuantumRuntimeState> {
    const state = this.states.get(stateKey(descriptor.runId, descriptor.stepId));
    if (state) return structuredClone(state);
    const run = await this.runManager.projectRun(descriptor.runId);
    if (!run) throw new Error(`THETA ReAct runtime state was not found: ${descriptor.runId}`);
    return {
      runId: descriptor.runId,
      sessionId: descriptor.sessionId,
      userId: descriptor.userId,
      status: run.status === 'queued' ? 'created' : run.status,
      cancellationRevision: descriptor.cancellationRevision,
      agentRef: descriptor.agentRef,
      domainPackRef: descriptor.domainPackRef,
      workflowRef: descriptor.workflowRef,
      promptSnapshotHash: descriptor.promptSnapshotHash,
      capabilitySnapshotHash: descriptor.capabilitySnapshotHash,
    };
  }

  private async recordOutcome(
    descriptor: Readonly<ReActQuantumDescriptor>,
    react: Awaited<ReturnType<ReActRunner['run']>>,
    disposition: 'completed' | 'suspended' | 'waiting_human' | 'cancelled' | 'failed',
  ): Promise<void> {
    const context = {
      runId: descriptor.runId,
      sessionId: descriptor.sessionId,
      userId: descriptor.userId,
      agentId: descriptor.agentRef.id,
    };
    if (disposition === 'suspended') {
      await this.runManager.recordReactContinuationSuspended(context, react);
      return;
    }
    if (disposition === 'waiting_human') {
      await this.runManager.recordReasoningDecision(context, {
        kind: 'phase_human_review_requested',
        finalAction: react.finalAction,
      });
      return;
    }
    if (disposition === 'cancelled') {
      await this.runManager.recordReasoningDecision(context, { kind: 'phase_quantum_cancelled' });
      return;
    }
    if (disposition === 'failed') {
      await this.runManager.recordReasoningDecision(context, {
        kind: 'phase_quantum_failed',
        error: react.error instanceof Error ? react.error.message : String(react.error),
      });
      return;
    }
    await this.runManager.recordReasoningDecision(context, {
      kind: 'phase_quantum_completed',
      output: react.output,
    });
  }
}

const runExecutionContext = (context: ReActRunContext) => ({
  runId: context.runId,
  sessionId: context.memoryScope?.sessionId ?? 'theta-local-session',
  userId: context.memoryScope?.userId ?? 'local_user',
  agentId: context.agent.id,
});

const stateKey = (runId: string, stepId: string): string => hashCanonicalJson({ runId, stepId });

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
