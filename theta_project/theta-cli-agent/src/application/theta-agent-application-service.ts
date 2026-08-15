import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  createRuntimeOrchestrationProjectionDefinition,
  hashCanonicalJson,
  type EventCreateInput,
  type FrameworkEvent,
  type RuntimeOrchestrationProjection,
  type RuntimeScope,
} from '@hypha/core';
import type { ThetaRuntimeComposition } from '../persistence/runtime-composition.js';
import {
  FencedBoundedFSMDriver,
  type FencedBoundedFSMDriverOptions,
} from '@hypha/harness';
import {
  createThetaRuntimeComposition,
  defaultThetaV6RuntimeDb,
} from '../persistence/runtime-composition.js';
import {
  compileThetaTrainingDomain,
} from '../domain-v6/theta-domain-pack-v6.js';
import {
  THETA_DOMAIN_PACK_VERSION,
  THETA_WORKFLOW_STATES,
  THETA_WORKFLOW_VERSION,
  type ThetaWorkflowState,
} from '../domain-v6/workflow-states.js';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { emptyDatasetWorkspace, emptyPlanWorkspace, emptyResearchWorkspace } from '../workspaces/factories.js';
import {
  confirmUniquePrimaryTextRole,
  hasUniqueConfirmedPrimaryTextColumn,
  primaryTextCandidates,
} from '../workspaces/dataset-column-roles.js';
import type { DatasetWorkspace } from '../workspaces/contracts.js';
import { SQLiteRemoteSampleAuthorizationStore } from '../storage/remote-sample-authorization-store.js';
import { createMiniMaxProviderFromEnv } from '../providers/minimax.js';
import { buildThetaPhaseContext } from '../agent-runtime/context-builder.js';
import { ThetaAgentRunner } from '../agent-runtime/theta-agent-runner.js';
import { ThetaToolCircuitOpenError } from '../agent-runtime/tool-failure-circuit-breaker.js';
import { thetaPhaseBudget } from '../agent-runtime/phase-budget.js';
import { isThetaPhaseOutcome, type ThetaPhaseOutcome, type ThetaPlanConfirmationDecision } from '../agent-runtime/contracts.js';
import { evaluateThetaV6Guard } from '../domain-v6/workflow-guards.js';
import { ThetaConversationEventRepository } from '../messages/message-event-store.js';
import type { ConversationDigest } from '../messages/contracts.js';
import { ConversationMemoryCoordinator } from '../memory/conversation-memory-coordinator.js';
import { ThetaCheckpointEventRepository } from '../checkpoints/checkpoint-service.js';
import type {
  CheckpointFeedbackDecision,
  ConversationalCheckpoint,
  SubmitCheckpointDecisionRequest,
  SubmitCheckpointMessageRequest,
} from '../checkpoints/contracts.js';
import { MiniMaxCheckpointFeedbackInterpreter } from '../checkpoints/feedback-interpreter.js';
import { MiniMaxResearchCheckpointFeedbackInterpreter } from '../checkpoints/research-feedback-interpreter.js';
import { MiniMaxPlanConfirmationVerifier } from '../checkpoints/plan-confirmation-verifier.js';
import { MiniMaxTrainingConfirmationInterpreter } from '../checkpoints/training-confirmation-interpreter.js';
import type { TrainingCheckpointFeedbackDecision } from '../checkpoints/contracts.js';
import type { InferenceProvider } from '@hypha/inference';
import type { ToolCallRequest, ToolCallResult } from '@hypha/tools';
import { resolveThetaV6StateToolScope, THETA_STATE_TOOL_PROFILES } from '../domain-v6/tool-scopes.js';
import { THETA_TOOL_IDS } from '../tools/tool-ids.js';
import { ThetaPlannerEventRepository } from '../planner-v3/event-store.js';
import { planApprovalReceiptHash, PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH, type PlanApprovalReceipt } from '../planner-v3/contracts.js';
import { presentCandidatePlan, type CandidatePlanPresentation } from '../planner-v3/candidate-presenter.js';
import { ThetaActivityEventRepository } from '../activities/activity-event-store.js';
import { toolActivityCopy } from '../activities/activity-copy.js';
import type { AgentActivitySnapshot } from '../activities/contracts.js';
import {
  ThetaExecutionEventRepository,
  humanTrainingReviewSchema,
  trainingApprovalReceiptHash,
  trainingProgressSnapshotSchema,
  trainingRunReceiptHash,
  type CanonicalPlanExecutionRecord,
  type DryRunReceipt,
  type HumanTrainingReview,
  type TrainingProgressSnapshot,
} from '../execution/index.js';
import {
  DatasetAttachmentBroker,
  type DatasetUploadRequestRecord,
} from '../datasets/dataset-attachment-broker.js';

export interface ThetaAgentCreateRunRequest {
  filePath?: string;
  datasetRef?: string;
  runId?: string;
  runtimeDb?: string;
  initialMessage?: string;
  allowRemoteSamples?: boolean;
  userId?: string;
  workspaceId?: string;
}

export interface ThetaAgentRunSnapshot {
  runId: string;
  runtimeDb: string;
  status: RuntimeOrchestrationProjection['runStatus'];
  currentState?: string;
  eventCount: number;
  datasetRef?: string;
  datasetHash?: string;
  datasetWorkspaceHash?: string;
  planWorkspaceHash?: string;
  candidatePlanHash?: string;
  planApprovalHash?: string;
  canonicalPlanId?: string;
  canonicalPlanHash?: string;
  dryRunHash?: string;
  dryRunPassed?: boolean;
  trainingApprovalHash?: string;
  datasetVerificationHash?: string;
  trainingRunId?: string;
  trainingStatus?: TrainingProgressSnapshot['status'];
  trainingPhase?: TrainingProgressSnapshot['phase'];
  trainingPercent?: number;
  artifactManifestHash?: string;
  remoteSampleAuthorizationReceiptId?: string;
  pendingActionRef?: string;
  pendingReason?: string;
  recoveryReason?: string;
  currentActivity?: AgentActivitySnapshot['current'];
  progress?: AgentActivitySnapshot['progress'];
}

export interface ThetaIntakeResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition: 'completed' | 'waiting_human' | 'recoverable_error';
  outcome?: ThetaPhaseOutcome;
  uploadRequest?: DatasetUploadRequestRecord;
  assistantMessage?: string;
  toolIds: string[];
  modelCalls: number;
  quanta: number;
  error?: string;
}

export interface ThetaDatasetDiscoveryResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition: 'completed' | 'waiting_human' | 'recoverable_error';
  outcome?: ThetaPhaseOutcome;
  toolIds: string[];
  modelCalls: number;
  quanta: number;
  error?: string;
}

export interface ThetaResearchDialogueResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition: 'completed' | 'waiting_human' | 'recoverable_error';
  outcome?: ThetaPhaseOutcome;
  assistantMessage?: string;
  toolIds: string[];
  modelCalls: number;
  quanta: number;
  error?: string;
}

export interface ThetaPlanDesignResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition: 'completed' | 'waiting_human' | 'recoverable_error';
  outcome?: ThetaPhaseOutcome;
  assistantMessage?: string;
  candidateRef?: string;
  candidatePlanHash?: string;
  validationReceiptHash?: string;
  evidenceBundleHash?: string;
  planPresentation?: CandidatePlanPresentation;
  toolIds: string[];
  modelCalls: number;
  quanta: number;
  error?: string;
}

export interface ThetaCheckpointMessageResult {
  snapshot: ThetaAgentRunSnapshot;
  messageId: string;
  decision: CheckpointFeedbackDecision;
  checkpoint: ConversationalCheckpoint;
  assistantMessage: string;
  continuation?: ThetaDatasetDiscoveryResult;
}

export interface ThetaCheckpointDecisionResult {
  snapshot: ThetaAgentRunSnapshot;
  action: 'approve' | 'revise';
  checkpoint: ConversationalCheckpoint;
  assistantMessage: string;
  modelCalls: number;
  toolIds: string[];
  approvalReceipt?: PlanApprovalReceipt;
  continuation?: ThetaDatasetDiscoveryResult | ThetaResearchDialogueResult | ThetaPlanDesignResult;
}

export interface ThetaPlanConfirmationMessageResult {
  snapshot: ThetaAgentRunSnapshot;
  messageId: string;
  decision: ThetaPlanConfirmationDecision;
  checkpoint: ConversationalCheckpoint;
  assistantMessage: string;
  approvalReceipt?: PlanApprovalReceipt;
  toolIds: string[];
  modelCalls: number;
  quanta: number;
}

export interface ThetaTrainingPreparationResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition:
    | 'ready_for_training_confirmation'
    | 'returned_to_plan'
    | 'returned_to_dataset'
    | 'human_recovery';
  canonicalPlan?: CanonicalPlanExecutionRecord;
  dryRun?: DryRunReceipt;
  summary: string;
  toolIds: string[];
}

export interface ThetaTrainingConfirmationMessageResult {
  snapshot: ThetaAgentRunSnapshot;
  messageId: string;
  decision: TrainingCheckpointFeedbackDecision;
  checkpoint: ConversationalCheckpoint;
  assistantMessage: string;
  approvalReceipt?: HumanTrainingReview;
}

export interface ThetaTrainingLifecycleResult {
  snapshot: ThetaAgentRunSnapshot;
  disposition: 'dataset_verified' | 'training_started' | 'monitoring' | 'results_ready' | 'completed' | 'cancelled' | 'recovery_required' | 'quarantined';
  summary: string;
  toolIds: string[];
  progress?: TrainingProgressSnapshot;
  results?: Record<string, unknown>;
}

export interface ThetaAgentApplicationServiceOptions {
  inferenceFactory?: () => InferenceProvider | undefined;
}

export class ThetaAgentApplicationService {
  constructor(private readonly options: ThetaAgentApplicationServiceOptions = {}) {}

  private inferenceProvider(): InferenceProvider | undefined {
    return this.options.inferenceFactory?.() ?? createMiniMaxProviderFromEnv();
  }

  compileSummary(): Record<string, unknown> {
    const compilation = compileThetaTrainingDomain();
    return {
      architecture: 'business-fsm-plus-react-quantum',
      agentContract: '3.0.0',
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

  async createRun(request: ThetaAgentCreateRunRequest): Promise<ThetaAgentRunSnapshot> {
    const runId = request.runId?.trim() || `theta-run-${randomUUID()}`;
    const runtimeDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const scope = runtimeScope(runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(runtimeDb, { memory: true });
    const registry = new SQLiteDatasetRegistry(runtimeDb);
    const sampleAuthorizations = new SQLiteRemoteSampleAuthorizationStore(runtimeDb);
    try {
      const filePath = request.filePath?.trim();
      const datasetRef = request.datasetRef?.trim();
      if (filePath && datasetRef) throw new Error('Create Run accepts at most one dataset source: filePath or datasetRef.');
      const dataset = datasetRef
        ? registry.require(datasetRef, { userId, workspaceId })
        : filePath
          ? await registry.registerLocalFile(path.resolve(filePath), { userId, workspaceId })
          : undefined;
      const sampleAuthorization = request.allowRemoteSamples === true && dataset
        ? sampleAuthorizations.grant({
            runId,
            datasetHash: dataset.sha256,
            userId,
            workspaceId,
            maxRows: 10,
          })
        : undefined;
      await seedRun(runtime, scope, {
        ...(dataset === undefined ? {} : { datasetRef: dataset.datasetRef, datasetHash: dataset.sha256 }),
        initialMessage: request.initialMessage ?? '',
        allowRemoteSamples: request.allowRemoteSamples === true,
        remoteSampleAuthorizationReceiptId: sampleAuthorization?.receiptId ?? '',
        domainPackVersion: THETA_DOMAIN_PACK_VERSION,
        workflowVersion: THETA_WORKFLOW_VERSION,
      });
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const conversationRepository = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(
        conversationRepository,
        runtime.memory,
        { userId, workspaceId, sessionId: scope.sessionId, runId },
      );
      if (request.initialMessage?.trim()) {
        await memoryCoordinator.append('Intake', {
          runId,
          sessionId: scope.sessionId,
          userId,
          role: 'user',
          content: request.initialMessage,
          messageId: `message:intake:${runId}`,
        });
      }
      const datasetHash = dataset === undefined ? undefined : `sha256:${dataset.sha256}`;
      const intakeOutcome = dataset === undefined ? undefined : {
        kind: 'phase_completion_proposed' as const,
        phase: 'Intake' as const,
        artifactRef: dataset.datasetRef,
        artifactHash: datasetHash as string,
        rationale: 'A pre-registered dataset was supplied by an explicit non-interactive caller.',
        confidence: 1,
        checkpointDecision: 'skip' as const,
      };
      const workspace = dataset === undefined
        ? undefined
        : await new ThetaWorkspaceEventRepository(runtime.eventBridge).revise({
            runId,
            sessionId: scope.sessionId,
            userId,
            expectedRevision: 0,
            draft: emptyDatasetWorkspace(runId, datasetHash as string),
            reason: 'Run intake established the initial dataset workspace.',
          });
      const variables = dataset === undefined
        ? {}
        : {
            datasetRef: dataset.datasetRef,
            datasetHash,
            datasetWorkspaceHash: workspace?.workspaceHash,
            phaseOutcome: intakeOutcome,
            ...(sampleAuthorization === undefined
              ? {}
              : { remoteSampleAuthorizationReceiptId: sampleAuthorization.receiptId }),
          };
      const driver = runtimeDriver(runtime, async () => ({
        result: {
          kind: 'completed' as const,
          variablesPatch: variables,
        },
        transition: {
          to: dataset === undefined ? THETA_WORKFLOW_STATES.intake : THETA_WORKFLOW_STATES.datasetDiscovery,
          ...(dataset === undefined ? {} : { variablesPatch: variables }),
        },
        ...(dataset === undefined ? {} : { guardContext: { variables } }),
      }));
      await driver.run({
        scope,
        process: compileThetaTrainingDomain().fsmProcess,
        ownerId: 'theta-v6-application',
        maxSteps: 1,
        leaseTtlMs: 30_000,
        stateClaimTtlMs: 30_000,
      });
      if (dataset !== undefined) {
        await memoryCoordinator.handoff({
          fromPhase: 'Intake',
          toPhase: 'DatasetDiscovery',
          summary: '用户通过受治理数据接入开始任务；上传前表达的目标和偏好必须继续影响数据探索。',
          workspaceHashes: workspace === undefined ? [] : [workspace.workspaceHash],
        });
      }
      return this.status(runId, runtimeDb);
    } finally {
      sampleAuthorizations.close();
      registry.close();
      runtime.close();
    }
  }

  async runIntake(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
    uploadRoot = managedUploadRoot(runtimeDb),
  ): Promise<ThetaIntakeResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const scope = runtimeScope(runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    const broker = new DatasetAttachmentBroker({ runtimeDb: resolvedDb, managedRoot: uploadRoot });
    try {
      const snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.intake || snapshot.status === 'waiting_human') {
        throw new Error(`Run is not ready for Intake reasoning: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      if (snapshot.datasetRef || snapshot.datasetHash) throw new Error('Intake cannot replace an already registered Run dataset.');
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const events = await runtime.events.read({ scope: { userId, runId } });
      const initialMessage = initialMessageFrom(events);
      const conversation = await new ThetaConversationEventRepository(runtime.eventBridge).digest(runId);
      const uploadRequest = broker.current(runId, { userId, workspaceId });
      const placeholderHash = `sha256:${'0'.repeat(64)}`;
      const placeholderWorkspace = emptyDatasetWorkspace(runId, placeholderHash);
      const workspaceHash = hashCanonicalJson(placeholderWorkspace);
      const intakeWorkspace = { ...placeholderWorkspace, workspaceHash, revision: 0, updatedAt: new Date().toISOString() };
      const verifiedIntake = {
        runHasDataset: false,
        upload: uploadRequest === null
          ? { status: 'not_requested' }
          : {
              status: uploadRequest.status,
              uploadRequestId: uploadRequest.uploadRequestId,
              reason: uploadRequest.reason,
              acceptedFormats: uploadRequest.acceptedFormats,
              ...(uploadRequest.attachmentRef === undefined ? {} : { attachmentRef: uploadRequest.attachmentRef }),
              ...(uploadRequest.displayName === undefined ? {} : { displayName: uploadRequest.displayName }),
              ...(uploadRequest.suffix === undefined ? {} : { suffix: uploadRequest.suffix }),
              ...(uploadRequest.sizeBytes === undefined ? {} : { sizeBytes: uploadRequest.sizeBytes }),
              ...(uploadRequest.datasetRef === undefined ? {} : { datasetRef: uploadRequest.datasetRef }),
              ...(uploadRequest.sha256 === undefined ? {} : { datasetHash: `sha256:${uploadRequest.sha256}` }),
              ...(uploadRequest.allowRemoteSamples === undefined ? {} : { remoteSamplesAuthorized: uploadRequest.allowRemoteSamples }),
            },
        instruction: 'This is a trusted host projection. The local filesystem path is intentionally unavailable.',
      };
      const identity = { userId, workspaceId, sessionId, runId };
      const conversationRepository = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(conversationRepository, runtime.memory, identity);
      await memoryCoordinator.synchronize('Intake', conversation.messages);
      const memoryEnvelope = await runtime.memory.buildContext({
        identity,
        phase: 'Intake',
        stateId: THETA_WORKFLOW_STATES.intake,
        systemInstructions: 'You are the single THETA Agent operating in Intake. Request and ingest data only through governed attachment tools.',
        currentWorkspace: intakeWorkspace,
        messages: conversation.messages,
        query: [initialMessage, uploadRequest?.status, uploadRequest?.displayName, 'governed dataset intake'].filter(Boolean).join('\n'),
      });
      const built = buildThetaPhaseContext({
        runId,
        sessionId,
        userId,
        workspaceId,
        runtimeDb: resolvedDb,
        uploadRoot: path.resolve(uploadRoot),
        phase: 'Intake',
        datasetHash: placeholderHash,
        workspace: intakeWorkspace,
        memoryEnvelope,
        messages: [
          { role: 'system', content: JSON.stringify({ verifiedIntake }) },
          ...(conversation.messages.length === 0
            ? [{
                role: 'user' as const,
                content: initialMessage || '我刚进入 THETA。请先简洁介绍你能做什么、怎样与你协作，并邀请我用任何自然方式开始。',
              }]
            : conversation.messages.map((message) => ({
                role: message.role,
                content: JSON.stringify({ messageId: message.messageId, content: message.content }),
              }))),
        ],
      });
      const inference = this.inferenceProvider();
      if (!inference) throw new Error('MINIMAX_API_KEY is not configured.');
      const budget = thetaPhaseBudget('Intake');
      const runner = new ThetaAgentRunner({
        composition: runtime,
        inference,
        artifactRoot: path.join(path.dirname(resolvedDb), 'react-artifacts'),
        quantumIterations: budget.quantumIterations,
      });
      let resume = false;
      let quanta = 0;
      const toolIds: string[] = [];
      let modelCalls = 0;
      let result: Awaited<ReturnType<ThetaAgentRunner['runQuantum']>>;
      do {
        result = await runner.runQuantum({ runId, sessionId, userId, built, budget, resume });
        quanta += 1;
        const steps = result.react?.steps ?? [];
        toolIds.push(...steps
          .filter((step) => step.phase === 'act')
          .map((step) => record(step.input).target)
          .filter((value): value is string => typeof value === 'string'));
        modelCalls += steps.filter((step) => step.phase === 'reason').length;
        resume = true;
      } while (isQuantumYield(result));

      if (result.disposition === 'waiting_human') {
        const request = result.react?.finalAction?.input;
        if (!request || typeof request !== 'object' || record(request).purpose !== 'intake_question') {
          throw new Error('Intake produced an invalid natural conversation request.');
        }
        const message = String(record(request).message);
        const question = String(record(request).question);
        const assistant = await memoryCoordinator.append('Intake', {
          runId,
          sessionId,
          userId,
          role: 'assistant',
          content: `${message}\n\n${question}`,
        });
        await runDatasetStateDecision(runtime, scope, {
          result: {
            kind: 'waiting',
            wait: {
              type: 'human',
              key: `intake-question:${runId}:${assistant.messageId}`,
              pendingActionRef: `theta.intake.question:${assistant.messageId}`,
              reason: assistant.content,
              metadata: { request: JSON.stringify(request) },
            },
          },
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'waiting_human',
          assistantMessage: assistant.content,
          uploadRequest: broker.current(runId, { userId, workspaceId }) ?? undefined,
          toolIds,
          modelCalls,
          quanta,
        };
      }

      if (result.disposition !== 'completed') {
        const message = result.react?.error instanceof Error
          ? result.react.error.message
          : `Intake Agent ended with ${result.disposition}. ${JSON.stringify(safeReactFailureSummary(result.react))}`;
        if (result.react?.error instanceof ThetaToolCircuitOpenError) {
          await enterToolFailureRecovery(runtime, scope, result.react.error);
        }
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'recoverable_error',
          uploadRequest: broker.current(runId, { userId, workspaceId }) ?? undefined,
          toolIds,
          modelCalls,
          quanta,
          error: message,
        };
      }

      const outcome = result.react?.output;
      if (!isThetaPhaseOutcome(outcome)) throw new Error('Intake Agent did not return a legal phase outcome.');
      const currentUpload = broker.current(runId, { userId, workspaceId });
      if (outcome.kind === 'phase_blocked') {
        if (!currentUpload || currentUpload.status !== 'waiting_for_file') {
          throw new Error('Intake may wait for a user only after theta.dataset.request_upload created a pending request.');
        }
        await runDatasetStateDecision(runtime, scope, {
          result: {
            kind: 'waiting',
            wait: {
              type: 'human',
              key: `dataset-upload:${currentUpload.uploadRequestId}`,
              pendingActionRef: currentUpload.uploadRequestId,
              reason: currentUpload.reason,
              metadata: { actionRef: 'theta.dataset.upload', acceptedFormats: currentUpload.acceptedFormats.join(',') },
            },
          },
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'waiting_human',
          outcome,
          uploadRequest: currentUpload,
          toolIds,
          modelCalls,
          quanta,
        };
      }
      if (outcome.kind !== 'phase_completion_proposed' || outcome.phase !== 'Intake') {
        throw new Error('Intake Agent did not return an Intake completion proposal.');
      }
      if (!currentUpload?.datasetRef || currentUpload.status !== 'ingested' || !currentUpload.sha256) {
        throw new Error('Intake completion is not bound to an ingested attachment.');
      }
      const registry = new SQLiteDatasetRegistry(resolvedDb);
      const sampleAuthorizations = new SQLiteRemoteSampleAuthorizationStore(resolvedDb);
      try {
        const dataset = registry.require(currentUpload.datasetRef, { userId, workspaceId });
        const datasetHash = `sha256:${dataset.sha256}`;
        if (outcome.artifactRef !== dataset.datasetRef || outcome.artifactHash !== datasetHash) {
          throw new Error('Intake completion does not match the governed ingestion result.');
        }
        const workspaceRepository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
        const existingWorkspace = await workspaceRepository.current(runId, 'dataset');
        const workspace = existingWorkspace ?? await workspaceRepository.revise({
          runId,
          sessionId,
          userId,
          expectedRevision: 0,
          draft: emptyDatasetWorkspace(runId, datasetHash),
          reason: 'Governed Intake attached the ingested dataset to this Run.',
        });
        const allowRemoteSamples = currentUpload.allowRemoteSamples === true;
        const sampleAuthorization = allowRemoteSamples
          ? sampleAuthorizations.grant({ runId, datasetHash: dataset.sha256, userId, workspaceId, maxRows: 10 })
          : undefined;
        const outcomeJson = structuredClone(outcome) as unknown as Record<string, string | number>;
        const variables = {
          datasetRef: dataset.datasetRef,
          datasetHash,
          datasetWorkspaceHash: workspace.workspaceHash,
          phaseOutcome: outcomeJson,
          ...(sampleAuthorization === undefined ? {} : { remoteSampleAuthorizationReceiptId: sampleAuthorization.receiptId }),
        };
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', output: outcomeJson, variablesPatch: variables },
          transition: {
            to: THETA_WORKFLOW_STATES.datasetDiscovery,
            reason: 'MiniMax ingested a Run-scoped attachment and the FSM verified its exact registered identity.',
            variablesPatch: variables,
          },
          guardContext: { variables },
        });
        await memoryCoordinator.handoff({
          fromPhase: 'Intake',
          toPhase: 'DatasetDiscovery',
          summary: `已通过受治理附件接入数据集 ${currentUpload.displayName ?? '未命名数据集'}；上传前对话继续作为全局研究上下文。`,
          workspaceHashes: [workspace.workspaceHash],
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'completed',
          outcome,
          uploadRequest: currentUpload,
          toolIds,
          modelCalls,
          quanta,
        };
      } finally {
        sampleAuthorizations.close();
        registry.close();
      }
    } finally {
      await runtime.close();
    }
  }

  currentDatasetUploadRequest(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
    uploadRoot = managedUploadRoot(runtimeDb),
  ): DatasetUploadRequestRecord | null {
    return new DatasetAttachmentBroker({ runtimeDb: path.resolve(runtimeDb), managedRoot: uploadRoot })
      .current(runId, { userId: 'local_user', workspaceId: 'local_workspace' });
  }

  async stageDatasetAttachment(request: {
    runId: string;
    uploadRequestId: string;
    filePath: string;
    runtimeDb?: string;
    uploadRoot?: string;
    userId?: string;
    workspaceId?: string;
    allowRemoteSamples?: boolean;
  }): Promise<DatasetUploadRequestRecord> {
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const snapshot = await this.status(request.runId, resolvedDb);
    if (snapshot.currentState !== THETA_WORKFLOW_STATES.intake || snapshot.status !== 'waiting_human') {
      throw new Error(`Run is not waiting for a dataset upload: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
    }
    if (snapshot.pendingActionRef !== request.uploadRequestId) throw new Error('Upload request does not match the current FSM human wait.');
    const broker = new DatasetAttachmentBroker({
      runtimeDb: resolvedDb,
      managedRoot: request.uploadRoot ?? managedUploadRoot(resolvedDb),
    });
    const staged = await broker.stageLocalFile({
      runId: request.runId,
      uploadRequestId: request.uploadRequestId,
      filePath: request.filePath,
      userId,
      workspaceId,
      allowRemoteSamples: request.allowRemoteSamples === true,
    });
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    try {
      await resolveHumanWait(runtime, runtimeScope(request.runId, userId, workspaceId), snapshot, userId, 'approved');
      await new ThetaActivityEventRepository(runtime.eventBridge).record({
        runId: request.runId,
        sessionId: `session:${request.runId}`,
        userId,
        activityId: `attachment:${staged.attachmentRef}`,
        phase: THETA_WORKFLOW_STATES.intake,
        kind: 'phase_completed',
        displayName: '接收用户选择的附件',
        userMessage: '已接收文件，正在交还给 Agent 决定如何摄取',
        status: 'completed',
        safeOutputSummary: `attachmentRef=${staged.attachmentRef}; file=${staged.displayName}; size=${staged.sizeBytes}`,
        completedAt: new Date().toISOString(),
      });
    } finally {
      runtime.close();
    }
    return staged;
  }

  async status(runId: string, runtimeDb = defaultThetaV6RuntimeDb()): Promise<ThetaAgentRunSnapshot> {
    const resolvedDb = path.resolve(runtimeDb);
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    const scope = runtimeScope(runId, 'local_user', 'local_workspace');
    try {
      const events = await runtime.events.read({ scope: eventScope(scope) });
      if (events.length === 0) throw new Error(`Run not found: ${runId}`);
      const projection = (
        await runtime.projections.update(
          createRuntimeOrchestrationProjectionDefinition(runId),
          runtime.projectionStore,
          eventScope(scope),
        )
      ).state;
      const variables = projectVariables(events);
      const activity = await new ThetaActivityEventRepository(runtime.eventBridge).snapshot(runId, 10);
      const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
      const trainingProgress = await execution.currentTrainingProgress(runId);
      return {
        runId,
        runtimeDb: resolvedDb,
        status: projection.runStatus,
        eventCount: events.length,
        ...(projection.currentState === undefined ? {} : { currentState: projection.currentState }),
        ...(typeof variables.datasetRef === 'string' ? { datasetRef: variables.datasetRef } : {}),
        ...(typeof variables.datasetHash === 'string' ? { datasetHash: variables.datasetHash } : {}),
        ...(typeof variables.datasetWorkspaceHash === 'string'
          ? { datasetWorkspaceHash: variables.datasetWorkspaceHash }
          : {}),
        ...(typeof variables.planWorkspaceHash === 'string' ? { planWorkspaceHash: variables.planWorkspaceHash } : {}),
        ...(typeof variables.candidatePlanHash === 'string' ? { candidatePlanHash: variables.candidatePlanHash } : {}),
        ...(typeof variables.planApprovalHash === 'string' ? { planApprovalHash: variables.planApprovalHash } : {}),
        ...(typeof variables.canonicalPlanId === 'string' ? { canonicalPlanId: variables.canonicalPlanId } : {}),
        ...(typeof variables.canonicalPlanHash === 'string' ? { canonicalPlanHash: variables.canonicalPlanHash } : {}),
        ...(typeof variables.dryRunHash === 'string' ? { dryRunHash: variables.dryRunHash } : {}),
        ...(typeof variables.dryRunPassed === 'boolean' ? { dryRunPassed: variables.dryRunPassed } : {}),
        ...(typeof variables.trainingApprovalHash === 'string' ? { trainingApprovalHash: variables.trainingApprovalHash } : {}),
        ...(typeof variables.datasetVerificationHash === 'string' ? { datasetVerificationHash: variables.datasetVerificationHash } : {}),
        ...(typeof variables.trainingRunId === 'string' ? { trainingRunId: variables.trainingRunId } : {}),
        ...(trainingProgress === null ? {} : {
          trainingStatus: trainingProgress.status,
          trainingPhase: trainingProgress.phase,
          trainingPercent: trainingProgress.overallPercent,
        }),
        ...(typeof variables.artifactManifestHash === 'string' ? { artifactManifestHash: variables.artifactManifestHash } : {}),
        ...(typeof variables.remoteSampleAuthorizationReceiptId === 'string'
          ? { remoteSampleAuthorizationReceiptId: variables.remoteSampleAuthorizationReceiptId }
          : {}),
        ...(projection.pendingWait?.pendingActionRef === undefined
          ? {}
          : { pendingActionRef: projection.pendingWait.pendingActionRef }),
        ...(projection.pendingWait?.reason === undefined
          ? {}
          : { pendingReason: projection.pendingWait.reason }),
        ...(typeof variables.recoveryReason === 'string'
          ? { recoveryReason: variables.recoveryReason }
          : {}),
        ...(activity.current === undefined ? {} : { currentActivity: activity.current }),
        progress: activity.progress,
      };
    } finally {
      runtime.close();
    }
  }

  async runDatasetDiscovery(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ThetaDatasetDiscoveryResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.datasetDiscovery) {
        throw new Error(`Run is not in DatasetDiscovery: ${snapshot.currentState ?? '(none)'}.`);
      }
      if (!snapshot.datasetRef || !snapshot.datasetHash) {
        throw new Error('Run does not contain a registered dataset identity.');
      }
      const repository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const initialWorkspace = await repository.current(runId, 'dataset');
      if (!initialWorkspace || initialWorkspace.workspaceType !== 'dataset') {
        throw new Error('DatasetWorkspace was not found.');
      }
      const events = await runtime.events.read({ scope: { userId, runId } });
      const initialMessage = initialMessageFrom(events);
      const conversation = await new ThetaConversationEventRepository(runtime.eventBridge).digest(runId);
      const priorCheckpoint = await new ThetaCheckpointEventRepository(runtime.eventBridge).current(runId, 'dataset');
      const revisionPass = priorCheckpoint?.status === 'revising';
      const allowedToolIds = resolveThetaV6StateToolScope(THETA_WORKFLOW_STATES.datasetDiscovery)
        .allowedToolIds
        ?.filter((toolId) => !revisionPass || toolId !== THETA_TOOL_IDS.datasetSubmitUnderstanding);
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const identity = { userId, workspaceId, sessionId, runId };
      const memoryCoordinator = new ConversationMemoryCoordinator(
        new ThetaConversationEventRepository(runtime.eventBridge),
        runtime.memory,
        identity,
      );
      await memoryCoordinator.synchronize('DatasetDiscovery', conversation.messages);
      await runtime.memory.rememberDatasetWorkspace(identity, initialWorkspace);
      const memoryEnvelope = await runtime.memory.buildContext({
        identity,
        phase: 'DatasetDiscovery',
        stateId: THETA_WORKFLOW_STATES.datasetDiscovery,
        systemInstructions: 'You are the single THETA Agent operating in DatasetDiscovery. Use governed tools and preserve evidence boundaries.',
        currentWorkspace: initialWorkspace,
        messages: conversation.messages,
        query: [initialMessage, initialWorkspace.narrative, 'autonomous dataset exploration'].filter(Boolean).join('\n'),
      });
      const built = buildThetaPhaseContext({
        runId,
        sessionId,
        userId,
        workspaceId,
        runtimeDb: resolvedDb,
        phase: 'DatasetDiscovery',
        datasetRef: snapshot.datasetRef,
        datasetHash: snapshot.datasetHash,
        workspace: initialWorkspace,
        memoryEnvelope,
        ...(allowedToolIds === undefined ? {} : { allowedToolIds }),
        messages: [
          {
            role: 'user',
            content: initialMessage || '请自主探索该数据集，形成有证据的数据理解，并决定是否值得让我确认。',
          },
          ...conversation.messages.map((message) => ({
            role: message.role,
            content: JSON.stringify({ messageId: message.messageId, content: message.content }),
          })),
        ],
      });
      const inference = this.inferenceProvider();
      if (!inference) throw new Error('MINIMAX_API_KEY is not configured.');
      const budget = thetaPhaseBudget('DatasetDiscovery');
      const runner = new ThetaAgentRunner({
        composition: runtime,
        inference,
        artifactRoot: path.join(path.dirname(resolvedDb), 'react-artifacts'),
        quantumIterations: budget.quantumIterations,
      });
      let resume = false;
      let quanta = 0;
      const toolIds: string[] = [];
      let modelCalls = 0;
      let result: Awaited<ReturnType<ThetaAgentRunner['runQuantum']>>;
      do {
        result = await runner.runQuantum({ runId, sessionId, userId, built, budget, resume });
        quanta += 1;
        const quantumSteps = result.react?.steps ?? [];
        toolIds.push(...quantumSteps
          .filter((step) => step.phase === 'act')
          .map((step) => record(step.input).target)
          .filter((value): value is string => typeof value === 'string'));
        modelCalls += quantumSteps.filter((step) => step.phase === 'reason').length;
        resume = true;
      } while (isQuantumYield(result));
      if (result.disposition === 'waiting_human') {
        const request = result.react?.finalAction?.input;
        await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
          result: {
            kind: 'waiting',
            wait: {
              type: 'human',
              key: `dataset-checkpoint:${runId}`,
              pendingActionRef: 'theta.dataset.checkpoint',
              reason: result.react?.finalAction?.reason ?? 'Dataset Agent requested a human decision.',
              metadata: { request: JSON.stringify(request ?? null) },
            },
          },
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'waiting_human',
          toolIds,
          modelCalls,
          quanta,
        };
      }
      if (result.disposition !== 'completed') {
        const message = result.react?.error instanceof Error
          ? result.react.error.message
          : `Dataset Agent ended with ${result.disposition}. ${JSON.stringify(safeReactFailureSummary(result.react))}`;
        if (result.react?.error instanceof ThetaToolCircuitOpenError) {
          await enterToolFailureRecovery(runtime, runtimeScope(runId, userId, workspaceId), result.react.error);
          return {
            snapshot: await this.status(runId, resolvedDb),
            disposition: 'recoverable_error',
            toolIds,
            modelCalls,
            quanta,
            error: message,
          };
        }
        await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
          result: {
            kind: 'continued',
            observation: {
              kind: 'recoverable_agent_error',
              phase: 'DatasetDiscovery',
              message,
            },
          },
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'recoverable_error',
          toolIds,
          modelCalls,
          quanta,
          error: message,
        };
      }
      const outcome = result.react?.output;
      if (!isThetaPhaseOutcome(outcome) || outcome.kind !== 'phase_completion_proposed' || outcome.phase !== 'DatasetDiscovery') {
        throw new Error('Dataset Agent did not return a DatasetDiscovery completion proposal.');
      }
      const workspace = await repository.current(runId, 'dataset');
      if (!workspace || workspace.workspaceType !== 'dataset' || workspace.workspaceHash !== outcome.artifactHash) {
        throw new Error('Dataset Agent completion is not bound to the current DatasetWorkspace hash.');
      }
      const primaryTextConfirmed = hasUniqueConfirmedPrimaryTextColumn(workspace);
      await runtime.memory.rememberDatasetWorkspace(identity, workspace, {
        checkpointStatus: 'proposed',
      });
      const target = THETA_WORKFLOW_STATES.datasetCheckpoint;
      const outcomeJson = structuredClone(outcome) as unknown as Record<string, string | number>;
      await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
        result: {
          kind: 'completed',
          output: outcomeJson,
          variablesPatch: {
            datasetWorkspaceHash: workspace.workspaceHash,
            datasetPrimaryTextConfirmed: primaryTextConfirmed,
            phaseOutcome: outcomeJson,
          },
        },
        transition: {
          to: target,
          reason: 'MiniMax proposed DatasetDiscovery completion and the FSM accepted the verified workspace hash.',
          variablesPatch: {
            datasetWorkspaceHash: workspace.workspaceHash,
            datasetPrimaryTextConfirmed: primaryTextConfirmed,
            phaseOutcome: outcomeJson,
          },
        },
        guardContext: {
          variables: { datasetWorkspaceHash: workspace.workspaceHash, datasetPrimaryTextConfirmed: primaryTextConfirmed, phaseOutcome: outcomeJson },
        },
      });
      const checkpoint = await new ThetaCheckpointEventRepository(runtime.eventBridge).proposeDataset({
        runId,
        sessionId,
        userId,
        workspace,
        requestedBy: 'fsm',
        rationale: primaryTextConfirmed
          ? '数据理解最终确认是进入研究对话前的强制边界。'
          : `进入研究对话前必须确认唯一主文本列。Agent 当前建议：${primaryTextCandidates(workspace).map((role) => role.column).join('、') || '尚无唯一候选'}。`,
      });
      await runtime.humanWaits.create({ commandId: `create-wait:${checkpoint.checkpointId}`, scope: runtimeScope(runId, userId, workspaceId), ownerId: 'theta-v6-checkpoint', leaseTtlMs: 30_000, waitId: `wait:${checkpoint.checkpointId}`, pendingActionRef: checkpoint.checkpointId, reason: checkpoint.summaryForUser, requestedAt: new Date().toISOString() });
      return {
        snapshot: await this.status(runId, resolvedDb),
        disposition: 'completed',
        outcome,
        toolIds,
        modelCalls,
        quanta,
      };
    } finally {
      await runtime.close();
    }
  }

  async runResearchDialogue(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ThetaResearchDialogueResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.researchDialogue) {
        throw new Error(`Run is not in ResearchDialogue: ${snapshot.currentState ?? '(none)'}.`);
      }
      if (!snapshot.datasetHash) throw new Error('Run does not contain a dataset hash.');
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const repository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const dataset = await repository.current(runId, 'dataset');
      if (!dataset || dataset.workspaceType !== 'dataset') throw new Error('DatasetWorkspace was not found.');
      const datasetRoleRecovery = await recoverDatasetRoleBoundary({
        runtime,
        scope: runtimeScope(runId, userId, workspaceId),
        workspace: dataset,
        fromState: THETA_WORKFLOW_STATES.researchDialogue,
        sessionId,
        userId,
      });
      if (datasetRoleRecovery) {
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: datasetRoleRecovery.waiting ? 'waiting_human' : 'completed',
          assistantMessage: datasetRoleRecovery.assistantMessage,
          toolIds: [],
          modelCalls: 0,
          quanta: 0,
        };
      }
      let research = await repository.current(runId, 'research');
      if (!research) {
        research = await repository.revise({
          runId,
          sessionId,
          userId,
          expectedRevision: 0,
          draft: emptyResearchWorkspace(runId, snapshot.datasetHash),
          reason: 'ResearchDialogue established its open ResearchWorkspace.',
        });
      }
      if (research.workspaceType !== 'research') throw new Error('ResearchWorkspace has the wrong type.');
      const conversationRepository = new ThetaConversationEventRepository(runtime.eventBridge);
      const conversation = await conversationRepository.digest(runId, 30);
      const events = await runtime.events.read({ scope: { userId, runId } });
      const initialMessage = initialMessageFrom(events);
      const identity = { userId, workspaceId, sessionId, runId };
      const memoryCoordinator = new ConversationMemoryCoordinator(conversationRepository, runtime.memory, identity);
      await runtime.memory.rememberDatasetWorkspace(identity, dataset, { phase: 'ResearchDialogue' });
      await runtime.memory.rememberResearchWorkspace(identity, research);
      await memoryCoordinator.synchronize('ResearchDialogue', conversation.messages);
      const latestUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user');
      const memoryEnvelope = await runtime.memory.buildContext({
        identity,
        phase: 'ResearchDialogue',
        stateId: THETA_WORKFLOW_STATES.researchDialogue,
        systemInstructions: 'You are the single THETA Agent continuing from DatasetDiscovery into an open, memory-aware ResearchDialogue.',
        currentWorkspace: research,
        relatedWorkspaces: [dataset],
        messages: conversation.messages,
        query: [latestUserMessage?.content ?? initialMessage, dataset.narrative, research.narrative, 'research intent and consequential uncertainty'].filter(Boolean).join('\n'),
      });
      const built = buildThetaPhaseContext({
        runId,
        sessionId,
        userId,
        workspaceId,
        runtimeDb: resolvedDb,
        phase: 'ResearchDialogue',
        ...(snapshot.datasetRef === undefined ? {} : { datasetRef: snapshot.datasetRef }),
        datasetHash: snapshot.datasetHash,
        workspace: research,
        memoryEnvelope,
        messages: latestUserMessage === undefined
          ? [{ role: 'user', content: initialMessage || '请结合已经探索的数据，与我一起明确值得研究的问题。' }]
          : [{ role: 'user', content: JSON.stringify({ messageId: latestUserMessage.messageId, content: latestUserMessage.content }) }],
      });
      const inference = this.inferenceProvider();
      if (!inference) throw new Error('MINIMAX_API_KEY is not configured.');
      const budget = thetaPhaseBudget('ResearchDialogue');
      const runner = new ThetaAgentRunner({
        composition: runtime,
        inference,
        artifactRoot: path.join(path.dirname(resolvedDb), 'react-artifacts'),
        quantumIterations: budget.quantumIterations,
      });
      let resume = false;
      let quanta = 0;
      const toolIds: string[] = [];
      let modelCalls = 0;
      let result: Awaited<ReturnType<ThetaAgentRunner['runQuantum']>>;
      do {
        result = await runner.runQuantum({ runId, sessionId, userId, built, budget, resume });
        quanta += 1;
        const steps = result.react?.steps ?? [];
        toolIds.push(...steps.filter((step) => step.phase === 'act').map((step) => record(step.input).target).filter((value): value is string => typeof value === 'string'));
        modelCalls += steps.filter((step) => step.phase === 'reason').length;
        resume = true;
      } while (isQuantumYield(result));
      if (result.disposition === 'waiting_human') {
        const request = result.react?.finalAction?.input;
        if (!request || typeof request !== 'object' || record(request).purpose !== 'research_question') {
          throw new Error('ResearchDialogue produced an invalid human question request.');
        }
        const question = String(record(request).question);
        const whyItMatters = String(record(request).whyItMatters);
        const assistant = await memoryCoordinator.append('ResearchDialogue', {
          runId,
          sessionId,
          userId,
          role: 'assistant',
          content: `${question}\n\n${whyItMatters}`,
          ...(latestUserMessage === undefined ? {} : { replyToMessageId: latestUserMessage.messageId }),
        });
        await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
          result: {
            kind: 'waiting',
            wait: {
              type: 'human',
              key: `research-question:${runId}:${assistant.messageId}`,
              pendingActionRef: `theta.research.question:${assistant.messageId}`,
              reason: question,
              metadata: { request: JSON.stringify(request) },
            },
          },
        });
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'waiting_human', assistantMessage: assistant.content, toolIds, modelCalls, quanta };
      }
      if (result.disposition !== 'completed') {
        const message = result.react?.error instanceof Error ? result.react.error.message : `ResearchDialogue ended with ${result.disposition}.`;
        if (result.react?.error instanceof ThetaToolCircuitOpenError) {
          await enterToolFailureRecovery(runtime, runtimeScope(runId, userId, workspaceId), result.react.error);
        }
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'recoverable_error', toolIds, modelCalls, quanta, error: message };
      }
      const outcome = result.react?.output;
      if (!isThetaPhaseOutcome(outcome) || outcome.kind !== 'phase_completion_proposed' || outcome.phase !== 'ResearchDialogue') {
        throw new Error('THETA Agent did not return a ResearchDialogue completion proposal.');
      }
      if (outcome.checkpointDecision !== 'request') {
        throw new Error('ResearchCheckpoint is mandatory; ResearchDialogue cannot skip it.');
      }
      research = await repository.current(runId, 'research');
      if (!research || research.workspaceType !== 'research' || research.workspaceHash !== outcome.artifactHash) {
        throw new Error('ResearchDialogue completion is not bound to the current ResearchWorkspace hash.');
      }
      const blocking = research.questions.filter((question) => question.status === 'open' && question.blocking);
      if (blocking.length > 0 || research.contradictions.some((contradiction) => contradiction.status === 'open')) {
        throw new Error('ResearchDialogue cannot complete while consequential questions or contradictions remain open.');
      }
      await runtime.memory.rememberResearchWorkspace(identity, research, {
        checkpointStatus: 'proposed',
      });
      const target = THETA_WORKFLOW_STATES.researchCheckpoint;
      const checkpointRepository = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const outcomeJson = structuredClone(outcome) as unknown as Record<string, string | number>;
      await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
        result: { kind: 'completed', output: outcomeJson, variablesPatch: { researchWorkspaceHash: research.workspaceHash, phaseOutcome: outcomeJson } },
        transition: {
          to: target,
          reason: 'MiniMax proposed ResearchDialogue completion and the FSM accepted the current ResearchWorkspace hash.',
          variablesPatch: { researchWorkspaceHash: research.workspaceHash, phaseOutcome: outcomeJson },
        },
        guardContext: { variables: { researchWorkspaceHash: research.workspaceHash, phaseOutcome: outcomeJson } },
      });
      const checkpoint = await checkpointRepository.proposeResearch({
        runId, sessionId, userId, workspace: research, requestedBy: 'fsm', rationale: '研究意图最终确认是进入计划设计前的强制边界。',
      });
      await runtime.humanWaits.create({
        commandId: `create-wait:${checkpoint.checkpointId}`,
        scope: runtimeScope(runId, userId, workspaceId),
        ownerId: 'theta-v7-research-checkpoint',
        leaseTtlMs: 30_000,
        waitId: `wait:${checkpoint.checkpointId}`,
        pendingActionRef: checkpoint.checkpointId,
        reason: checkpoint.summaryForUser,
        requestedAt: new Date().toISOString(),
      });
      return { snapshot: await this.status(runId, resolvedDb), disposition: 'completed', outcome, toolIds, modelCalls, quanta };
    } finally {
      await runtime.close();
    }
  }

  async runPlanDesign(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ThetaPlanDesignResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const identity = { userId, workspaceId, sessionId, runId };
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.planDesign) {
        throw new Error(`Run is not in PlanDesign: ${snapshot.currentState ?? '(none)'}.`);
      }
      if (!snapshot.datasetHash) throw new Error('Run does not contain a dataset hash.');
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const dataset = await workspaces.current(runId, 'dataset');
      const research = await workspaces.current(runId, 'research');
      if (!dataset || dataset.workspaceType !== 'dataset') throw new Error('DatasetWorkspace was not found.');
      if (!research || research.workspaceType !== 'research') throw new Error('ResearchWorkspace was not found.');
      const datasetRoleRecovery = await recoverDatasetRoleBoundary({
        runtime,
        scope: runtimeScope(runId, userId, workspaceId),
        workspace: dataset,
        fromState: THETA_WORKFLOW_STATES.planDesign,
        sessionId,
        userId,
      });
      if (datasetRoleRecovery) {
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: datasetRoleRecovery.waiting ? 'waiting_human' : 'completed',
          assistantMessage: datasetRoleRecovery.assistantMessage,
          toolIds: [],
          modelCalls: 0,
          quanta: 0,
        };
      }
      let plan = await workspaces.current(runId, 'plan');
      if (!plan || plan.workspaceType !== 'plan' || plan.researchWorkspaceHash !== research.workspaceHash) {
        plan = await workspaces.revise({
          runId,
          sessionId,
          userId,
          expectedRevision: plan?.revision ?? 0,
          draft: emptyPlanWorkspace(runId, dataset.datasetHash, research.workspaceHash),
          reason: 'PlanDesign established a workspace bound to the current Dataset and Research Workspaces.',
          invalidates: ['approval', 'dry_run', 'training_approval'],
        });
      }
      if (plan.workspaceType !== 'plan') throw new Error('PlanWorkspace has the wrong type.');
      const conversations = new ThetaConversationEventRepository(runtime.eventBridge);
      const conversation = await conversations.digest(runId, 40);
      const memoryCoordinator = new ConversationMemoryCoordinator(conversations, runtime.memory, identity);
      const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
      const priorCandidates = (await planner.candidates(runId)).slice(-6);
      await runtime.memory.rememberDatasetWorkspace(identity, dataset, { phase: 'PlanDesign' });
      await runtime.memory.rememberResearchWorkspace(identity, research);
      await runtime.memory.rememberPlanWorkspace(identity, plan);
      for (const candidate of priorCandidates) {
        await runtime.memory.rememberPlanCandidate(identity, candidate, {
          rejected: plan.activeCandidateRef !== undefined && candidate.candidateRef !== plan.activeCandidateRef,
        });
        const priorValidation = await planner.validationReceipt(runId, candidate.candidatePlanHash);
        if (priorValidation) await runtime.memory.rememberPlanValidation(identity, priorValidation);
      }
      await memoryCoordinator.synchronize('PlanDesign', conversation.messages);
      const latestUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user');
      const memoryEnvelope = await runtime.memory.buildContext({
        identity,
        phase: 'PlanDesign',
        stateId: THETA_WORKFLOW_STATES.planDesign,
        systemInstructions: 'You are the single THETA Agent continuing the same Reality into evidence-grounded, tool-governed PlanDesign.',
        currentWorkspace: plan,
        relatedWorkspaces: [dataset, research],
        messages: conversation.messages,
        query: [
          latestUserMessage?.content,
          dataset.narrative,
          research.narrative,
          ...priorCandidates.map((candidate) => `${candidate.candidateRef}: ${candidate.model.modelId}; ${candidate.rationale}`),
          'model trade-offs, executable hyperparameters, one random seed, local runtime, evidence and validation issues',
        ].filter(Boolean).join('\n'),
      });
      const built = buildThetaPhaseContext({
        runId,
        sessionId,
        userId,
        workspaceId,
        runtimeDb: resolvedDb,
        phase: 'PlanDesign',
        ...(snapshot.datasetRef === undefined ? {} : { datasetRef: snapshot.datasetRef }),
        datasetHash: snapshot.datasetHash,
        workspace: plan,
        memoryEnvelope,
        messages: [{
          role: 'user',
          content: latestUserMessage?.content ?? '请结合已验证的数据理解、研究意图、运行环境和本地证据，自主设计并验证可执行候选方案。',
        }],
      });
      const inference = this.inferenceProvider();
      if (!inference) throw new Error('MINIMAX_API_KEY is not configured.');
      const budget = thetaPhaseBudget('PlanDesign');
      const runner = new ThetaAgentRunner({
        composition: runtime,
        inference,
        artifactRoot: path.join(path.dirname(resolvedDb), 'react-artifacts'),
        quantumIterations: budget.quantumIterations,
      });
      let resume = false;
      let quanta = 0;
      const toolIds: string[] = [];
      let modelCalls = 0;
      let result: Awaited<ReturnType<ThetaAgentRunner['runQuantum']>>;
      do {
        result = await runner.runQuantum({ runId, sessionId, userId, built, budget, resume });
        quanta += 1;
        const steps = result.react?.steps ?? [];
        toolIds.push(...steps
          .filter((step) => step.phase === 'act')
          .map((step) => record(step.input).target)
          .filter((value): value is string => typeof value === 'string'));
        modelCalls += steps.filter((step) => step.phase === 'reason').length;
        resume = true;
      } while (isQuantumYield(result));
      if (result.disposition !== 'completed') {
        const message = result.react?.error instanceof Error
          ? result.react.error.message
          : `PlanDesign ended with ${result.disposition}. ${JSON.stringify(safeReactFailureSummary(result.react))}`;
        if (result.react?.error instanceof ThetaToolCircuitOpenError) {
          await enterToolFailureRecovery(runtime, runtimeScope(runId, userId, workspaceId), result.react.error);
        }
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'recoverable_error',
          toolIds,
          modelCalls,
          quanta,
          error: message,
        };
      }
      const outcome = result.react?.output;
      if (!isThetaPhaseOutcome(outcome)) throw new Error('THETA Agent did not return a legal PlanDesign outcome.');
      if (outcome.kind === 'return_to_phase_requested') {
        if (outcome.targetPhase !== 'ResearchDialogue' && outcome.targetPhase !== 'DatasetDiscovery') {
          throw new Error(`PlanDesign cannot return to ${outcome.targetPhase}.`);
        }
        const target = outcome.targetPhase === 'DatasetDiscovery'
          ? THETA_WORKFLOW_STATES.datasetDiscovery
          : THETA_WORKFLOW_STATES.researchDialogue;
        const assistant = await memoryCoordinator.append(outcome.targetPhase, {
          runId,
          sessionId,
          userId,
          role: 'assistant',
          content: outcome.targetPhase === 'DatasetDiscovery'
            ? `制定计划前发现数据绑定尚未落定：${outcome.reason}。我会返回数据探索处理，Planner 不会自行猜测列角色。`
            : `制定计划时发现一个会实质改变方案的研究决定尚未明确：${outcome.reason}`,
        });
        const outcomeJson = structuredClone(outcome) as unknown as Record<string, string | number>;
        await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
          result: { kind: 'completed', output: outcomeJson, variablesPatch: { phaseOutcome: outcomeJson } },
          transition: {
            to: target,
            reason: outcome.targetPhase === 'DatasetDiscovery'
              ? 'PlanDesign identified an unresolved dataset binding and returned control to DatasetDiscovery.'
              : 'PlanDesign identified a consequential missing research decision and returned control to the same Agent dialogue.',
            variablesPatch: {
              phaseOutcome: outcomeJson,
              ...(outcome.targetPhase === 'DatasetDiscovery' ? { datasetPrimaryTextConfirmed: false } : {}),
            },
          },
        });
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'completed',
          outcome,
          assistantMessage: assistant.content,
          toolIds,
          modelCalls,
          quanta,
        };
      }
      if (outcome.kind === 'phase_blocked') {
        return {
          snapshot: await this.status(runId, resolvedDb),
          disposition: 'recoverable_error',
          outcome,
          assistantMessage: outcome.requiredUserDecision ?? outcome.reason,
          toolIds,
          modelCalls,
          quanta,
          error: outcome.reason,
        };
      }
      if (outcome.kind !== 'phase_completion_proposed') {
        throw new Error(`PlanDesign returned an outcome reserved for another phase: ${outcome.kind}.`);
      }
      if (outcome.phase !== 'PlanDesign') throw new Error(`Unexpected phase completion: ${outcome.phase}.`);
      if (outcome.checkpointDecision !== 'request') {
        throw new Error('PlanConfirmation is mandatory; PlanDesign cannot skip it.');
      }
      plan = await workspaces.current(runId, 'plan');
      if (!plan || plan.workspaceType !== 'plan' || plan.workspaceHash !== outcome.artifactHash) {
        throw new Error('PlanDesign completion is not bound to the current PlanWorkspace hash.');
      }
      if (!plan.activeCandidateRef) throw new Error('PlanWorkspace has no active candidate.');
      const candidate = await planner.candidate(runId, plan.activeCandidateRef);
      if (!candidate) throw new Error('Active plan candidate was not found.');
      const evidenceReceipt = await planner.evidenceReceipt(runId, candidate.candidatePlanHash);
      const validationReceipt = await planner.validationReceipt(runId, candidate.candidatePlanHash);
      if (!evidenceReceipt) throw new Error('Active candidate has no EvidenceSelectionReceipt.');
      if (!validationReceipt?.valid) throw new Error('Active candidate has no valid PlanValidationReceipt.');
      if (
        (snapshot.datasetRef !== undefined && candidate.datasetRef !== snapshot.datasetRef) ||
        candidate.datasetHash !== dataset.datasetHash ||
        candidate.datasetWorkspaceHash !== dataset.workspaceHash ||
        candidate.researchWorkspaceHash !== research.workspaceHash ||
        candidate.toolContractSnapshotHash !== PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH ||
        evidenceReceipt.candidatePlanHash !== candidate.candidatePlanHash ||
        evidenceReceipt.researchWorkspaceHash !== research.workspaceHash ||
        validationReceipt.candidatePlanHash !== candidate.candidatePlanHash ||
        validationReceipt.evidenceBundleHash !== evidenceReceipt.evidenceBundleHash
      ) {
        throw new Error('PlanDesign receipts are stale or cross-bound; completion is rejected.');
      }
      await runtime.memory.rememberPlanWorkspace(identity, plan);
      await runtime.memory.rememberPlanCandidate(identity, candidate);
      await runtime.memory.rememberPlanValidation(identity, validationReceipt);
      const presentation = presentCandidatePlan(candidate, validationReceipt, { dataset, research });
      const outcomeJson = structuredClone(outcome) as unknown as Record<string, string | number>;
      const variables = {
        planWorkspaceHash: plan.workspaceHash,
        candidatePlanHash: candidate.candidatePlanHash,
        candidateDatasetHash: candidate.datasetHash,
        candidateDatasetWorkspaceHash: candidate.datasetWorkspaceHash,
        candidateResearchWorkspaceHash: candidate.researchWorkspaceHash,
        candidateToolContractSnapshotHash: candidate.toolContractSnapshotHash,
        currentDatasetHash: dataset.datasetHash,
        currentDatasetWorkspaceHash: dataset.workspaceHash,
        currentResearchWorkspaceHash: research.workspaceHash,
        currentToolContractSnapshotHash: PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH,
        evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
        validationEvidenceBundleHash: validationReceipt.evidenceBundleHash,
        validationCandidatePlanHash: validationReceipt.candidatePlanHash,
        validationReceiptHash: validationReceipt.validationReceiptHash,
        phaseOutcome: outcomeJson,
      };
      await runDatasetStateDecision(runtime, runtimeScope(runId, userId, workspaceId), {
        result: { kind: 'completed', output: outcomeJson, variablesPatch: variables },
        transition: {
          to: THETA_WORKFLOW_STATES.planConfirmation,
          reason: 'The same THETA Agent proposed a candidate and the FSM accepted exact workspace, evidence and validation bindings.',
          variablesPatch: variables,
        },
        guardContext: { variables },
      });
      const checkpoint = await new ThetaCheckpointEventRepository(runtime.eventBridge).proposePlan({
        runId,
        sessionId,
        userId,
        workspace: plan,
        candidate,
        evidenceReceipt,
        validationReceipt,
        presentation,
        rationale: 'PlanConfirmation is mandatory for every validated candidate revision.',
      });
      await runtime.humanWaits.create({
        commandId: `create-wait:${checkpoint.checkpointId}`,
        scope: runtimeScope(runId, userId, workspaceId),
        ownerId: 'theta-v9-plan-confirmation',
        leaseTtlMs: 30_000,
        waitId: `wait:${checkpoint.checkpointId}`,
        pendingActionRef: checkpoint.checkpointId,
        reason: checkpoint.summaryForUser,
        requestedAt: new Date().toISOString(),
      });
      await memoryCoordinator.handoff({
        fromPhase: 'PlanDesign',
        toPhase: 'PlanConfirmation',
        summary: presentation.summary,
        workspaceHashes: [
          dataset.workspaceHash,
          research.workspaceHash,
          plan.workspaceHash,
          candidate.candidatePlanHash,
        ],
        humanVerified: false,
      });
      return {
        snapshot: await this.status(runId, resolvedDb),
        disposition: 'completed',
        outcome,
        candidateRef: candidate.candidateRef,
        candidatePlanHash: candidate.candidatePlanHash,
        validationReceiptHash: validationReceipt.validationReceiptHash,
        evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
        planPresentation: presentation,
        toolIds,
        modelCalls,
        quanta,
      };
    } finally {
      await runtime.close();
    }
  }

  async decideCheckpoint(
    request: SubmitCheckpointDecisionRequest,
  ): Promise<ThetaCheckpointDecisionResult> {
    if (request.action === 'approve' && request.feedback?.trim()) {
      throw new Error('Choosing approve cannot include revision feedback. Choose revise and explain why instead.');
    }
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const identity = { userId, workspaceId, sessionId, runId: request.runId };
    const scope = runtimeScope(request.runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const expected = checkpointKindForState(snapshot.currentState);
      if (!expected || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting at a data, research, or plan confirmation: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      const checkpoints = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const conversations = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(conversations, runtime.memory, identity);
      const checkpoint = await checkpoints.current(request.runId, expected.kind);
      if (!checkpoint || checkpoint.status !== 'proposed') throw new Error('There is no active checkpoint that can be decided.');
      if (checkpoint.checkpointId !== request.checkpointId) throw new Error('Checkpoint decision targets a stale checkpoint id.');
      if (checkpoint.contentHash !== request.expectedContentHash) throw new Error('Checkpoint decision targets a stale content hash.');
      const decisionId = `checkpoint-decision:${checkpoint.checkpointId}:${request.action}:${hashCanonicalJson({ userId, contentHash: checkpoint.contentHash })}`;

      if (request.action === 'revise') {
        const feedback = request.feedback?.trim();
        if (!feedback) throw new Error('Choosing revise requires a non-empty natural-language explanation.');
        const message = await memoryCoordinator.append(expected.memoryPhase, {
          runId: request.runId,
          sessionId,
          userId,
          role: 'user',
          content: feedback,
          messageId: decisionId,
        });
        const changed = await checkpoints.changeStatus({
          runId: request.runId,
          sessionId,
          userId,
          checkpointId: checkpoint.checkpointId,
          expectedContentHash: checkpoint.contentHash,
          status: 'revising',
          messageId: message.messageId,
          reason: feedback,
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'rejected');
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: { checkpointFeedbackMessageId: message.messageId } },
          transition: {
            to: expected.revisionTarget,
            reason: `${expected.kind} checkpoint revision feedback returns to the owning intelligent phase.`,
            variablesPatch: { checkpointFeedbackMessageId: message.messageId },
          },
        });
        await recordCheckpointDecisionActivity(runtime, {
          runId: request.runId,
          sessionId,
          userId,
          phase: snapshot.currentState ?? expected.kind,
          action: 'revise',
          message: '已记录修改原因，MiniMax 将在原阶段结合上下文继续修订',
        });
        const continuation = expected.kind === 'dataset'
          ? await this.runDatasetDiscovery(request.runId, resolvedDb)
          : expected.kind === 'research'
            ? await this.runResearchDialogue(request.runId, resolvedDb)
            : await this.runPlanDesign(request.runId, resolvedDb);
        return {
          snapshot: continuation.snapshot,
          action: 'revise',
          checkpoint: changed,
          assistantMessage: '已记录你的修改原因，并交回同一个 THETA Agent 继续修订。',
          modelCalls: continuation.modelCalls,
          toolIds: continuation.toolIds,
          continuation,
        };
      }

      if (expected.kind === 'dataset') {
        const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
        const current = await workspaces.current(request.runId, 'dataset');
        if (!current || current.workspaceType !== 'dataset' || current.workspaceHash !== checkpoint.targetHash) {
          throw new Error('Dataset checkpoint is stale relative to the current DatasetWorkspace.');
        }
        if (primaryTextCandidates(current).length !== 1) {
          throw new Error('当前没有唯一主文本列候选，不能选择“是”。请选择“否，说明原因”并明确正文列。');
        }
        let acceptedWorkspace = current;
        let checkpointToConfirm = checkpoint;
        if (!hasUniqueConfirmedPrimaryTextColumn(current)) {
          await checkpoints.changeStatus({
            runId: request.runId,
            sessionId,
            userId,
            checkpointId: checkpoint.checkpointId,
            expectedContentHash: checkpoint.contentHash,
            status: 'invalidated',
            messageId: decisionId,
            reason: 'Direct user approval promotes the single recommended primary text role into a new provenance-bound workspace revision.',
          });
          acceptedWorkspace = await workspaces.revise({
            runId: request.runId,
            sessionId,
            userId,
            expectedRevision: current.revision,
            draft: confirmUniquePrimaryTextRole(current, {
              id: decisionId,
              kind: 'user_decision',
              hash: hashCanonicalJson({ action: 'approve', checkpointId: checkpoint.checkpointId, contentHash: checkpoint.contentHash, userId }),
            }),
            reason: 'The user selected “yes” and accepted the Agent recommended unique primary text column.',
            invalidates: ['plan', 'approval', 'dry_run', 'training_approval'],
          }) as DatasetWorkspace;
          checkpointToConfirm = await checkpoints.proposeDataset({
            runId: request.runId,
            sessionId,
            userId,
            workspace: acceptedWorkspace,
            requestedBy: 'fsm',
            rationale: 'Bind direct user approval to the promoted unique primary text role.',
          });
        }
        const approvalMessage = await memoryCoordinator.append('DatasetDiscovery', {
          runId: request.runId,
          sessionId,
          userId,
          role: 'user',
          content: '我确认当前数据理解，进入下一阶段。',
          messageId: decisionId,
        });
        const confirmed = await checkpoints.changeStatus({
          runId: request.runId,
          sessionId,
          userId,
          checkpointId: checkpointToConfirm.checkpointId,
          expectedContentHash: checkpointToConfirm.contentHash,
          status: 'confirmed',
          messageId: approvalMessage.messageId,
          reason: 'The user selected “yes, enter the next phase”; no language model interpreted this approval.',
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
        const variables = {
          datasetWorkspaceHash: acceptedWorkspace.workspaceHash,
          datasetPrimaryTextConfirmed: true,
          datasetCheckpointStatus: 'confirmed',
          datasetCheckpointTargetHash: confirmed.targetHash,
        };
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: variables },
          transition: { to: THETA_WORKFLOW_STATES.researchDialogue, reason: 'Direct user approval confirmed the current dataset checkpoint and unique primary text role.', variablesPatch: variables },
          guardContext: { variables },
        });
        await runtime.memory.rememberDatasetWorkspace(identity, acceptedWorkspace, { checkpointStatus: 'confirmed', humanVerified: true });
        await memoryCoordinator.handoff({
          fromPhase: 'DatasetDiscovery',
          toPhase: 'ResearchDialogue',
          summary: acceptedWorkspace.narrative,
          workspaceHashes: [acceptedWorkspace.workspaceHash, acceptedWorkspace.datasetHash],
          humanVerified: true,
        });
        await recordCheckpointDecisionActivity(runtime, { runId: request.runId, sessionId, userId, phase: THETA_WORKFLOW_STATES.datasetCheckpoint, action: 'approve', message: '已确认数据理解，未调用 MiniMax' });
        return { snapshot: await this.status(request.runId, resolvedDb), action: 'approve', checkpoint: confirmed, assistantMessage: '已确认数据理解，正在进入研究意图阶段。', modelCalls: 0, toolIds: [] };
      }

      if (expected.kind === 'research') {
        const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
        const current = await workspaces.current(request.runId, 'research');
        if (!current || current.workspaceType !== 'research' || current.workspaceHash !== checkpoint.targetHash) {
          throw new Error('Research checkpoint is stale relative to the current ResearchWorkspace.');
        }
        const blockers = [
          ...current.contradictions.filter((item) => item.status === 'open').map((item) => item.description),
          ...current.questions.filter((item) => item.blocking && item.status === 'open').map((item) => item.question),
        ];
        if (blockers.length > 0) throw new Error('研究意图仍存在未解决的关键矛盾，不能选择“是”。请选择“否，说明原因”。');
        const approvalMessage = await memoryCoordinator.append('ResearchDialogue', {
          runId: request.runId,
          sessionId,
          userId,
          role: 'user',
          content: '我确认当前研究意图，进入下一阶段。',
          messageId: decisionId,
        });
        const confirmed = await checkpoints.changeStatus({
          runId: request.runId,
          sessionId,
          userId,
          checkpointId: checkpoint.checkpointId,
          expectedContentHash: checkpoint.contentHash,
          status: 'confirmed',
          messageId: approvalMessage.messageId,
          reason: 'The user directly approved the current research synthesis; no language model interpreted this approval.',
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
        const variables = { researchWorkspaceHash: current.workspaceHash, researchCheckpointStatus: 'confirmed', researchCheckpointTargetHash: confirmed.targetHash, researchBlockingIssuesResolved: true };
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: variables },
          transition: { to: THETA_WORKFLOW_STATES.planDesign, reason: 'Direct user approval confirmed the current ResearchWorkspace hash.', variablesPatch: variables },
          guardContext: { variables },
        });
        await runtime.memory.rememberResearchWorkspace(identity, current, { checkpointStatus: 'confirmed', humanVerified: true });
        const datasetWorkspace = await workspaces.current(request.runId, 'dataset');
        await memoryCoordinator.handoff({
          fromPhase: 'ResearchDialogue',
          toPhase: 'PlanDesign',
          summary: current.narrative,
          workspaceHashes: [
            ...(datasetWorkspace?.workspaceType === 'dataset' ? [datasetWorkspace.workspaceHash] : []),
            current.workspaceHash,
          ],
          humanVerified: true,
        });
        await recordCheckpointDecisionActivity(runtime, { runId: request.runId, sessionId, userId, phase: THETA_WORKFLOW_STATES.researchCheckpoint, action: 'approve', message: '已确认研究意图，未调用 MiniMax' });
        return { snapshot: await this.status(request.runId, resolvedDb), action: 'approve', checkpoint: confirmed, assistantMessage: '已确认研究意图，正在进入计划设计阶段。', modelCalls: 0, toolIds: [] };
      }

      const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const dataset = await workspaces.current(request.runId, 'dataset');
      const research = await workspaces.current(request.runId, 'research');
      const plan = await workspaces.current(request.runId, 'plan');
      if (!dataset || dataset.workspaceType !== 'dataset' || !research || research.workspaceType !== 'research' || !plan || plan.workspaceType !== 'plan' || !plan.activeCandidateRef) {
        throw new Error('Plan confirmation cannot reconstruct its current workspace chain.');
      }
      const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
      const candidate = await planner.candidate(request.runId, plan.activeCandidateRef);
      if (!candidate || candidate.candidatePlanHash !== checkpoint.targetHash || candidate.candidateRef !== checkpoint.targetWorkspaceRef) {
        throw new Error('Plan checkpoint is stale relative to the active candidate.');
      }
      const evidenceReceipt = await planner.evidenceReceipt(request.runId, candidate.candidatePlanHash);
      const validationReceipt = await planner.validationReceipt(request.runId, candidate.candidatePlanHash);
      if (!evidenceReceipt || !validationReceipt?.valid || validationReceipt.evidenceBundleHash !== evidenceReceipt.evidenceBundleHash) {
        throw new Error('Plan checkpoint receipts are missing, invalid, or stale.');
      }
      const approvalMessage = await memoryCoordinator.append('PlanConfirmation', {
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: '我确认当前训练计划，进入下一阶段。',
        messageId: decisionId,
      });
      const material = {
        receiptId: `plan-approval:${randomUUID()}`,
        runId: request.runId,
        checkpointId: checkpoint.checkpointId,
        checkpointContentHash: checkpoint.contentHash,
        candidateRef: candidate.candidateRef,
        candidatePlanHash: candidate.candidatePlanHash,
        planWorkspaceHash: plan.workspaceHash,
        validationReceiptHash: validationReceipt.validationReceiptHash,
        evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
        principalId: userId,
        messageId: approvalMessage.messageId,
      };
      const approvalReceipt: PlanApprovalReceipt = { ...material, approvedAt: new Date().toISOString(), planApprovalHash: planApprovalReceiptHash(material) };
      await planner.recordApproval({ runId: request.runId, sessionId, userId, receipt: approvalReceipt });
      await runtime.memory.rememberPlanApproval(identity, approvalReceipt);
      const confirmed = await checkpoints.changeStatus({
        runId: request.runId,
        sessionId,
        userId,
        checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash,
        status: 'confirmed',
        messageId: approvalMessage.messageId,
        reason: 'The owner directly approved the exact current candidate hash; no language model interpreted this approval.',
      });
      await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
      const variables = {
        planApprovalHash: approvalReceipt.planApprovalHash,
        approvedPlanHash: approvalReceipt.candidatePlanHash,
        planApprovalCandidateHash: approvalReceipt.candidatePlanHash,
        planApprovalWorkspaceHash: approvalReceipt.planWorkspaceHash,
        planApprovalValidationHash: approvalReceipt.validationReceiptHash,
        planApprovalEvidenceHash: approvalReceipt.evidenceBundleHash,
        planApprovalCheckpointHash: approvalReceipt.checkpointContentHash,
        planCheckpointContentHash: checkpoint.contentHash,
        approvalPrincipalId: approvalReceipt.principalId,
        candidatePlanHash: candidate.candidatePlanHash,
        planWorkspaceHash: plan.workspaceHash,
        validationReceiptHash: validationReceipt.validationReceiptHash,
        evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
      };
      await runDatasetStateDecision(runtime, scope, {
        result: { kind: 'completed', variablesPatch: variables },
        transition: { to: THETA_WORKFLOW_STATES.createPlan, reason: 'Direct owner approval produced an exact principal-bound PlanApprovalReceipt.', variablesPatch: variables },
        guardContext: { variables },
      });
      await recordCheckpointDecisionActivity(runtime, { runId: request.runId, sessionId, userId, phase: THETA_WORKFLOW_STATES.planConfirmation, action: 'approve', message: '已确认训练计划，未调用 MiniMax' });
      return { snapshot: await this.status(request.runId, resolvedDb), action: 'approve', checkpoint: confirmed, assistantMessage: '已确认当前计划，正在进入可执行计划生成阶段。', modelCalls: 0, toolIds: [], approvalReceipt };
    } finally {
      await runtime.close();
    }
  }

  async submitPlanConfirmationMessage(
    request: SubmitCheckpointMessageRequest,
  ): Promise<ThetaPlanConfirmationMessageResult> {
    rejectNaturalLanguageCheckpointDecision('PlanConfirmation');
    /* Legacy implementation is intentionally unreachable until removed after downstream callers migrate. */
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const identity = { userId, workspaceId, sessionId, runId: request.runId };
    const scope = runtimeScope(request.runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.planConfirmation || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting at PlanConfirmation: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const checkpoints = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const checkpoint = await checkpoints.current(request.runId, 'plan');
      if (!checkpoint || !['proposed', 'revising'].includes(checkpoint.status) || !checkpoint.mandatory) {
        throw new Error('There is no active mandatory PlanCheckpoint.');
      }
      const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const dataset = await workspaces.current(request.runId, 'dataset');
      const research = await workspaces.current(request.runId, 'research');
      const plan = await workspaces.current(request.runId, 'plan');
      if (!dataset || dataset.workspaceType !== 'dataset' || !research || research.workspaceType !== 'research' || !plan || plan.workspaceType !== 'plan') {
        throw new Error('PlanConfirmation cannot reconstruct its current workspace chain.');
      }
      if (!plan.activeCandidateRef) throw new Error('PlanWorkspace has no active candidate.');
      const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
      const candidate = await planner.candidate(request.runId, plan.activeCandidateRef);
      if (!candidate || candidate.candidatePlanHash !== checkpoint.targetHash || candidate.candidateRef !== checkpoint.targetWorkspaceRef) {
        throw new Error('PlanCheckpoint is stale relative to the active candidate.');
      }
      const evidenceReceipt = await planner.evidenceReceipt(request.runId, candidate.candidatePlanHash);
      const validationReceipt = await planner.validationReceipt(request.runId, candidate.candidatePlanHash);
      if (!evidenceReceipt || !validationReceipt?.valid || validationReceipt.evidenceBundleHash !== evidenceReceipt.evidenceBundleHash) {
        throw new Error('PlanCheckpoint receipts are missing, invalid, or stale.');
      }
      const messages = new ThetaConversationEventRepository(runtime.eventBridge);
      const userMessage = await messages.append({
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: request.content,
        messageId: request.messageId,
      });
      const conversation = await messages.digest(request.runId, 40);
      await runtime.memory.rememberDatasetWorkspace(identity, dataset, { phase: 'PlanConfirmation' });
      await runtime.memory.rememberResearchWorkspace(identity, research);
      await runtime.memory.rememberPlanWorkspace(identity, plan);
      await runtime.memory.rememberPlanCandidate(identity, candidate);
      await runtime.memory.rememberPlanValidation(identity, validationReceipt);
      for (const item of conversation.messages.slice(-12)) await runtime.memory.rememberMessage(identity, 'PlanConfirmation', item);
      const memoryEnvelope = await runtime.memory.buildContext({
        identity,
        phase: 'PlanConfirmation',
        stateId: THETA_WORKFLOW_STATES.planConfirmation,
        systemInstructions: 'You are the same THETA Agent conducting mandatory, exact-hash PlanConfirmation with read-only tools.',
        currentWorkspace: plan,
        relatedWorkspaces: [dataset, research],
        messages: conversation.messages,
        query: [userMessage.content, checkpoint.summaryForUser, candidate.rationale, 'plan confirmation, evidence, trade-offs, requested revisions'].join('\n'),
      });
      const built = buildThetaPhaseContext({
        runId: request.runId,
        sessionId,
        userId,
        workspaceId,
        runtimeDb: resolvedDb,
        phase: 'PlanConfirmation',
        ...(snapshot.datasetRef === undefined ? {} : { datasetRef: snapshot.datasetRef }),
        datasetHash: snapshot.datasetHash ?? dataset.datasetHash,
        workspace: plan,
        memoryEnvelope,
        messages: [
          { role: 'system', content: JSON.stringify({ mandatoryPlanCheckpoint: checkpoint, exactCurrentCandidateHash: candidate.candidatePlanHash }) },
          { role: 'user', content: JSON.stringify({ messageId: userMessage.messageId, content: userMessage.content }) },
        ],
      });
      const inference = this.inferenceProvider();
      if (!inference) throw new Error('MINIMAX_API_KEY is not configured.');
      const budget = thetaPhaseBudget('PlanConfirmation');
      const runner = new ThetaAgentRunner({ composition: runtime, inference, artifactRoot: path.join(path.dirname(resolvedDb), 'react-artifacts'), quantumIterations: budget.quantumIterations });
      let resume = false;
      let quanta = 0;
      const toolIds: string[] = [];
      let modelCalls = 0;
      let result: Awaited<ReturnType<ThetaAgentRunner['runQuantum']>>;
      do {
        result = await runner.runQuantum({ runId: request.runId, sessionId, userId, built, budget, resume });
        quanta += 1;
        const steps = result.react?.steps ?? [];
        toolIds.push(...steps.filter((step) => step.phase === 'act').map((step) => record(step.input).target).filter((value): value is string => typeof value === 'string'));
        modelCalls += steps.filter((step) => step.phase === 'reason').length;
        resume = true;
      } while (isQuantumYield(result));
      if (result.disposition !== 'completed') {
        if (result.react?.error instanceof ThetaToolCircuitOpenError) {
          await enterToolFailureRecovery(runtime, scope, result.react.error);
        }
        throw new Error(result.react?.error instanceof Error ? result.react.error.message : `PlanConfirmation ended with ${result.disposition}.`);
      }
      const output = result.react?.output;
      if (!isThetaPhaseOutcome(output) || output.kind !== 'plan_confirmation_decision') {
        throw new Error('THETA Agent did not return a legal PlanConfirmation decision.');
      }
      let decision: ThetaPlanConfirmationDecision = output;
      if (decision.action === 'confirm_checkpoint') {
        if (decision.targetHash !== checkpoint.targetHash) throw new Error('Plan confirmation targeted a stale or invented candidate hash.');
        const verification = await runVisibleLanguageStep(runtime, {
          runId: request.runId,
          sessionId,
          userId,
          phase: THETA_WORKFLOW_STATES.planConfirmation,
          displayName: '复核计划确认',
          runningMessage: 'MiniMax 正在判断你的回复是否无条件确认当前计划',
          completedMessage: 'MiniMax 已完成计划确认语义复核',
        }, () => new MiniMaxPlanConfirmationVerifier(inference).verify({
          runId: request.runId,
          messageId: userMessage.messageId,
          message: userMessage.content,
          targetHash: checkpoint.targetHash,
          checkpointSummary: checkpoint.summaryForUser,
        }));
        modelCalls += 1;
        if (!verification.unqualifiedAcceptance) {
          decision = {
            kind: 'plan_confirmation_decision',
            action: 'ask_about_checkpoint',
            question: '你的回复似乎还包含条件、问题或修改意图。请先说明希望修改什么；如果无需修改，请明确确认当前方案。',
            responseToUser: `当前没有批准方案：${verification.rationale}`,
          };
        }
      }
      const assistant = await messages.append({ runId: request.runId, sessionId, userId, role: 'assistant', content: decision.responseToUser, replyToMessageId: userMessage.messageId });
      await runtime.memory.rememberMessage(identity, 'PlanConfirmation', assistant);
      if (decision.action === 'ask_about_checkpoint') {
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint, assistantMessage: assistant.content, toolIds, modelCalls, quanta };
      }
      if (decision.action === 'confirm_checkpoint') {
        const material = {
          receiptId: `plan-approval:${randomUUID()}`,
          runId: request.runId,
          checkpointId: checkpoint.checkpointId,
          checkpointContentHash: checkpoint.contentHash,
          candidateRef: candidate.candidateRef,
          candidatePlanHash: candidate.candidatePlanHash,
          planWorkspaceHash: plan.workspaceHash,
          validationReceiptHash: validationReceipt.validationReceiptHash,
          evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
          principalId: userId,
          messageId: userMessage.messageId,
        };
        const approvalReceipt: PlanApprovalReceipt = {
          ...material,
          approvedAt: new Date().toISOString(),
          planApprovalHash: planApprovalReceiptHash(material),
        };
        await planner.recordApproval({ runId: request.runId, sessionId, userId, receipt: approvalReceipt });
        await runtime.memory.rememberPlanApproval(identity, approvalReceipt);
        const confirmed = await checkpoints.changeStatus({
          runId: request.runId,
          sessionId,
          userId,
          checkpointId: checkpoint.checkpointId,
          expectedContentHash: checkpoint.contentHash,
          status: 'confirmed',
          messageId: userMessage.messageId,
          reason: 'The current owner clearly and unconditionally confirmed the exact current candidate hash; an independent semantic verifier agreed.',
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
        const variables = {
          planApprovalHash: approvalReceipt.planApprovalHash,
          approvedPlanHash: approvalReceipt.candidatePlanHash,
          planApprovalCandidateHash: approvalReceipt.candidatePlanHash,
          planApprovalWorkspaceHash: approvalReceipt.planWorkspaceHash,
          planApprovalValidationHash: approvalReceipt.validationReceiptHash,
          planApprovalEvidenceHash: approvalReceipt.evidenceBundleHash,
          planApprovalCheckpointHash: approvalReceipt.checkpointContentHash,
          planCheckpointContentHash: checkpoint.contentHash,
          approvalPrincipalId: approvalReceipt.principalId,
          candidatePlanHash: candidate.candidatePlanHash,
          planWorkspaceHash: plan.workspaceHash,
          validationReceiptHash: validationReceipt.validationReceiptHash,
          evidenceBundleHash: evidenceReceipt.evidenceBundleHash,
        };
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: variables },
          transition: { to: THETA_WORKFLOW_STATES.createPlan, reason: 'A principal-bound PlanApprovalReceipt matches the exact current candidate hash chain.', variablesPatch: variables },
          guardContext: { variables },
        });
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint: confirmed, assistantMessage: assistant.content, approvalReceipt, toolIds, modelCalls, quanta };
      }
      const reason = decision.action === 'revise_checkpoint' ? decision.requestedChanges : decision.reason;
      const changed = await checkpoints.changeStatus({
        runId: request.runId,
        sessionId,
        userId,
        checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash,
        status: decision.action === 'reject_checkpoint' ? 'rejected' : 'revising',
        messageId: userMessage.messageId,
        reason: reason ?? 'The user requested a new plan design revision.',
      });
      await resolveHumanWait(runtime, scope, snapshot, userId, 'rejected');
      await runDatasetStateDecision(runtime, scope, {
        result: { kind: 'completed', variablesPatch: { planCheckpointFeedbackMessageId: userMessage.messageId } },
        transition: { to: THETA_WORKFLOW_STATES.planDesign, reason: 'PlanConfirmation feedback requires a new candidate, validation receipt, optional-citation audit receipt and checkpoint hash.', variablesPatch: { planCheckpointFeedbackMessageId: userMessage.messageId } },
      });
      return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint: changed, assistantMessage: assistant.content, toolIds, modelCalls, quanta };
    } finally {
      await runtime.close();
    }
  }

  /**
   * Compile the exact approved candidate and run a side-effect-free training
   * preflight. This method deliberately stops at TrainingConfirmation: it can
   * never grant training approval or start a worker process.
   */
  async prepareTraining(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ThetaTrainingPreparationResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const scope = runtimeScope(runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    const activities = new ThetaActivityEventRepository(runtime.eventBridge);
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const toolIds: string[] = [];
    try {
      let snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.createPlan &&
          snapshot.currentState !== THETA_WORKFLOW_STATES.dryRun &&
          snapshot.currentState !== THETA_WORKFLOW_STATES.trainingConfirmation) {
        throw new Error(`Run cannot prepare training from ${snapshot.currentState ?? '(none)'}. Confirm the current plan first.`);
      }
      if (!snapshot.datasetHash) throw new Error('Run does not contain the current dataset hash.');

      if (snapshot.currentState === THETA_WORKFLOW_STATES.createPlan) {
        const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
        const candidate = (await planner.candidates(runId)).at(-1);
        if (!candidate) throw new Error('CreatePlan has no CandidatePlan to compile.');
        const approval = await planner.approvalReceipt(runId, candidate.candidatePlanHash);
        if (!approval) throw new Error('CreatePlan requires a human PlanApprovalReceipt for the current candidate.');
        const activityId = `tool:${runId}:create-plan:${candidate.candidatePlanHash}`;
        await activities.record({
          runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.createPlan,
          kind: 'tool_started', toolId: THETA_TOOL_IDS.planCreate,
          displayName: '生成可执行训练计划', userMessage: '正在把已确认方案编译为唯一的可执行计划。', status: 'running',
          safeInputSummary: `candidateRef=${candidate.candidateRef}`,
        });
        const result = await runGovernedStateTool(runtime, {
          runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb,
          state: THETA_WORKFLOW_STATES.createPlan,
          toolId: THETA_TOOL_IDS.planCreate,
          input: { candidateRef: candidate.candidateRef, expectedPlanApprovalHash: approval.planApprovalHash },
          emitActivity: false,
        });
        toolIds.push(THETA_TOOL_IDS.planCreate);
        if (result.status !== 'completed') {
          const failureMessage = toolFailureMessage(result);
          const target = /DATASET_|dataset hash|dataset reference|UNKNOWN_DATASET_COLUMN/iu.test(failureMessage)
            ? THETA_WORKFLOW_STATES.datasetDiscovery
            : THETA_WORKFLOW_STATES.planDesign;
          await activities.record({
            runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.createPlan,
            kind: 'tool_failed', toolId: THETA_TOOL_IDS.planCreate,
            displayName: '生成可执行训练计划', userMessage: target === THETA_WORKFLOW_STATES.datasetDiscovery
              ? '数据绑定已变化，已返回数据理解阶段。'
              : '可执行计划生成失败，已返回计划设计阶段。', status: 'failed',
            safeOutputSummary: failureMessage, completedAt: new Date().toISOString(),
          });
          await runDatasetStateDecision(runtime, scope, {
            result: { kind: 'completed', variablesPatch: { preparationFailure: failureMessage } },
            transition: { to: target, reason: 'Canonical Plan compilation failed without starting training.' },
          });
          return {
            snapshot: await this.status(runId, resolvedDb),
            disposition: target === THETA_WORKFLOW_STATES.datasetDiscovery ? 'returned_to_dataset' : 'returned_to_plan',
            summary: `无法生成可执行计划：${failureMessage}`,
            toolIds,
          };
        }
        const output = completedToolOutput(result);
        const planId = requiredOutputText(output.planId, 'planId');
        const planHash = requiredOutputText(output.planHash, 'planHash');
        const datasetHash = requiredOutputText(output.datasetHash, 'datasetHash');
        const variables = {
          candidatePlanHash: candidate.candidatePlanHash,
          planApprovalHash: approval.planApprovalHash,
          currentDatasetHash: snapshot.datasetHash,
          canonicalPlanId: planId,
          canonicalPlanHash: planHash,
          canonicalPlanCandidateHash: requiredOutputText(output.candidatePlanHash, 'candidatePlanHash'),
          canonicalPlanApprovalHash: requiredOutputText(output.planApprovalHash, 'planApprovalHash'),
          canonicalPlanDatasetHash: `sha256:${datasetHash}`,
        };
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: variables },
          transition: {
            to: THETA_WORKFLOW_STATES.dryRun,
            reason: 'The governed plan.create Tool produced an exact approved Canonical Plan hash.',
            variablesPatch: variables,
          },
          guardContext: { variables },
        });
        await activities.record({
          runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.createPlan,
          kind: 'tool_completed', toolId: THETA_TOOL_IDS.planCreate,
          displayName: '生成可执行训练计划', userMessage: '可执行训练计划已生成并完成哈希绑定。', status: 'completed',
          safeOutputSummary: `planId=${planId}; planHash=${planHash}`, completedAt: new Date().toISOString(),
        });
        snapshot = await this.status(runId, resolvedDb);
      }

      if (snapshot.currentState === THETA_WORKFLOW_STATES.dryRun) {
        const canonical = await execution.currentCanonicalPlan(runId);
        if (!canonical) throw new Error('DryRun has no persisted Canonical Plan.');
        const { planId, planHash } = canonical.canonicalPlanRecord;
        const activityId = `tool:${runId}:dry-run:${planHash}`;
        await activities.record({
          runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.dryRun,
          kind: 'tool_started', toolId: THETA_TOOL_IDS.trainingDryRun,
          displayName: '执行训练前检查', userMessage: '正在检查数据、依赖、命令和预期产物；不会启动训练。', status: 'running',
          safeInputSummary: `planId=${planId}; planHash=${planHash}`,
        });
        const result = await runGovernedStateTool(runtime, {
          runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb,
          state: THETA_WORKFLOW_STATES.dryRun,
          toolId: THETA_TOOL_IDS.trainingDryRun,
          input: { planId, expectedPlanHash: planHash },
          emitActivity: false,
        });
        toolIds.push(THETA_TOOL_IDS.trainingDryRun);
        if (result.status !== 'completed') {
          const failureMessage = toolFailureMessage(result);
          const target = /DATASET_|dataset hash|dataset reference|dataset file|UNKNOWN_DATASET_COLUMN/iu.test(failureMessage)
            ? THETA_WORKFLOW_STATES.datasetDiscovery
            : THETA_WORKFLOW_STATES.humanRecovery;
          await activities.record({
            runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.dryRun,
            kind: 'tool_failed', toolId: THETA_TOOL_IDS.trainingDryRun,
            displayName: '执行训练前检查', userMessage: target === THETA_WORKFLOW_STATES.datasetDiscovery
              ? '数据文件或哈希已变化，已返回数据理解阶段。'
              : '训练前检查未能完成，需要人工修复运行环境。', status: 'failed',
            safeOutputSummary: failureMessage, completedAt: new Date().toISOString(),
          });
          await runDatasetStateDecision(runtime, scope, {
            result: { kind: 'completed', variablesPatch: { preparationFailure: failureMessage } },
            transition: { to: target, reason: 'DryRun Tool failed before any training side effect.' },
          });
          return {
            snapshot: await this.status(runId, resolvedDb),
            disposition: target === THETA_WORKFLOW_STATES.datasetDiscovery ? 'returned_to_dataset' : 'human_recovery',
            canonicalPlan: canonical,
            summary: `训练前检查未完成：${failureMessage}`,
            toolIds,
          };
        }
        const output = completedToolOutput(result);
        const receipt = (await execution.currentDryRun(runId, planHash));
        if (!receipt || record(output.receipt).dryRunHash !== receipt.dryRunHash) {
          throw new Error('DryRun Tool output is not bound to the persisted DryRunReceipt.');
        }
        const variables = {
          currentDatasetHash: `sha256:${canonical.canonicalPlanRecord.canonicalPlan.datasetSha256}`,
          canonicalPlanHash: planHash,
          dryRunHash: receipt.dryRunHash,
          dryRunPlanHash: receipt.planHash,
          dryRunDatasetHash: `sha256:${receipt.datasetHash}`,
          dryRunPassed: receipt.passed,
        };
        if (!receipt.passed) {
          const target = dryRunRecoveryTarget(receipt);
          await runDatasetStateDecision(runtime, scope, {
            result: { kind: 'completed', variablesPatch: variables },
            transition: { to: target, reason: 'DryRun failed and returned to its structured recovery target.', variablesPatch: variables },
          });
          await activities.record({
            runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.dryRun,
            kind: 'tool_failed', toolId: THETA_TOOL_IDS.trainingDryRun,
            displayName: '执行训练前检查', userMessage: dryRunRecoverySummary(receipt), status: 'failed',
            safeOutputSummary: failedDryRunCodes(receipt), completedAt: new Date().toISOString(),
          });
          return {
            snapshot: await this.status(runId, resolvedDb),
            disposition: target === THETA_WORKFLOW_STATES.datasetDiscovery
              ? 'returned_to_dataset'
              : target === THETA_WORKFLOW_STATES.planDesign
                ? 'returned_to_plan'
                : 'human_recovery',
            canonicalPlan: canonical,
            dryRun: receipt,
            summary: dryRunRecoverySummary(receipt),
            toolIds,
          };
        }
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: variables },
          transition: {
            to: THETA_WORKFLOW_STATES.trainingConfirmation,
            reason: 'DryRun passed for the exact Canonical Plan and current dataset hashes.',
            variablesPatch: variables,
          },
          guardContext: { variables },
        });
        await activities.record({
          runId, sessionId, userId, activityId, phase: THETA_WORKFLOW_STATES.dryRun,
          kind: 'tool_completed', toolId: THETA_TOOL_IDS.trainingDryRun,
          displayName: '执行训练前检查', userMessage: '训练前检查已通过；训练仍未启动。', status: 'completed',
          safeOutputSummary: `dryRunHash=${receipt.dryRunHash}; checks=${receipt.checks.length}`, completedAt: new Date().toISOString(),
        });
        snapshot = await this.status(runId, resolvedDb);
        const trainingCheckpoint = await ensureTrainingCheckpoint(runtime, {
          runId, sessionId, userId,
          planRecord: canonical.canonicalPlanRecord,
          dryRun: receipt,
        });
        if (snapshot.status !== 'waiting_human') {
          await runtime.humanWaits.create({
            commandId: `create-training-wait:${runId}:${receipt.dryRunHash}`,
            scope,
            ownerId: 'theta-v10b-training-confirmation',
            leaseTtlMs: 30_000,
            waitId: `wait:training:${runId}:${receipt.dryRunHash}`,
            pendingActionRef: trainingCheckpoint.checkpointId,
            reason: trainingCheckpoint.summaryForUser,
            requestedAt: new Date().toISOString(),
          });
        }
      }

      const canonical = await execution.currentCanonicalPlan(runId);
      const dryRun = canonical === null ? null : await execution.currentDryRun(runId, canonical.canonicalPlanRecord.planHash);
      const readySnapshot = await this.status(runId, resolvedDb);
      if (
        readySnapshot.currentState === THETA_WORKFLOW_STATES.trainingConfirmation &&
        readySnapshot.status !== 'waiting_human' &&
        dryRun?.passed === true
      ) {
        const trainingCheckpoint = await ensureTrainingCheckpoint(runtime, {
          runId, sessionId, userId,
          planRecord: canonical!.canonicalPlanRecord,
          dryRun,
        });
        await runtime.humanWaits.create({
          commandId: `create-training-wait:${runId}:${dryRun.dryRunHash}`,
          scope,
          ownerId: 'theta-v10b-training-confirmation',
          leaseTtlMs: 30_000,
          waitId: `wait:training:${runId}:${dryRun.dryRunHash}`,
          pendingActionRef: trainingCheckpoint.checkpointId,
          reason: trainingCheckpoint.summaryForUser,
          requestedAt: new Date().toISOString(),
        });
      }
      return {
        snapshot: await this.status(runId, resolvedDb),
        disposition: 'ready_for_training_confirmation',
        ...(canonical === null ? {} : { canonicalPlan: canonical }),
        ...(dryRun === null ? {} : { dryRun }),
        summary: '可执行计划和训练前检查均已就绪，正在等待独立的训练启动确认；尚未开始训练。',
        toolIds,
      };
    } finally {
      await runtime.close();
    }
  }

  async submitTrainingConfirmationMessage(request: SubmitCheckpointMessageRequest): Promise<ThetaTrainingConfirmationMessageResult> {
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const scope = runtimeScope(request.runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.trainingConfirmation || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting at TrainingConfirmation: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      const checkpoints = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const checkpoint = await checkpoints.current(request.runId, 'training');
      if (!checkpoint || !['proposed', 'revising'].includes(checkpoint.status)) throw new Error('There is no active TrainingCheckpoint.');
      const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
      const canonical = await execution.currentCanonicalPlan(request.runId);
      const dryRun = canonical === null ? null : await execution.currentDryRun(request.runId, canonical.canonicalPlanRecord.planHash);
      if (!canonical || !dryRun?.passed || checkpoint.targetHash !== dryRun.dryRunHash) throw new Error('TrainingCheckpoint is stale relative to the current passed DryRunReceipt.');
      const conversations = new ThetaConversationEventRepository(runtime.eventBridge);
      const userMessage = await conversations.append({ runId: request.runId, sessionId, userId, role: 'user', content: request.content, messageId: request.messageId });
      const provider = this.inferenceProvider();
      if (!provider) throw new Error('MINIMAX_API_KEY is not configured.');
      const interpreter = new MiniMaxTrainingConfirmationInterpreter(provider);
      let decision = await runVisibleLanguageStep(runtime, {
        runId: request.runId,
        sessionId,
        userId,
        phase: THETA_WORKFLOW_STATES.trainingConfirmation,
        displayName: '理解训练确认反馈',
        runningMessage: 'MiniMax 正在理解你对训练启动的反馈',
        completedMessage: 'MiniMax 已理解训练启动反馈',
      }, () => interpreter.interpret({
        runId: request.runId,
        messageId: userMessage.messageId,
        message: userMessage.content,
        dryRunHash: dryRun.dryRunHash,
        checkpointSummary: checkpoint.summaryForUser,
      }));
      if (decision.kind === 'confirm_checkpoint') {
        const verdict = await runVisibleLanguageStep(runtime, {
          runId: request.runId,
          sessionId,
          userId,
          phase: THETA_WORKFLOW_STATES.trainingConfirmation,
          displayName: '复核训练批准',
          runningMessage: 'MiniMax 正在复核是否收到明确且无条件的训练批准',
          completedMessage: 'MiniMax 已完成训练批准复核',
        }, () => interpreter.verifyUnqualifiedAcceptance({
          runId: request.runId,
          messageId: userMessage.messageId,
          message: userMessage.content,
          dryRunHash: dryRun.dryRunHash,
          checkpointSummary: checkpoint.summaryForUser,
        }));
        if (!verdict.accepted) {
          decision = {
            kind: 'ask_about_checkpoint',
            question: '请明确说明是否无条件批准启动当前训练。',
            responseToUser: `我还不能把这条消息视为无条件训练批准：${verdict.rationale} 当前不会启动训练。`,
          };
        }
      }
      const assistant = await conversations.append({ runId: request.runId, sessionId, userId, role: 'assistant', content: decision.responseToUser, replyToMessageId: userMessage.messageId });
      if (decision.kind === 'ask_about_checkpoint') {
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint, assistantMessage: assistant.content };
      }
      if (decision.kind === 'revise_checkpoint' || decision.kind === 'reject_checkpoint') {
        const changed = await checkpoints.changeStatus({
          runId: request.runId, sessionId, userId, checkpointId: checkpoint.checkpointId,
          expectedContentHash: checkpoint.contentHash,
          status: decision.kind === 'reject_checkpoint' ? 'rejected' : 'revising',
          messageId: userMessage.messageId,
          reason: decision.kind === 'reject_checkpoint' ? decision.reason : decision.requestedChanges,
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'rejected');
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: { trainingCheckpointFeedbackMessageId: userMessage.messageId } },
          transition: { to: THETA_WORKFLOW_STATES.planDesign, reason: 'Training confirmation feedback invalidated the current executable chain.' },
        });
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint: changed, assistantMessage: assistant.content };
      }
      const approvalMaterial = {
        approvalType: 'human_training_review' as const,
        approvalId: `training-approval:${randomUUID()}`,
        runId: request.runId,
        planId: canonical.canonicalPlanRecord.planId,
        planHash: canonical.canonicalPlanRecord.planHash,
        dryRunHash: dryRun.dryRunHash,
        datasetHash: dryRun.datasetHash,
        principalId: userId,
        messageId: userMessage.messageId,
      };
      const approvalReceipt = humanTrainingReviewSchema.parse({
        ...approvalMaterial,
        approvedAt: new Date().toISOString(),
        trainingApprovalHash: trainingApprovalReceiptHash(approvalMaterial),
      });
      await execution.recordTrainingApproval({ runId: request.runId, sessionId, userId, receipt: approvalReceipt });
      const confirmed = await checkpoints.changeStatus({
        runId: request.runId, sessionId, userId, checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash, status: 'confirmed', messageId: userMessage.messageId,
        reason: 'The current principal explicitly and unconditionally approved the exact DryRun hash.',
      });
      await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
      const variables = {
        trainingApprovalHash: approvalReceipt.trainingApprovalHash,
        approvedDryRunHash: approvalReceipt.dryRunHash,
        trainingApprovalPlanHash: approvalReceipt.planHash,
        trainingApprovalDatasetHash: `sha256:${approvalReceipt.datasetHash}`,
        trainingApprovalPrincipalId: approvalReceipt.principalId,
        trainingApprovalMessageId: approvalReceipt.messageId,
        dryRunHash: dryRun.dryRunHash,
        canonicalPlanHash: canonical.canonicalPlanRecord.planHash,
        currentDatasetHash: `sha256:${dryRun.datasetHash}`,
      };
      await runDatasetStateDecision(runtime, scope, {
        result: { kind: 'completed', variablesPatch: variables },
        transition: { to: THETA_WORKFLOW_STATES.verifyDataset, reason: 'Independent human training approval is bound to the exact DryRun hash.', variablesPatch: variables },
        guardContext: { variables },
      });
      return { snapshot: await this.status(request.runId, resolvedDb), messageId: userMessage.messageId, decision, checkpoint: confirmed, assistantMessage: assistant.content, approvalReceipt };
    } finally {
      await runtime.close();
    }
  }

  async advanceTraining(runId: string, runtimeDb = defaultThetaV6RuntimeDb()): Promise<ThetaTrainingLifecycleResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const scope = runtimeScope(runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const activities = new ThetaActivityEventRepository(runtime.eventBridge);
    const toolIds: string[] = [];
    try {
      const snapshot = await this.status(runId, resolvedDb);
      const canonical = await execution.currentCanonicalPlan(runId);
      const dryRun = canonical === null ? null : await execution.currentDryRun(runId, canonical.canonicalPlanRecord.planHash);
      const approval = dryRun === null ? null : await execution.currentTrainingApproval(runId, dryRun.dryRunHash);
      if (!canonical || !dryRun?.passed || !approval) throw new Error('The current Canonical Plan, passed DryRun and HumanTrainingReview chain is incomplete.');

      if (snapshot.currentState === THETA_WORKFLOW_STATES.verifyDataset) {
        const result = await runGovernedStateTool(runtime, {
          runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb,
          state: THETA_WORKFLOW_STATES.verifyDataset, toolId: THETA_TOOL_IDS.datasetVerifyForTraining,
          input: { planId: canonical.canonicalPlanRecord.planId, expectedPlanHash: canonical.canonicalPlanRecord.planHash, expectedDryRunHash: dryRun.dryRunHash, expectedTrainingApprovalHash: approval.trainingApprovalHash },
        });
        toolIds.push(THETA_TOOL_IDS.datasetVerifyForTraining);
        if (result.status !== 'completed') {
          const message = toolFailureMessage(result);
          await transitionWithoutGuard(runtime, scope, THETA_WORKFLOW_STATES.humanRecovery, `Dataset verification Tool failed safely: ${message}`);
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: `训练未启动：数据复核未能完成。${message}`, toolIds };
        }
        const receipt = await execution.currentDatasetVerification(runId, approval.trainingApprovalHash);
        if (!receipt) throw new Error('Dataset verification Tool did not persist its receipt.');
        if (!receipt.verified) {
          const target = receipt.issues.some((issue) => issue.recoveryTarget === 'DatasetDiscovery') ? THETA_WORKFLOW_STATES.datasetDiscovery : receipt.issues.some((issue) => issue.recoveryTarget === 'PlanDesign') ? THETA_WORKFLOW_STATES.planDesign : THETA_WORKFLOW_STATES.humanRecovery;
          await transitionWithoutGuard(runtime, scope, target, 'Dataset verification failed before training start.');
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: `训练未启动：${receipt.issues.map((issue) => issue.message).join('；')}`, toolIds };
        }
        const variables = {
          datasetVerificationPassed: true,
          datasetVerificationHash: receipt.verificationHash,
          datasetVerificationPlanHash: receipt.planHash,
          datasetVerificationDryRunHash: receipt.dryRunHash,
          datasetVerificationApprovalHash: receipt.trainingApprovalHash,
          datasetVerificationDatasetHash: `sha256:${receipt.actualDatasetHash}`,
          canonicalPlanHash: receipt.planHash,
          dryRunHash: receipt.dryRunHash,
          trainingApprovalHash: receipt.trainingApprovalHash,
          currentDatasetHash: `sha256:${receipt.actualDatasetHash}`,
        };
        await runDatasetStateDecision(runtime, scope, { result: { kind: 'completed', variablesPatch: variables }, transition: { to: THETA_WORKFLOW_STATES.startTraining, reason: 'Current dataset bytes and columns match the approved execution chain.', variablesPatch: variables }, guardContext: { variables } });
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'dataset_verified', summary: '数据哈希和列绑定复核通过；下一步可以启动已批准训练。', toolIds };
      }

      if (snapshot.currentState === THETA_WORKFLOW_STATES.startTraining) {
        const verification = await execution.currentDatasetVerification(runId, approval.trainingApprovalHash);
        if (!verification?.verified) throw new Error('StartTraining requires a passed DatasetVerificationReceipt.');
        const idempotencyKey = hashCanonicalJson({ runId, planHash: canonical.canonicalPlanRecord.planHash, dryRunHash: dryRun.dryRunHash, trainingApprovalHash: approval.trainingApprovalHash, datasetVerificationHash: verification.verificationHash, attempt: 1 });
        const result = await runGovernedStateTool(runtime, {
          runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb, state: THETA_WORKFLOW_STATES.startTraining,
          toolId: THETA_TOOL_IDS.trainingStart, idempotencyKey,
          input: { planId: canonical.canonicalPlanRecord.planId, expectedPlanHash: canonical.canonicalPlanRecord.planHash, expectedDryRunHash: dryRun.dryRunHash, expectedTrainingApprovalHash: approval.trainingApprovalHash, expectedDatasetVerificationHash: verification.verificationHash },
        });
        toolIds.push(THETA_TOOL_IDS.trainingStart);
        if (result.status !== 'completed') {
          const message = toolFailureMessage(result);
          await transitionWithoutGuard(runtime, scope, THETA_WORKFLOW_STATES.quarantined, `Training start returned an unknown side-effect state: ${message}`);
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'quarantined', summary: `训练启动结果无法确认，已隔离且不会自动重试：${message}`, toolIds };
        }
        const receipt = await execution.currentTrainingRun(runId);
        if (!receipt) throw new Error('Training start Tool did not persist a TrainingRunReceipt.');
        const { receiptId: _receiptId, acceptedAt: _acceptedAt, ...runHashMaterial } = receipt;
        const variables = {
          trainingRunId: receipt.trainingRunId,
          trainingRunReceiptHash: trainingRunReceiptHash(runHashMaterial),
          trainingRunPlanHash: receipt.planHash,
          trainingRunDryRunHash: receipt.dryRunHash,
          trainingRunApprovalHash: receipt.trainingApprovalHash,
          trainingRunDatasetVerificationHash: receipt.datasetVerificationHash,
          canonicalPlanHash: receipt.planHash,
          dryRunHash: receipt.dryRunHash,
          trainingApprovalHash: receipt.trainingApprovalHash,
          datasetVerificationHash: receipt.datasetVerificationHash,
        };
        await runDatasetStateDecision(runtime, scope, { result: { kind: 'completed', variablesPatch: variables }, transition: { to: THETA_WORKFLOW_STATES.monitorTraining, reason: 'Bridge accepted exactly one idempotent approved training run.', variablesPatch: variables }, guardContext: { variables } });
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'training_started', summary: `训练已启动（${receipt.trainingRunId}），已进入持久化进度监控。`, toolIds };
      }

      if (snapshot.currentState === THETA_WORKFLOW_STATES.monitorTraining) {
        const run = await execution.currentTrainingRun(runId);
        if (!run) throw new Error('MonitorTraining has no current TrainingRunReceipt.');
        const statusResult = await runGovernedStateTool(runtime, { runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb, state: THETA_WORKFLOW_STATES.monitorTraining, toolId: THETA_TOOL_IDS.trainingStatus, input: { trainingRunId: run.trainingRunId } });
        toolIds.push(THETA_TOOL_IDS.trainingStatus);
        if (statusResult.status !== 'completed') return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: `暂时无法读取训练状态：${toolFailureMessage(statusResult)}`, toolIds };
        const progress = trainingProgressSnapshotSchema.parse(record(completedToolOutput(statusResult).snapshot));
        await execution.recordTrainingProgress({ runId, sessionId, userId, snapshot: progress });
        await recordTrainingProgressActivity(activities, runId, sessionId, userId, progress);
        if (['queued', 'running', 'cancel_requested'].includes(progress.status)) {
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'monitoring', summary: progress.activitySummary, toolIds, progress };
        }
        if (progress.status === 'cancelled') {
          await transitionWithoutGuard(runtime, scope, THETA_WORKFLOW_STATES.cancelled, 'The training runner confirmed cancellation.');
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'cancelled', summary: '训练已安全取消。', toolIds, progress };
        }
        if (progress.status === 'failed') {
          const target = progress.failure?.recoveryTarget === 'DatasetDiscovery' ? THETA_WORKFLOW_STATES.datasetDiscovery : progress.failure?.recoveryTarget === 'PlanDesign' ? THETA_WORKFLOW_STATES.planDesign : THETA_WORKFLOW_STATES.humanRecovery;
          await transitionWithoutGuard(runtime, scope, target, `Structured training failure: ${progress.failure?.code ?? 'TRAINING_FAILED'}`);
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: progress.failure?.message ?? '训练失败。', toolIds, progress };
        }
        if (progress.status === 'quarantined' || progress.status === 'unknown') {
          await transitionWithoutGuard(runtime, scope, THETA_WORKFLOW_STATES.quarantined, 'Training status is unknown or quarantined.');
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'quarantined', summary: '训练状态不可信，已隔离等待人工处理。', toolIds, progress };
        }
        const artifactResult = await runGovernedStateTool(runtime, { runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb, state: THETA_WORKFLOW_STATES.monitorTraining, toolId: THETA_TOOL_IDS.artifactsVerify, input: { trainingRunId: run.trainingRunId } });
        toolIds.push(THETA_TOOL_IDS.artifactsVerify);
        if (artifactResult.status !== 'completed') {
          await transitionWithoutGuard(runtime, scope, THETA_WORKFLOW_STATES.humanRecovery, `Completed training artifacts failed verification: ${toolFailureMessage(artifactResult)}`);
          return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: '训练已结束，但结果产物未通过完整性验证，禁止展示。', toolIds, progress };
        }
        const manifest = await execution.currentArtifactManifest(runId, run.trainingRunId);
        if (!manifest) throw new Error('Artifact verification did not persist a manifest.');
        const variables = { artifactManifestHash: manifest.manifestHash, artifactManifestTrainingRunId: manifest.trainingRunId, artifactManifestPlanHash: manifest.planHash, trainingRunId: run.trainingRunId, canonicalPlanHash: run.planHash };
        await runDatasetStateDecision(runtime, scope, { result: { kind: 'completed', variablesPatch: variables }, transition: { to: THETA_WORKFLOW_STATES.evaluateResults, reason: 'Only verified run-bound artifacts may enter result evaluation.', variablesPatch: variables }, guardContext: { variables } });
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'results_ready', summary: `训练完成，${manifest.artifacts.length} 个结果产物已完成哈希验证。`, toolIds, progress };
      }

      if (snapshot.currentState === THETA_WORKFLOW_STATES.evaluateResults) {
        const summaryResult = await runGovernedStateTool(runtime, { runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb, state: THETA_WORKFLOW_STATES.evaluateResults, toolId: THETA_TOOL_IDS.resultsGetSummary, input: {} });
        toolIds.push(THETA_TOOL_IDS.resultsGetSummary);
        if (summaryResult.status !== 'completed') return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: `结果摘要读取失败：${toolFailureMessage(summaryResult)}`, toolIds };
        const results = completedToolOutput(summaryResult);
        const manifest = await execution.currentArtifactManifest(runId);
        if (!manifest) throw new Error('EvaluateResults requires a VerifiedArtifactManifest.');
        const variables = { resultsEvaluationCompleted: true, resultsArtifactManifestHash: manifest.manifestHash, artifactManifestHash: manifest.manifestHash };
        await runDatasetStateDecision(runtime, scope, { result: { kind: 'completed', variablesPatch: variables }, transition: { to: THETA_WORKFLOW_STATES.completed, reason: 'Verified results summary is ready.', variablesPatch: variables }, guardContext: { variables } });
        return { snapshot: await this.status(runId, resolvedDb), disposition: 'completed', summary: '训练、评估和结果产物验证已全部完成。', toolIds, results };
      }
      throw new Error(`Run cannot advance training from ${snapshot.currentState ?? '(none)'}.`);
    } finally {
      await runtime.close();
    }
  }

  async cancelTraining(runId: string, reason: string, runtimeDb = defaultThetaV6RuntimeDb()): Promise<ThetaTrainingLifecycleResult> {
    const resolvedDb = path.resolve(runtimeDb);
    const userId = 'local_user';
    const workspaceId = 'local_workspace';
    const sessionId = `session:${runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    try {
      const snapshot = await this.status(runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.monitorTraining && snapshot.currentState !== THETA_WORKFLOW_STATES.humanRecovery) throw new Error(`Run cannot be cancelled from ${snapshot.currentState ?? '(none)'}.`);
      const current = await new ThetaExecutionEventRepository(runtime.eventBridge).currentTrainingRun(runId);
      if (!current) throw new Error('There is no current training run to cancel.');
      const result = await runGovernedStateTool(runtime, { runId, sessionId, userId, workspaceId, runtimeDb: resolvedDb, state: snapshot.currentState as ThetaWorkflowState, toolId: THETA_TOOL_IDS.trainingCancel, idempotencyKey: hashCanonicalJson({ runId, trainingRunId: current.trainingRunId, reason }), input: { trainingRunId: current.trainingRunId, reason } });
      if (result.status !== 'completed') return { snapshot: await this.status(runId, resolvedDb), disposition: 'recovery_required', summary: `取消请求未被确认：${toolFailureMessage(result)}`, toolIds: [THETA_TOOL_IDS.trainingCancel] };
      return { snapshot: await this.status(runId, resolvedDb), disposition: 'monitoring', summary: '已提交协作式取消请求；系统将持续监控，直到训练进程确认取消。', toolIds: [THETA_TOOL_IDS.trainingCancel] };
    } finally {
      await runtime.close();
    }
  }

  async submitIntakeMessage(
    request: SubmitCheckpointMessageRequest & { uploadRoot?: string },
  ): Promise<ThetaIntakeResult> {
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (
        snapshot.currentState !== THETA_WORKFLOW_STATES.intake ||
        snapshot.status !== 'waiting_human' ||
        !snapshot.pendingActionRef?.startsWith('theta.intake.question:')
      ) {
        throw new Error(`Run is not waiting for an Intake conversation reply: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const messages = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(
        messages,
        runtime.memory,
        { userId, workspaceId, sessionId, runId: request.runId },
      );
      await memoryCoordinator.append('Intake', {
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: request.content,
        messageId: request.messageId,
      });
      await resolveHumanWait(runtime, runtimeScope(request.runId, userId, workspaceId), snapshot, userId, 'approved');
    } finally {
      await runtime.close();
    }
    return this.runIntake(request.runId, resolvedDb, request.uploadRoot ?? managedUploadRoot(resolvedDb));
  }

  async submitResearchMessage(request: SubmitCheckpointMessageRequest): Promise<ThetaResearchDialogueResult> {
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.researchDialogue || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting for a ResearchDialogue answer: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const messages = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(
        messages,
        runtime.memory,
        { userId, workspaceId, sessionId, runId: request.runId },
      );
      await memoryCoordinator.append('ResearchDialogue', {
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: request.content,
        messageId: request.messageId,
      });
      await resolveHumanWait(runtime, runtimeScope(request.runId, userId, workspaceId), snapshot, userId, 'approved');
    } finally {
      await runtime.close();
    }
    return this.runResearchDialogue(request.runId, resolvedDb);
  }

  async submitDatasetDiscoveryMessage(request: SubmitCheckpointMessageRequest): Promise<ThetaDatasetDiscoveryResult> {
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.datasetDiscovery || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting for a DatasetDiscovery answer: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      if (!runtime.memory) throw new Error('Hypha Governed Memory is not initialized.');
      const messages = new ThetaConversationEventRepository(runtime.eventBridge);
      const memoryCoordinator = new ConversationMemoryCoordinator(
        messages,
        runtime.memory,
        { userId, workspaceId, sessionId, runId: request.runId },
      );
      await memoryCoordinator.append('DatasetDiscovery', {
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: request.content,
        messageId: request.messageId,
      });
      await resolveHumanWait(runtime, runtimeScope(request.runId, userId, workspaceId), snapshot, userId, 'approved');
    } finally {
      await runtime.close();
    }
    return this.runDatasetDiscovery(request.runId, resolvedDb);
  }

  async submitResearchCheckpointMessage(request: SubmitCheckpointMessageRequest): Promise<ThetaCheckpointMessageResult> {
    rejectNaturalLanguageCheckpointDecision('ResearchCheckpoint');
    /* Legacy implementation is intentionally unreachable until removed after downstream callers migrate. */
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const scope = runtimeScope(request.runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb, { memory: true });
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.researchCheckpoint || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting at ResearchCheckpoint: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      const checkpoints = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const checkpoint = await checkpoints.current(request.runId, 'research');
      if (!checkpoint || !['proposed', 'revising'].includes(checkpoint.status)) throw new Error('There is no active ResearchCheckpoint.');
      const conversations = new ThetaConversationEventRepository(runtime.eventBridge);
      const message = await conversations.append({ runId: request.runId, sessionId, userId, role: 'user', content: request.content, messageId: request.messageId });
      const workspace = await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(request.runId, 'research');
      if (!workspace || workspace.workspaceType !== 'research' || workspace.workspaceHash !== checkpoint.targetHash) {
        throw new Error('ResearchCheckpoint is stale relative to ResearchWorkspace.');
      }
      const provider = this.inferenceProvider();
      if (!provider) throw new Error('MINIMAX_API_KEY is not configured.');
      const decision = await runVisibleLanguageStep(runtime, {
        runId: request.runId,
        sessionId,
        userId,
        phase: THETA_WORKFLOW_STATES.researchCheckpoint,
        displayName: '理解研究意图反馈',
        runningMessage: 'MiniMax 正在理解你对研究意图摘要的确认或修改',
        completedMessage: 'MiniMax 已完成研究意图反馈判断',
      }, () => new MiniMaxResearchCheckpointFeedbackInterpreter(provider).interpret({
        runId: request.runId,
        messageId: message.messageId,
        message: message.content,
        checkpoint,
        workspace,
      }));
      const assistant = await conversations.append({ runId: request.runId, sessionId, userId, role: 'assistant', content: decision.responseToUser, replyToMessageId: message.messageId });
      if (runtime.memory) {
        const identity = { userId, workspaceId, sessionId, runId: request.runId };
        await runtime.memory.rememberMessage(identity, 'ResearchDialogue', message);
        await runtime.memory.rememberMessage(identity, 'ResearchDialogue', assistant);
      }
      if (decision.kind === 'ask_about_checkpoint') {
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: message.messageId, decision, checkpoint, assistantMessage: assistant.content };
      }
      if (decision.kind === 'confirm_checkpoint') {
        const confirmed = await checkpoints.changeStatus({ runId: request.runId, sessionId, userId, checkpointId: checkpoint.checkpointId, expectedContentHash: checkpoint.contentHash, status: 'confirmed', messageId: message.messageId, reason: 'The current user explicitly confirmed the current research synthesis hash.' });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
        await runDatasetStateDecision(runtime, scope, {
          result: { kind: 'completed', variablesPatch: { researchWorkspaceHash: workspace.workspaceHash, researchCheckpointStatus: 'confirmed', researchCheckpointTargetHash: confirmed.targetHash } },
          transition: { to: THETA_WORKFLOW_STATES.planDesign, reason: 'The current user confirmed the ResearchWorkspace hash.', variablesPatch: { researchWorkspaceHash: workspace.workspaceHash, researchCheckpointStatus: 'confirmed', researchCheckpointTargetHash: confirmed.targetHash } },
          guardContext: { variables: { researchWorkspaceHash: workspace.workspaceHash, researchCheckpointStatus: 'confirmed', researchCheckpointTargetHash: confirmed.targetHash } },
        });
        if (runtime.memory) await runtime.memory.rememberResearchWorkspace({ userId, workspaceId, sessionId, runId: request.runId }, workspace, { checkpointStatus: 'confirmed', humanVerified: true });
        return { snapshot: await this.status(request.runId, resolvedDb), messageId: message.messageId, decision, checkpoint: confirmed, assistantMessage: assistant.content };
      }
      const changed = await checkpoints.changeStatus({
        runId: request.runId,
        sessionId,
        userId,
        checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash,
        status: decision.kind === 'reject_checkpoint' ? 'rejected' : 'revising',
        messageId: message.messageId,
        reason: decision.kind === 'revise_checkpoint' ? decision.requestedChanges : decision.reason,
      });
      await resolveHumanWait(runtime, scope, snapshot, userId, 'rejected');
      await runDatasetStateDecision(runtime, scope, {
        result: { kind: 'completed', variablesPatch: { researchCheckpointFeedbackMessageId: message.messageId } },
        transition: { to: THETA_WORKFLOW_STATES.researchDialogue, reason: 'Research checkpoint feedback requires a new ResearchWorkspace revision.', variablesPatch: { researchCheckpointFeedbackMessageId: message.messageId } },
      });
      return { snapshot: await this.status(request.runId, resolvedDb), messageId: message.messageId, decision, checkpoint: changed, assistantMessage: assistant.content };
    } finally {
      await runtime.close();
    }
  }

  async currentCheckpoint(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ConversationalCheckpoint | null> {
    const runtime = await createThetaRuntimeComposition(path.resolve(runtimeDb));
    try {
      return await new ThetaCheckpointEventRepository(runtime.eventBridge).current(runId);
    } finally {
      runtime.close();
    }
  }

  async conversation(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
  ): Promise<ConversationDigest> {
    const runtime = await createThetaRuntimeComposition(path.resolve(runtimeDb));
    try {
      return await new ThetaConversationEventRepository(runtime.eventBridge).digest(runId);
    } finally {
      runtime.close();
    }
  }

  async submitCheckpointMessage(
    request: SubmitCheckpointMessageRequest,
  ): Promise<ThetaCheckpointMessageResult> {
    rejectNaturalLanguageCheckpointDecision('DatasetCheckpoint');
    /* Legacy implementation is intentionally unreachable until removed after downstream callers migrate. */
    const resolvedDb = path.resolve(request.runtimeDb ?? defaultThetaV6RuntimeDb());
    const userId = request.userId ?? 'local_user';
    const workspaceId = request.workspaceId ?? 'local_workspace';
    const sessionId = `session:${request.runId}`;
    const scope = runtimeScope(request.runId, userId, workspaceId);
    const runtime = await createThetaRuntimeComposition(resolvedDb);
    try {
      const snapshot = await this.status(request.runId, resolvedDb);
      if (snapshot.currentState !== THETA_WORKFLOW_STATES.datasetCheckpoint || snapshot.status !== 'waiting_human') {
        throw new Error(`Run is not waiting at DatasetCheckpoint: ${snapshot.currentState ?? '(none)'} / ${snapshot.status}.`);
      }
      const checkpointRepository = new ThetaCheckpointEventRepository(runtime.eventBridge);
      const checkpoint = await checkpointRepository.current(request.runId, 'dataset');
      if (!checkpoint || !['proposed', 'revising'].includes(checkpoint.status)) {
        throw new Error('There is no active DatasetCheckpoint.');
      }
      const messages = new ThetaConversationEventRepository(runtime.eventBridge);
      const message = await messages.append({
        runId: request.runId,
        sessionId,
        userId,
        role: 'user',
        content: request.content,
        messageId: request.messageId,
      });
      const workspaceRepository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
      const workspace = await workspaceRepository.current(request.runId, 'dataset');
      if (!workspace || workspace.workspaceType !== 'dataset' || workspace.workspaceHash !== checkpoint.targetHash) {
        throw new Error('DatasetCheckpoint is stale relative to the current DatasetWorkspace.');
      }
      const provider = this.inferenceProvider();
      if (!provider) throw new Error('MINIMAX_API_KEY is not configured.');
      const interpretedDecision = await runVisibleLanguageStep(runtime, {
        runId: request.runId,
        sessionId,
        userId,
        phase: THETA_WORKFLOW_STATES.datasetCheckpoint,
        displayName: '理解数据确认反馈',
        runningMessage: 'MiniMax 正在理解你对数据概况的确认或修改',
        completedMessage: 'MiniMax 已完成数据确认反馈判断',
      }, () => new MiniMaxCheckpointFeedbackInterpreter(provider).interpret({
        runId: request.runId,
        messageId: message.messageId,
        message: message.content,
        checkpoint,
        workspace,
      }));
      const candidateCount = primaryTextCandidates(workspace).length;
      const decision: CheckpointFeedbackDecision = interpretedDecision.kind === 'confirm_checkpoint' &&
        !hasUniqueConfirmedPrimaryTextColumn(workspace) && candidateCount !== 1
        ? {
            kind: 'ask_about_checkpoint',
            question: candidateCount === 0
              ? '目前没有可确认的主文本列候选。请说明哪一列是正文，或让我返回数据探索重新判断。'
              : `目前存在 ${candidateCount} 个主文本列候选。请明确选择其中一列，不能同时确认多个主文本列。`,
            responseToUser: candidateCount === 0
              ? '当前数据理解还没有形成主文本列候选，暂时不能进入研究阶段。请告诉我正文列，或让我重新探索数据。'
              : `当前有 ${candidateCount} 个正文候选，暂时不能整体确认。请告诉我哪一列是唯一主文本列。`,
          }
        : interpretedDecision;
      const assistant = await messages.append({
        runId: request.runId,
        sessionId,
        userId,
        role: 'assistant',
        content: decision.responseToUser,
        replyToMessageId: message.messageId,
      });
      if (decision.kind === 'ask_about_checkpoint') {
        return {
          snapshot: await this.status(request.runId, resolvedDb),
          messageId: message.messageId,
          decision,
          checkpoint,
          assistantMessage: assistant.content,
        };
      }
      if (decision.kind === 'confirm_checkpoint') {
        let acceptedWorkspace = workspace;
        let checkpointToConfirm = checkpoint;
        if (!hasUniqueConfirmedPrimaryTextColumn(workspace)) {
          await checkpointRepository.changeStatus({
            runId: request.runId,
            sessionId,
            userId,
            checkpointId: checkpoint.checkpointId,
            expectedContentHash: checkpoint.contentHash,
            status: 'invalidated',
            messageId: message.messageId,
            reason: 'The accepted primary-text recommendation creates a new provenance-bound DatasetWorkspace revision.',
          });
          acceptedWorkspace = await workspaceRepository.revise({
            runId: request.runId,
            sessionId,
            userId,
            expectedRevision: workspace.revision,
            draft: confirmUniquePrimaryTextRole(workspace, {
              id: `message-ref:${message.messageId}`,
              kind: 'user_message',
              hash: message.contentHash,
            }),
            reason: 'The user confirmed, or explicitly delegated acceptance of, the Agent recommended unique primary text column.',
            invalidates: ['plan', 'approval', 'dry_run', 'training_approval'],
          }) as DatasetWorkspace;
          checkpointToConfirm = await checkpointRepository.proposeDataset({
            runId: request.runId,
            sessionId,
            userId,
            workspace: acceptedWorkspace,
            requestedBy: 'fsm',
            rationale: 'This revision records the accepted unique primary text column before ResearchDialogue.',
          });
        }
        const confirmed = await checkpointRepository.changeStatus({
          runId: request.runId,
          sessionId,
          userId,
          checkpointId: checkpointToConfirm.checkpointId,
          expectedContentHash: checkpointToConfirm.contentHash,
          status: 'confirmed',
          messageId: message.messageId,
          reason: 'The current principal explicitly confirmed the current checkpoint revision.',
        });
        await resolveHumanWait(runtime, scope, snapshot, userId, 'approved');
        await runDatasetStateDecision(runtime, scope, {
          result: {
            kind: 'completed',
            variablesPatch: {
              datasetWorkspaceHash: acceptedWorkspace.workspaceHash,
              datasetPrimaryTextConfirmed: true,
              datasetCheckpointStatus: 'confirmed',
              datasetCheckpointTargetHash: confirmed.targetHash,
            },
          },
          transition: {
            to: THETA_WORKFLOW_STATES.researchDialogue,
            reason: 'The current user confirmed the current DatasetCheckpoint hash.',
            variablesPatch: {
              datasetWorkspaceHash: acceptedWorkspace.workspaceHash,
              datasetPrimaryTextConfirmed: true,
              datasetCheckpointStatus: 'confirmed',
              datasetCheckpointTargetHash: confirmed.targetHash,
            },
          },
          guardContext: { variables: {
            datasetWorkspaceHash: acceptedWorkspace.workspaceHash,
            datasetPrimaryTextConfirmed: true,
            datasetCheckpointStatus: 'confirmed',
            datasetCheckpointTargetHash: confirmed.targetHash,
          } },
        });
        return {
          snapshot: await this.status(request.runId, resolvedDb),
          messageId: message.messageId,
          decision,
          checkpoint: confirmed,
          assistantMessage: assistant.content,
        };
      }
      const status = decision.kind === 'reject_checkpoint' ? 'rejected' : 'revising';
      if (decision.kind === 'return_to_phase' && decision.phase !== 'DatasetDiscovery') {
        throw new Error('DatasetCheckpoint can only return to DatasetDiscovery without a current-hash confirmation.');
      }
      const changed = await checkpointRepository.changeStatus({
        runId: request.runId,
        sessionId,
        userId,
        checkpointId: checkpoint.checkpointId,
        expectedContentHash: checkpoint.contentHash,
        status,
        messageId: message.messageId,
        reason: decision.kind === 'revise_checkpoint' ? decision.requestedChanges : decision.reason,
      });
      await resolveHumanWait(runtime, scope, snapshot, userId, 'rejected');
      await runDatasetStateDecision(runtime, scope, {
        result: { kind: 'completed', variablesPatch: { checkpointFeedbackMessageId: message.messageId } },
        transition: {
          to: THETA_WORKFLOW_STATES.datasetDiscovery,
          reason: 'DatasetCheckpoint feedback requires a new Agent revision before any confirmation can apply.',
          variablesPatch: { checkpointFeedbackMessageId: message.messageId },
        },
      });
      const continuation = (decision.kind === 'revise_checkpoint' || decision.kind === 'return_to_phase')
        ? await this.runDatasetDiscovery(request.runId, resolvedDb)
        : undefined;
      return {
        snapshot: continuation?.snapshot ?? await this.status(request.runId, resolvedDb),
        messageId: message.messageId,
        decision,
        checkpoint: changed,
        assistantMessage: assistant.content,
        ...(continuation === undefined ? {} : { continuation }),
      };
    } finally {
      runtime.close();
    }
  }

  async evidence(runId: string, runtimeDb = defaultThetaV6RuntimeDb()): Promise<FrameworkEvent[]> {
    const runtime = await createThetaRuntimeComposition(path.resolve(runtimeDb));
    try {
      return await runtime.eventBridge.list({ runId });
    } finally {
      runtime.close();
    }
  }

  async activities(
    runId: string,
    runtimeDb = defaultThetaV6RuntimeDb(),
    limit = 30,
  ): Promise<AgentActivitySnapshot> {
    const runtime = await createThetaRuntimeComposition(path.resolve(runtimeDb));
    try {
      return await new ThetaActivityEventRepository(runtime.eventBridge).snapshot(runId, limit);
    } finally {
      await runtime.close();
    }
  }
}

const runVisibleLanguageStep = async <T>(
  runtime: ThetaRuntimeComposition,
  request: {
    runId: string;
    sessionId: string;
    userId: string;
    phase: ThetaWorkflowState;
    displayName: string;
    runningMessage: string;
    completedMessage: string;
  },
  operation: () => Promise<T>,
): Promise<T> => {
  const activities = new ThetaActivityEventRepository(runtime.eventBridge);
  const activityId = `language:${request.runId}:${request.phase}:${randomUUID()}`;
  await activities.record({
    runId: request.runId,
    sessionId: request.sessionId,
    userId: request.userId,
    activityId,
    phase: request.phase,
    kind: 'thinking',
    displayName: request.displayName,
    userMessage: request.runningMessage,
    status: 'running',
  });
  try {
    const result = await operation();
    await activities.record({
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      activityId,
      phase: request.phase,
      kind: 'thinking',
      displayName: request.displayName,
      userMessage: request.completedMessage,
      status: 'completed',
      safeOutputSummary: '语义判断已完成；未展示模型内部推理',
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    await activities.record({
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      activityId,
      phase: request.phase,
      kind: 'thinking',
      displayName: request.displayName,
      userMessage: `${request.displayName}未能完成`,
      status: 'failed',
      safeOutputSummary: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
};

const runGovernedStateTool = async (
  runtime: ThetaRuntimeComposition,
  request: {
    runId: string;
    sessionId: string;
    userId: string;
    workspaceId: string;
    runtimeDb: string;
    state: ThetaWorkflowState;
    toolId: string;
    input: Record<string, unknown>;
    idempotencyKey?: string;
    emitActivity?: boolean;
  },
): Promise<ToolCallResult> => {
  const profile = THETA_STATE_TOOL_PROFILES[request.state];
  const invocationId = randomUUID();
  const activityId = `tool:${request.runId}:${request.state}:${request.toolId}:${invocationId}`;
  const emitActivity = request.emitActivity !== false;
  const activities = emitActivity ? new ThetaActivityEventRepository(runtime.eventBridge) : undefined;
  const copy = toolActivityCopy(request.toolId, runtime.toolRegistry.getSpec(request.toolId)?.displayName);
  if (activities) {
    await activities.record({
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      activityId,
      phase: request.state,
      kind: 'tool_started',
      toolId: request.toolId,
      displayName: copy.displayName,
      userMessage: copy.running,
      status: 'running',
      safeInputSummary: governedToolInputSummary(request.input),
    });
  }
  let result: ToolCallResult;
  try {
    result = await runtime.toolRunner.run({
      toolId: request.toolId,
      input: request.input,
      context: {
        runId: request.runId,
        stepId: `${request.state}:${request.toolId}:${invocationId}`,
        sessionId: request.sessionId,
        userId: request.userId,
        workspaceId: request.workspaceId,
        fsmState: request.state,
        executionScope: resolveThetaV6StateToolScope(request.state),
        principal: {
          id: request.userId,
          type: 'user',
          userId: request.userId,
          workspaceId: request.workspaceId,
          permissionScopes: [...profile.permissionScopes],
        },
        metadata: { thetaRuntimeDb: request.runtimeDb },
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      },
    } as ToolCallRequest);
  } catch (error) {
    if (activities) {
      await activities.record({
        runId: request.runId,
        sessionId: request.sessionId,
        userId: request.userId,
        activityId,
        phase: request.state,
        kind: 'tool_failed',
        toolId: request.toolId,
        displayName: copy.displayName,
        userMessage: `${copy.displayName}调用失败`,
        status: 'failed',
        safeOutputSummary: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
  if (activities) {
    await activities.record({
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      activityId,
      phase: request.state,
      kind: result.status === 'completed' ? 'tool_completed' : 'tool_failed',
      toolId: request.toolId,
      displayName: copy.displayName,
      userMessage: result.status === 'completed' ? copy.completed : `${copy.displayName}未能完成`,
      status: result.status === 'completed' ? 'completed' : 'failed',
      safeOutputSummary: result.status === 'completed' ? '工具调用成功，结果已写入受治理的运行记录' : toolFailureMessage(result),
      completedAt: new Date().toISOString(),
    });
  }
  return result;
};

const governedToolInputSummary = (input: Record<string, unknown>): string => {
  if (typeof input.candidateRef === 'string') return `候选计划：${input.candidateRef}`;
  if (typeof input.planId === 'string') return `计划：${input.planId}`;
  if (typeof input.trainingRunId === 'string') return `训练任务：${input.trainingRunId}`;
  if (typeof input.column === 'string') return `数据列：${input.column}`;
  return '输入已按隐私策略隐藏';
};

const ensureTrainingCheckpoint = async (
  runtime: ThetaRuntimeComposition,
  request: { runId: string; sessionId: string; userId: string; planRecord: CanonicalPlanExecutionRecord['canonicalPlanRecord']; dryRun: DryRunReceipt },
): Promise<ConversationalCheckpoint> => {
  const checkpoints = new ThetaCheckpointEventRepository(runtime.eventBridge);
  const current = await checkpoints.current(request.runId, 'training');
  if (current?.targetHash === request.dryRun.dryRunHash && ['proposed', 'revising', 'confirmed'].includes(current.status)) return current;
  return checkpoints.proposeTraining({ ...request, rationale: 'FSM requires an independent, exact-hash training approval after a passed DryRun.' });
};

const transitionWithoutGuard = async (
  runtime: ThetaRuntimeComposition,
  scope: RuntimeScope,
  to: ThetaWorkflowState,
  reason: string,
): Promise<void> => {
  await runDatasetStateDecision(runtime, scope, {
    result: { kind: 'completed' },
    transition: { to, reason },
  });
};

const recordTrainingProgressActivity = async (
  activities: ThetaActivityEventRepository,
  runId: string,
  sessionId: string,
  userId: string,
  progress: TrainingProgressSnapshot,
): Promise<void> => {
  const terminal = ['completed', 'failed', 'cancelled', 'quarantined'].includes(progress.status);
  await activities.record({
    runId,
    sessionId,
    userId,
    activityId: `training-progress:${progress.trainingRunId}:${progress.status}:${progress.phase}:${Math.floor(progress.overallPercent)}`,
    phase: THETA_WORKFLOW_STATES.monitorTraining,
    kind: terminal ? (progress.status === 'completed' ? 'tool_completed' : 'tool_failed') : 'tool_started',
    toolId: THETA_TOOL_IDS.trainingStatus,
    displayName: progress.phaseLabel,
    userMessage: progress.activitySummary,
    status: progress.status === 'completed' ? 'completed' : terminal ? 'failed' : 'running',
    safeOutputSummary: `${progress.completedRuns}/${progress.totalRuns}; elapsedMs=${progress.elapsedMs}`,
    ...(terminal ? { completedAt: progress.updatedAt } : {}),
  });
};

const completedToolOutput = (result: ToolCallResult): Record<string, unknown> => {
  if (result.status !== 'completed' || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
    throw new Error(`Governed Tool did not complete: ${toolFailureMessage(result)}`);
  }
  return result.output as Record<string, unknown>;
};

const toolFailureMessage = (result: ToolCallResult): string => {
  if (typeof result.error === 'string') return result.error;
  if (result.error && typeof result.error === 'object') {
    const code = typeof result.error.code === 'string' ? `${result.error.code}: ` : '';
    return `${code}${result.error.message}`;
  }
  return `Tool ${result.toolId} ended with ${result.status}.`;
};

const requiredOutputText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Tool output ${label} is missing.`);
  return value;
};

const dryRunRecoveryTarget = (receipt: DryRunReceipt): ThetaWorkflowState => {
  const targets = new Set(receipt.checks.filter((check) => check.status === 'fail').map((check) => check.recoveryTarget));
  if (targets.has('DatasetDiscovery')) return THETA_WORKFLOW_STATES.datasetDiscovery;
  if (targets.has('HumanRecovery')) return THETA_WORKFLOW_STATES.humanRecovery;
  return THETA_WORKFLOW_STATES.planDesign;
};

const failedDryRunCodes = (receipt: DryRunReceipt): string => receipt.checks
  .filter((check) => check.status === 'fail')
  .map((check) => check.code)
  .join(', ');

const dryRunRecoverySummary = (receipt: DryRunReceipt): string => {
  const target = dryRunRecoveryTarget(receipt);
  const codes = failedDryRunCodes(receipt);
  if (target === THETA_WORKFLOW_STATES.datasetDiscovery) return `数据或列绑定未通过训练前检查（${codes}），已返回数据理解阶段。`;
  if (target === THETA_WORKFLOW_STATES.humanRecovery) return `本地依赖或模型资产未通过训练前检查（${codes}），需要人工修复环境。`;
  return `当前计划未通过训练前检查（${codes}），已返回计划设计阶段。`;
};

const checkpointKindForState = (state?: string): {
  kind: 'dataset' | 'research' | 'plan';
  revisionTarget: ThetaWorkflowState;
  memoryPhase: 'DatasetDiscovery' | 'ResearchDialogue' | 'PlanDesign';
} | null => {
  if (state === THETA_WORKFLOW_STATES.datasetCheckpoint) {
    return { kind: 'dataset', revisionTarget: THETA_WORKFLOW_STATES.datasetDiscovery, memoryPhase: 'DatasetDiscovery' };
  }
  if (state === THETA_WORKFLOW_STATES.researchCheckpoint) {
    return { kind: 'research', revisionTarget: THETA_WORKFLOW_STATES.researchDialogue, memoryPhase: 'ResearchDialogue' };
  }
  if (state === THETA_WORKFLOW_STATES.planConfirmation) {
    return { kind: 'plan', revisionTarget: THETA_WORKFLOW_STATES.planDesign, memoryPhase: 'PlanDesign' };
  }
  return null;
};

const rejectNaturalLanguageCheckpointDecision = (checkpoint: string): void => {
  throw new Error(`${checkpoint} no longer accepts natural-language approval. Use decideCheckpoint with action=approve or action=revise.`);
};

const recordCheckpointDecisionActivity = async (
  runtime: ThetaRuntimeComposition,
  request: {
    runId: string;
    sessionId: string;
    userId: string;
    phase: string;
    action: 'approve' | 'revise';
    message: string;
  },
): Promise<void> => {
  const timestamp = new Date().toISOString();
  await new ThetaActivityEventRepository(runtime.eventBridge).record({
    runId: request.runId,
    sessionId: request.sessionId,
    userId: request.userId,
    activityId: `checkpoint-decision:${request.phase}:${randomUUID()}`,
    phase: request.phase,
    kind: 'phase_completed',
    displayName: request.action === 'approve' ? '确认当前阶段' : '提交修改反馈',
    userMessage: request.message,
    status: 'completed',
    startedAt: timestamp,
    completedAt: timestamp,
    safeOutputSummary: request.action === 'approve'
      ? '用户通过确定性确认控件批准；语言模型调用数为 0'
      : '反馈已保存并交回原智能阶段',
  });
};

interface DatasetRoleRecoveryRequest {
  runtime: ThetaRuntimeComposition;
  scope: RuntimeScope;
  workspace: DatasetWorkspace;
  fromState: ThetaWorkflowState;
  sessionId: string;
  userId: string;
}

const recoverDatasetRoleBoundary = async (
  request: DatasetRoleRecoveryRequest,
): Promise<{ waiting: boolean; assistantMessage: string } | null> => {
  if (hasUniqueConfirmedPrimaryTextColumn(request.workspace)) return null;
  const candidates = primaryTextCandidates(request.workspace);
  const messages = new ThetaConversationEventRepository(request.runtime.eventBridge);
  if (candidates.length !== 1) {
    const assistantMessage = candidates.length === 0
      ? '数据理解中还没有形成有效的主文本列候选。我会返回数据探索，重新检查真实列和样本；Planner 不会自行发明正文列。'
      : `数据理解中存在 ${candidates.length} 个主文本列候选（${candidates.map((item) => item.column).join('、')}），尚未落定唯一正文列。我会返回数据探索处理这个歧义。`;
    await messages.append({
      runId: request.scope.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      role: 'assistant',
      content: assistantMessage,
    });
    await runDatasetStateDecision(request.runtime, request.scope, {
      result: { kind: 'completed', variablesPatch: { datasetPrimaryTextConfirmed: false } },
      transition: {
        to: THETA_WORKFLOW_STATES.datasetDiscovery,
        reason: `${request.fromState} cannot continue without exactly one primary text candidate.`,
        variablesPatch: { datasetPrimaryTextConfirmed: false },
      },
    });
    return { waiting: false, assistantMessage };
  }

  const candidate = candidates[0];
  const assistantMessage = [
    `进入下一阶段前需要落定唯一主文本列。根据数据探索，Agent 建议使用「${candidate.column}」作为正文列。`,
    '你可以直接确认、指定另一列；如果你不确定，也可以回答“按你的判断”，系统会采用这项有证据的建议。',
  ].join('\n');
  await messages.append({
    runId: request.scope.runId,
    sessionId: request.sessionId,
    userId: request.userId,
    role: 'assistant',
    content: assistantMessage,
  });
  await runDatasetStateDecision(request.runtime, request.scope, {
    result: {
      kind: 'completed',
      variablesPatch: {
        datasetWorkspaceHash: request.workspace.workspaceHash,
        datasetPrimaryTextConfirmed: false,
      },
    },
    transition: {
      to: THETA_WORKFLOW_STATES.datasetCheckpoint,
      reason: `${request.fromState} reached the mandatory unique-primary-text boundary.`,
      variablesPatch: {
        datasetWorkspaceHash: request.workspace.workspaceHash,
        datasetPrimaryTextConfirmed: false,
      },
    },
  });
  const checkpoint = await new ThetaCheckpointEventRepository(request.runtime.eventBridge).proposeDataset({
    runId: request.scope.runId,
    sessionId: request.sessionId,
    userId: request.userId,
    workspace: request.workspace,
    requestedBy: 'fsm',
    rationale: `A unique primary text column must be confirmed before leaving DatasetDiscovery; Agent recommends ${candidate.column}.`,
  });
  await request.runtime.humanWaits.create({
    commandId: `create-wait:${checkpoint.checkpointId}`,
    scope: request.scope,
    ownerId: 'theta-v6-checkpoint',
    leaseTtlMs: 30_000,
    waitId: `wait:${checkpoint.checkpointId}`,
    pendingActionRef: checkpoint.checkpointId,
    reason: assistantMessage,
    requestedAt: new Date().toISOString(),
  });
  return { waiting: true, assistantMessage };
};

const runtimeDriver = (
  runtime: ThetaRuntimeComposition,
  executeState: FencedBoundedFSMDriverOptions['executeState'],
) =>
  new FencedBoundedFSMDriver({
    events: runtime.events,
    projections: runtime.projections,
    projectionStore: runtime.projectionStore,
    runLeases: runtime.runLeases,
    stateClaims: runtime.stateClaims,
    executeState,
    evaluateGuard: (transition, context) =>
      transition.guard === undefined || evaluateThetaV6Guard(transition.guard, context),
    nextId: (namespace) => `${namespace}.${randomUUID()}`,
  });

const runDatasetStateDecision = async (
  runtime: ThetaRuntimeComposition,
  scope: RuntimeScope,
  decision: Awaited<ReturnType<FencedBoundedFSMDriverOptions['executeState']>>,
) => runtimeDriver(runtime, async () => decision).run({
  scope,
  process: compileThetaTrainingDomain().fsmProcess,
  ownerId: 'theta-v6-dataset-agent',
  maxSteps: 1,
  leaseTtlMs: 30_000,
  stateClaimTtlMs: 30_000,
});

const enterToolFailureRecovery = async (
  runtime: ThetaRuntimeComposition,
  scope: RuntimeScope,
  error: ThetaToolCircuitOpenError,
): Promise<void> => {
  const variables = {
    recoveryReason: error.message,
    recoveryToolId: error.state.toolId,
    recoveryFailureCount: error.state.consecutiveFailures,
  };
  await runDatasetStateDecision(runtime, scope, {
    result: { kind: 'completed', variablesPatch: variables },
    transition: {
      to: THETA_WORKFLOW_STATES.recovering,
      reason: error.message,
      variablesPatch: variables,
    },
  });
  await runDatasetStateDecision(runtime, scope, {
    result: { kind: 'completed', variablesPatch: variables },
    transition: {
      to: THETA_WORKFLOW_STATES.humanRecovery,
      reason: '同一工具连续失败超过5次，已停止自动流程并等待人工处理。',
      variablesPatch: variables,
    },
  });
};

const seedRun = async (
  runtime: ThetaRuntimeComposition,
  scope: RuntimeScope,
  input: Record<string, unknown>,
): Promise<void> => {
  if (await runtime.events.getStreamHead(eventScope(scope))) {
    throw new Error(`Run already exists: ${scope.runId}`);
  }
  const timestamp = new Date().toISOString();
  const event = (id: string, type: EventCreateInput['type'], payload: Record<string, unknown>): EventCreateInput => ({
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
  await runtime.events.append({
    scope: eventScope(scope),
    events: [event(`${scope.runId}:created`, 'run.created', { runId: scope.runId, input })],
    expectedLastSequence: 0,
    idempotencyKey: `theta-v6-run-create:${scope.runId}`,
  });
};

const projectVariables = (events: readonly FrameworkEvent[]): Record<string, unknown> => {
  const variables: Record<string, unknown> = {};
  for (const event of events) {
    if (event.type !== 'fsm.transition.accepted') continue;
    const payload = record(event.payload);
    Object.assign(variables, record(payload.variablesPatch));
  }
  return variables;
};

const resolveHumanWait = async (
  runtime: ThetaRuntimeComposition,
  scope: RuntimeScope,
  snapshot: ThetaAgentRunSnapshot,
  principalId: string,
  decision: 'approved' | 'rejected',
): Promise<void> => {
  if (!snapshot.pendingActionRef) throw new Error('Pending Human Wait action ref is missing.');
  const result = await runtime.humanWaits.resolve({
    commandId: `resolve-wait:${randomUUID()}`,
    scope,
    ownerId: 'theta-v6-checkpoint',
    leaseTtlMs: 30_000,
    pendingActionRef: snapshot.pendingActionRef,
    principalId,
    decision,
    resolvedAt: new Date().toISOString(),
  });
  if (result.disposition === 'lease_unavailable') throw new Error('The current human-wait lease is unavailable.');
};

const initialMessageFrom = (events: readonly FrameworkEvent[]): string => {
  const created = events.find((event) => event.type === 'run.created');
  const input = record(record(created?.payload).input);
  return typeof input.initialMessage === 'string' ? input.initialMessage.trim() : '';
};

const managedUploadRoot = (runtimeDb: string): string =>
  path.resolve(process.env.THETA_DATASET_UPLOAD_DIR ?? path.join(path.dirname(path.resolve(runtimeDb)), 'uploads'));

const runtimeScope = (runId: string, userId: string, workspaceId: string): RuntimeScope => ({
  userId,
  workspaceId,
  sessionId: `session:${runId}`,
  runId,
  agentId: 'agent.theta.research-training',
});

const eventScope = (scope: RuntimeScope) => ({ userId: scope.userId, runId: scope.runId });

const safeReactFailureSummary = (react: unknown): Record<string, unknown> => {
  const reactRecord = record(react);
  const checkpoint = record(reactRecord.checkpoint);
  const finalAction = record(reactRecord.finalAction);
  const finalInput = record(finalAction.input);
  const suspension = record(reactRecord.suspension);
  const safeCheckpoint = Object.fromEntries(
    ['iterations', 'modelCalls', 'toolCalls', 'totalTokens', 'consecutiveNoProgress']
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof checkpoint[key]))
      .map((key) => [key, checkpoint[key]]),
  );
  return {
    ...(typeof suspension.reason === 'string' ? { suspensionReason: suspension.reason } : {}),
    ...(Object.keys(safeCheckpoint).length === 0 ? {} : { checkpoint: safeCheckpoint }),
    ...(Object.keys(finalAction).length === 0
      ? {}
      : {
          finalAction: {
            type: typeof finalAction.type === 'string' ? finalAction.type : 'unknown',
            ...(typeof finalAction.target === 'string' ? { target: finalAction.target } : {}),
            ...(typeof finalInput.kind === 'string' ? { kind: finalInput.kind } : {}),
          },
        }),
  };
};

const isQuantumYield = (result: unknown): boolean => {
  const resultRecord = record(result);
  return resultRecord.disposition === 'suspended'
    && record(record(resultRecord.react).suspension).reason === 'quantum_exhausted';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
