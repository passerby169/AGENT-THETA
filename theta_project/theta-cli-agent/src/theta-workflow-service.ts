import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  EventCreateInput,
  FrameworkEvent,
  PersistedFrameworkEvent,
  RuntimeJsonValue,
  RuntimeOrchestrationProjection,
  RuntimeScope,
} from "@hypha/core";
import type {
  BoundedFSMDriverResult,
  BoundedStateExecutionDecision,
  BoundedStateExecutorInput,
} from "@hypha/harness";
import type { ToolCallResult } from "@hypha/tools";
import { decideResearchGrilling } from "./agent/grilling-engine.js";
import {
  RESEARCH_CONTRACT_VERSION,
  columnConfirmationDraftSchema,
  columnConfirmationSchema,
  datasetProfileSchema,
  researchBriefPatchSchema,
  researchBriefSchema,
  type ColumnConfirmationDraft,
  type DatasetProfile,
} from "./agent/research-contracts.js";
import {
  ResearchService,
  type ResearchAssessment,
} from "./agent/research-service.js";
import {
  approvalReceiptSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
} from "./planning/contracts.js";
import {
  assertApprovalChain,
  createApprovalReceipt,
} from "./planning/engine.js";
import {
  THETA_APPROVAL_KEYS,
  THETA_DOMAIN_PACK_ID,
  THETA_DOMAIN_PACK_VERSION,
  THETA_WORKFLOW_STATES,
  compileThetaTrainingDomain,
  resolveThetaStateToolScope,
} from "./theta-domain.js";
import {
  JsonlToolTraceRecorder,
  createThetaWorkflowRuntime,
  defaultThetaWorkflowDb,
  thetaToolTraceFile,
} from "./theta-workflow-runtime.js";
import {
  createThetaGovernedToolRunner,
  createThetaToolCallContext,
} from "./tools/hypha-runner.js";
import type { ThetaTrainingPlan } from "./tools/plan-validate-tool.js";
import { THETA_TOOL_IDS } from "./tools/tool-ids.js";

const USER_ID = "local_user";
const WORKSPACE_ID = "local_workspace";
const AGENT_ID = "agent.theta.cli";
const DRIVER_OWNER = "theta-cli-workflow-driver";
const LEASE_TTL_MS = 60_000;
const STATE_CLAIM_TTL_MS = 30_000;
const MAX_STEPS = 64;

export interface ThetaWorkflowInput {
  filePath: string;
  datasetId?: string;
  researchGoal?: string;
  research?: Record<string, unknown>;
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
  researchAnswers?: Record<string, unknown>;
  columnConfirmation?: ColumnConfirmationDraft;
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
  disposition: BoundedFSMDriverResult["disposition"];
  status: RuntimeOrchestrationProjection["runStatus"];
  currentState?: string;
  pendingActionRef?: string;
  pendingReason?: string;
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
    if (result.status === "human_review_required" && request.approvedBy) {
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
    const runId = required(request.runId, "runId");
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
      const hasResearchAnswers = request.researchAnswers !== undefined;
      const hasColumnConfirmation = request.columnConfirmation !== undefined;
      if (hasResearchAnswers && hasColumnConfirmation) {
        throw new Error(
          "A resume command can submit research answers or a column confirmation, not both.",
        );
      }
      if (hasResearchAnswers || hasColumnConfirmation) {
        await this.recordStructuredResumeInput(
          runtime,
          scope,
          result.projection,
          request,
        );
      }
      if (
        request.approve &&
        !hasResearchAnswers &&
        !hasColumnConfirmation &&
        requiresStructuredHumanInput(
          result.projection.pendingWait?.pendingActionRef,
        )
      ) {
        throw new Error(
          "This human wait requires structured input instead of a bare approval.",
        );
      }
      if (
        result.disposition === "waiting" &&
        result.projection.pendingWait?.type === "human" &&
        (request.approve ||
          request.reject ||
          hasResearchAnswers ||
          hasColumnConfirmation)
      ) {
        await this.resolveHumanWait(
          runtime,
          scope,
          result.projection,
          request.reject ? "rejected" : "approved",
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
    const resolvedRunId = required(runId, "runId");
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
      .filter((event) => event.type === "fsm.state.entered")
      .map((event) => stringProperty(event.payload, "stateId"))
      .filter((value): value is string => value !== undefined);
    const toolCalls = unique(
      evidence.toolEvents
        .filter((event) => event.type === "tool.call.completed")
        .map((event) => stringProperty(event.payload, "toolId"))
        .filter((value): value is string => value !== undefined),
    );
    const policyDecisions = evidence.toolEvents
      .filter((event) => event.type === "tool.policy.checked")
      .map((event) => {
        const decision = recordProperty(event.payload, "decision");
        return (
          stringValue(decision?.ruleId) ??
          stringProperty(event.payload, "ruleId") ??
          event.id
        );
      });
    const terminal = [...evidence.orchestrationEvents]
      .reverse()
      .find((event) => event.type === "run.completed");
    const output = recordProperty(terminal?.payload, "output") as
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
      digest: createHash("sha256").update(canonicalJson(fixture)).digest("hex"),
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
        result.disposition !== "waiting" ||
        pending?.type !== "human" ||
        !pending.pendingActionRef ||
        requiresStructuredHumanInput(pending.pendingActionRef) ||
        !approvals.has(pending.pendingActionRef)
      ) {
        return result;
      }
      await this.resolveHumanWait(
        runtime,
        scope,
        result.projection,
        "approved",
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
    decision: "approved" | "rejected",
    principalId: string,
  ): Promise<void> {
    const pending = projection.pendingWait;
    if (pending?.type !== "human" || !pending.pendingActionRef) {
      throw new Error(
        "THETA workflow is not waiting for a resolvable human action.",
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

  private async recordStructuredResumeInput(
    runtime: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>,
    scope: RuntimeScope,
    projection: RuntimeOrchestrationProjection,
    request: ThetaWorkflowResumeRequest,
  ): Promise<void> {
    const pending = projection.pendingWait;
    if (pending?.type !== "human" || !pending.pendingActionRef) {
      throw new Error(
        "Structured resume input requires a pending human workflow action.",
      );
    }
    const payload: Record<string, unknown> = {
      pendingActionRef: pending.pendingActionRef,
    };
    if (request.researchAnswers !== undefined) {
      if (
        pending.pendingActionRef !== THETA_APPROVAL_KEYS.researchClarification
      ) {
        throw new Error(
          `Research answers cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      payload.researchAnswers = researchBriefPatchSchema.parse(
        request.researchAnswers,
      );
    }
    if (request.columnConfirmation !== undefined) {
      if (pending.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation) {
        throw new Error(
          `Column confirmation cannot resolve ${pending.pendingActionRef}.`,
        );
      }
      const variables = await hydrateVariables(runtime.events, scope);
      const profile = datasetProfileSchema.parse(variables.datasetProfile);
      payload.columnConfirmation = {
        draft: columnConfirmationDraftSchema.parse(request.columnConfirmation),
        datasetSha256: profile.datasetSha256,
      };
    }
    const head = await runtime.events.getStreamHead(streamScope(scope));
    const submissionId = createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex")
      .slice(0, 24);
    await runtime.events.append({
      scope: streamScope(scope),
      events: [
        {
          id: `${scope.runId}:structured-resume:${submissionId}`,
          type: "reasoning.decision.recorded",
          version: "1.0.0",
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          runId: scope.runId,
          agentId: scope.agentId,
          correlationId: scope.runId,
          timestamp: this.now(),
          payload,
        },
      ],
      expectedLastSequence: head?.lastSequence ?? 0,
      ...(head?.fencingToken === undefined
        ? {}
        : { fencingToken: head.fencingToken }),
      idempotencyKey: `theta-structured-resume:${scope.runId}:${submissionId}`,
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
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  tools: ThetaWorkflowToolPort,
): Promise<BoundedStateExecutionDecision> => {
  const variables = await hydrateVariables(events, execution.scope);
  const researchService = new ResearchService();
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
      case THETA_WORKFLOW_STATES.intake: {
        const input = requireRecord(
          variables.input,
          "workflow input",
        ) as unknown as ThetaWorkflowInput;
        validateInput(input);
        const assessment = researchService.assess(
          researchService.createBrief(input),
          { currentState: execution.state.id },
        );
        return transition(
          assessment.blocking
            ? THETA_WORKFLOW_STATES.awaitResearchClarification
            : THETA_WORKFLOW_STATES.inspectDataset,
          {
            researchBrief: runtimeRecord({ ...assessment.brief }),
            researchAssessment: sanitizeResearchAssessment(assessment),
          },
        );
      }
      case THETA_WORKFLOW_STATES.awaitResearchClarification: {
        const resume = isRecord(execution.projection.lastResume?.payload)
          ? execution.projection.lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !== THETA_APPROVAL_KEYS.researchClarification
        ) {
          const assessment = researchService.assess(
            researchBriefSchema.parse(variables.researchBrief),
            { currentState: execution.state.id },
          );
          return researchClarificationWait(assessment);
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human rejected the research clarification request.",
            execution.state.id,
          );
        }
        const answers = requireRecord(
          variables.researchAnswers,
          "research clarification answers",
        );
        const assessment = researchService.assess(
          researchService.applyAnswers(
            researchBriefSchema.parse(variables.researchBrief),
            answers,
          ),
          { currentState: execution.state.id },
        );
        const grilling = decideResearchGrilling(
          assessment,
          execution.projection.stateAttempt,
        );
        if (grilling.kind === "unresolved") {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `Blocking research information remains unresolved: ${assessment.gaps
              .filter((item) => item.severity === "blocking")
              .map((item) => item.field)
              .join(", ")}.`,
            execution.state.id,
          );
        }
        if (grilling.kind === "ask") {
          return researchClarificationWait(assessment);
        }
        return transition(THETA_WORKFLOW_STATES.inspectDataset, {
          researchBrief: runtimeRecord({ ...assessment.brief }),
          researchAssessment: sanitizeResearchAssessment(assessment),
        });
      }
      case THETA_WORKFLOW_STATES.inspectDataset: {
        const input = requireRecord(variables.input, "workflow input");
        const toolInput = {
          filePath: requiredString(input.filePath, "input.filePath"),
          ...(numberValue(input.sampleSize) === undefined
            ? {}
            : { sampleSize: numberValue(input.sampleSize) }),
        };
        const [inspection, columns] = await Promise.all([
          invoke(THETA_TOOL_IDS.datasetInspect, toolInput),
          invoke(THETA_TOOL_IDS.datasetDetectColumns, toolInput),
        ]);
        const datasetProfile = sanitizeDatasetProfile(inspection, columns);
        const observedBrief = researchService.applyAnswers(
          researchBriefSchema.parse(variables.researchBrief),
          {
            expectedRowCount: datasetProfile.rowCount,
            candidateTimeColumns: datasetProfile.columnCandidates.time.map(
              (candidate) => candidate.name,
            ),
            candidateGroupColumns: datasetProfile.columnCandidates.metadata.map(
              (candidate) => candidate.name,
            ),
          },
        );
        const observedAssessment = researchService.assess(observedBrief, {
          currentState: execution.state.id,
        });
        return transition(THETA_WORKFLOW_STATES.awaitColumnConfirmation, {
          datasetProfile,
          researchBrief: runtimeRecord({ ...observedAssessment.brief }),
          researchAssessment: sanitizeResearchAssessment(observedAssessment),
        });
      }
      case THETA_WORKFLOW_STATES.awaitColumnConfirmation: {
        const datasetProfile = datasetProfileSchema.parse(
          variables.datasetProfile,
        );
        const resume = isRecord(execution.projection.lastResume?.payload)
          ? execution.projection.lastResume.payload
          : undefined;
        if (
          resume?.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation
        ) {
          return columnConfirmationWait(datasetProfile);
        }
        if (resume.decision === "rejected") {
          return failed(
            "RUNTIME_CANCELLED",
            "Human rejected the dataset column confirmation.",
            execution.state.id,
          );
        }
        if (!isRecord(variables.columnConfirmation)) {
          return columnConfirmationWait(datasetProfile);
        }
        const submission = variables.columnConfirmation;
        if (
          requiredString(
            submission.datasetSha256,
            "submitted datasetSha256",
          ) !== datasetProfile.datasetSha256
        ) {
          return columnConfirmationWait(datasetProfile);
        }
        const input = requireRecord(variables.input, "workflow input");
        const latestInspection = await invoke(THETA_TOOL_IDS.datasetInspect, {
          filePath: requiredString(input.filePath, "input.filePath"),
          ...(numberValue(input.sampleSize) === undefined
            ? {}
            : { sampleSize: numberValue(input.sampleSize) }),
        });
        if (
          requiredString(
            latestInspection.datasetSha256,
            "latest datasetSha256",
          ) !== datasetProfile.datasetSha256
        ) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            datasetInvalidation: {
              reason: "dataset_hash_changed_before_column_confirmation",
              previousDatasetSha256: datasetProfile.datasetSha256,
              detectedDatasetSha256: requiredString(
                latestInspection.datasetSha256,
                "latest datasetSha256",
              ),
            },
            columnConfirmation: null,
          });
        }
        const draft = columnConfirmationDraftSchema.parse(submission.draft);
        validateConfirmedColumns(draft, datasetProfile.columns);
        const confirmation = columnConfirmationSchema.parse({
          ...draft,
          schemaVersion: RESEARCH_CONTRACT_VERSION,
          datasetSha256: datasetProfile.datasetSha256,
          confirmedBy: execution.projection.lastResume?.principalId ?? USER_ID,
          confirmedAt:
            execution.projection.lastResume?.resumedAt ??
            new Date().toISOString(),
        });
        return transition(THETA_WORKFLOW_STATES.recommendModel, {
          columnConfirmation: confirmation,
        });
      }
      case THETA_WORKFLOW_STATES.recommendModel: {
        const input = requireRecord(variables.input, "workflow input");
        const datasetProfile = requireRecord(
          variables.datasetProfile,
          "dataset profile",
        );
        const researchBrief = requireRecord(
          variables.researchBrief,
          "research brief",
        );
        const columnConfirmation = requireRecord(
          variables.columnConfirmation,
          "column confirmation",
        );
        const [catalog, evidenceResult] = await Promise.all([
          invoke(THETA_TOOL_IDS.modelCatalog, {}),
          invoke(THETA_TOOL_IDS.ragSearch, {
            query: [
              stringValue(researchBrief.researchQuestion),
              stringValue(input.researchGoal),
              "THETA topic model requirements parameters hardware",
            ]
              .filter((item): item is string => Boolean(item))
              .join(" "),
            limit: 10,
          }),
        ]);
        const recommendation = await invoke(THETA_TOOL_IDS.modelRecommend, {
          dataProfile: datasetProfile,
          researchBrief,
          columnConfirmation,
          evidence: arrayValue(evidenceResult.evidence),
          ...(stringValue(input.researchGoal)
            ? { researchGoal: input.researchGoal }
            : {}),
          ...(isRecord(input.constraints)
            ? { constraints: input.constraints }
            : {}),
        });
        if (arrayValue(recommendation.recommendations).length === 0) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `No compatible model remains after hard constraints: ${stringArray(
              recommendation.warnings,
            ).join(", ")}`,
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.validatePlan, {
          modelCatalog: sanitizeCatalog(catalog),
          evidence: {
            noEvidence: evidenceResult.noEvidence === true,
            refs: arrayValue(evidenceResult.evidence) as RuntimeJsonValue[],
          },
          recommendation: sanitizeRecommendation(recommendation),
          candidatePlan: candidatePlan(
            input,
            datasetProfile,
            recommendation,
            columnConfirmation,
          ),
        });
      }
      case THETA_WORKFLOW_STATES.validatePlan: {
        const candidate = requireRecord(
          variables.candidatePlan,
          "candidate plan",
        );
        const validation = await invoke(THETA_TOOL_IDS.planValidate, {
          plan: candidate,
          dataProfile: requireRecord(
            variables.datasetProfile,
            "dataset profile",
          ),
        });
        if (validation.valid !== true) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `Candidate plan is invalid: ${stringArray(validation.errors).join("; ")}`,
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.awaitPlanCreationApproval, {
          validatedPlan: requireRecord(
            validation.normalizedPlan,
            "normalized plan",
          ),
          validation: {
            valid: true,
            warnings: stringArray(validation.warnings),
            catalogSource: stringValue(validation.catalogSource) ?? "unknown",
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitPlanCreationApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.planReview,
          THETA_WORKFLOW_STATES.createPlan,
          {
            validatedPlan: variables.validatedPlan as RuntimeJsonValue,
            datasetSha256: datasetProfileSchema.parse(variables.datasetProfile)
              .datasetSha256,
            columnConfirmation:
              variables.columnConfirmation as RuntimeJsonValue,
            recommendation: variables.recommendation as RuntimeJsonValue,
          },
        );
      case THETA_WORKFLOW_STATES.createPlan: {
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.planReview,
        );
        const created = await invoke(
          THETA_TOOL_IDS.planCreate,
          {
            validatedPlan: requireRecord(
              variables.validatedPlan,
              "validated plan",
            ),
            researchBrief: requireRecord(
              variables.researchBrief,
              "research brief",
            ),
            datasetProfile: requireRecord(
              variables.datasetProfile,
              "dataset profile",
            ),
            columnConfirmation: requireRecord(
              variables.columnConfirmation,
              "column confirmation",
            ),
            recommendation: requireRecord(
              variables.recommendation,
              "recommendation",
            ),
            domainPack: {
              id: THETA_DOMAIN_PACK_ID,
              version: THETA_DOMAIN_PACK_VERSION,
            },
          },
          approvedBy,
        );
        const planRecord = trainingPlanRecordSchema.parse(created);
        const reviewDecision = approvalDecisionRecord(
          variables,
          THETA_APPROVAL_KEYS.planReview,
        );
        const planReview = createApprovalReceipt({
          approvalType: "human_plan_review",
          plan: planRecord,
          approvedBy,
          approvedAt: reviewDecision.approvedAt,
        });
        return transition(THETA_WORKFLOW_STATES.dryRun, {
          planRecord,
          planReview,
        });
      }
      case THETA_WORKFLOW_STATES.dryRun: {
        const input = requireRecord(variables.input, "workflow input");
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const planReview = approvalReceiptSchema.parse(variables.planReview);
        const preview = await invoke(THETA_TOOL_IDS.trainingDryRun, {
          plan,
          planReview,
          datasetPath: requiredString(input.filePath, "input.filePath"),
        });
        const dryRun = dryRunReceiptSchema.parse(preview);
        if (!dryRun.passed) {
          return failed(
            "RUNTIME_INVARIANT_FAILED",
            `Training dry run failed: ${dryRun.checks
              .filter((check) => check.status === "fail")
              .map((check) => check.code)
              .join(", ")}.`,
            execution.state.id,
          );
        }
        return transition(THETA_WORKFLOW_STATES.awaitTrainingStartApproval, {
          dryRun,
          dryRunSummary: {
            planHash: dryRun.planHash,
            dryRunHash: dryRun.dryRunHash,
            commandCount: dryRun.commands.length,
            commands: dryRun.commands,
            checks: dryRun.checks,
            expectedArtifacts: dryRun.expectedArtifacts.map(sanitizeArtifact),
            notes: dryRun.notes,
          },
        });
      }
      case THETA_WORKFLOW_STATES.awaitTrainingStartApproval:
        return approvalDecision(
          execution,
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
          THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
          requireRecord(variables.dryRunSummary, "dry-run summary") as Record<
            string,
            RuntimeJsonValue
          >,
        );
      case THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining: {
        const input = requireRecord(variables.input, "workflow input");
        const profile = datasetProfileSchema.parse(variables.datasetProfile);
        const inspection = await invoke(THETA_TOOL_IDS.datasetInspect, {
          filePath: requiredString(input.filePath, "input.filePath"),
          ...(numberValue(input.sampleSize) === undefined
            ? {}
            : { sampleSize: numberValue(input.sampleSize) }),
        });
        const currentSha256 = requiredString(
          inspection.datasetSha256,
          "training datasetSha256",
        );
        if (currentSha256 !== profile.datasetSha256) {
          return transition(THETA_WORKFLOW_STATES.inspectDataset, {
            datasetInvalidation: {
              reason: "dataset_hash_changed_before_training",
              previousDatasetSha256: profile.datasetSha256,
              detectedDatasetSha256: currentSha256,
              planApprovalInvalidated: true,
              trainingApprovalInvalidated: true,
            },
            columnConfirmation: null,
            planRecord: null,
            planReview: null,
            dryRun: null,
            trainingReview: null,
          });
        }
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const dryRun = dryRunReceiptSchema.parse(variables.dryRun);
        const reviewDecision = approvalDecisionRecord(
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
        );
        const trainingReview = createApprovalReceipt({
          approvalType: "human_training_review",
          plan,
          approvedBy: reviewDecision.approvedBy,
          approvedAt: reviewDecision.approvedAt,
          dryRunHash: dryRun.dryRunHash,
        });
        return transition(THETA_WORKFLOW_STATES.startTraining, {
          trainingReview,
        });
      }
      case THETA_WORKFLOW_STATES.startTraining: {
        const plan = trainingPlanRecordSchema.parse(variables.planRecord);
        const planReview = approvalReceiptSchema.parse(variables.planReview);
        const dryRun = dryRunReceiptSchema.parse(variables.dryRun);
        const trainingReview = approvalReceiptSchema.parse(
          variables.trainingReview,
        );
        assertApprovalChain({ plan, planReview, dryRun, trainingReview });
        const approvedBy = approvalActor(
          variables,
          THETA_APPROVAL_KEYS.trainingReview,
        );
        const started = await invoke(
          THETA_TOOL_IDS.trainingStart,
          {
            plan,
            planReview,
            dryRun,
            trainingReview,
            idempotencyKey: createHash("sha256")
              .update(
                `${execution.scope.userId}:${plan.planId}:${plan.planHash}:training.start`,
              )
              .digest("hex"),
          },
          approvedBy,
        );
        return transition(THETA_WORKFLOW_STATES.monitorTraining, {
          training: {
            trainingRunId: requiredString(
              started.trainingRunId,
              "trainingRunId",
            ),
            status: stringValue(started.status) ?? "running",
            progress: numberValue(started.progress) ?? 0,
            currentStep: stringValue(started.currentStep) ?? "starting",
          },
        });
      }
      case THETA_WORKFLOW_STATES.monitorTraining: {
        const training = requireRecord(variables.training, "training state");
        const status = await invoke(THETA_TOOL_IDS.trainingStatus, {
          trainingRunId: requiredString(
            training.trainingRunId,
            "trainingRunId",
          ),
          logLimit: 20,
        });
        const normalizedStatus = (
          stringValue(status.status) ?? "unknown"
        ).toLowerCase();
        if (["completed", "succeeded", "success"].includes(normalizedStatus)) {
          const plan = requireRecord(variables.planRecord, "plan record");
          const validatedPlan = requireRecord(
            variables.validatedPlan,
            "validated plan",
          );
          return transition(
            THETA_WORKFLOW_STATES.completed,
            {
              training: sanitizeTrainingStatus(status),
            },
            {
              runId: execution.scope.runId,
              status: normalizedStatus,
              modelId: requiredString(validatedPlan.modelId, "modelId"),
              planId: requiredString(plan.planId, "planId"),
              trainingRunId: requiredString(
                status.trainingRunId,
                "trainingRunId",
              ),
              artifacts: arrayValue(status.artifacts).map(sanitizeArtifact),
            },
          );
        }
        if (["failed", "error"].includes(normalizedStatus)) {
          return failed(
            "RUNTIME_INTERNAL_ERROR",
            `Training run failed in state ${stringValue(status.currentStep) ?? "unknown"}.`,
            execution.state.id,
          );
        }
        if (normalizedStatus === "cancelled") {
          return transition(THETA_WORKFLOW_STATES.cancelled, {
            training: sanitizeTrainingStatus(status),
          });
        }
        return {
          result: {
            kind: "waiting",
            wait: {
              type: "timer",
              expiresAt: new Date(Date.now() + 1_000).toISOString(),
              reason:
                "Training is still running; poll again after the durable timer fires.",
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
          "RUNTIME_STATE_NOT_FOUND",
          `THETA workflow has no executor for state ${execution.state.id}.`,
          execution.state.id,
        );
    }
  } catch (error) {
    return failed(
      "RUNTIME_INTERNAL_ERROR",
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
  metadata: Record<string, RuntimeJsonValue> = {},
): BoundedStateExecutionDecision => {
  const payload = isRecord(execution.projection.lastResume?.payload)
    ? execution.projection.lastResume.payload
    : undefined;
  if (payload?.pendingActionRef === pendingActionRef) {
    if (payload.decision === "rejected") {
      return failed(
        "RUNTIME_CANCELLED",
        `Human rejected ${pendingActionRef}.`,
        execution.state.id,
      );
    }
    if (payload.decision === "approved") {
      const priorActors = isRecord(variables.approvalActors)
        ? variables.approvalActors
        : {};
      return transition(approvedTarget, {
        approvalActors: {
          ...priorActors,
          [pendingActionRef]:
            execution.projection.lastResume?.principalId ?? USER_ID,
        },
        approvalDecisions: {
          ...(isRecord(variables.approvalDecisions)
            ? variables.approvalDecisions
            : {}),
          [pendingActionRef]: {
            approvedBy: execution.projection.lastResume?.principalId ?? USER_ID,
            approvedAt:
              execution.projection.lastResume?.resumedAt ??
              new Date().toISOString(),
          },
        },
      });
    }
  }
  return {
    result: {
      kind: "waiting",
      wait: {
        type: "human",
        pendingActionRef,
        reason: `Explicit owner approval is required for ${pendingActionRef}.`,
        metadata: { stateId: execution.state.id, ...metadata },
      },
    },
  };
};

const approvalDecisionRecord = (
  variables: Record<string, unknown>,
  key: string,
): { approvedBy: string; approvedAt: string } => {
  const decisions = requireRecord(
    variables.approvalDecisions,
    "approval decisions",
  );
  const decision = requireRecord(
    decisions[key],
    `approval decision for ${key}`,
  );
  return {
    approvedBy: requiredString(decision.approvedBy, `approvedBy for ${key}`),
    approvedAt: requiredString(decision.approvedAt, `approvedAt for ${key}`),
  };
};

const requiresStructuredHumanInput = (
  pendingActionRef: string | undefined,
): boolean =>
  pendingActionRef === THETA_APPROVAL_KEYS.researchClarification ||
  pendingActionRef === THETA_APPROVAL_KEYS.columnConfirmation;

const researchClarificationWait = (
  assessment: ResearchAssessment,
): BoundedStateExecutionDecision => {
  const grilling = decideResearchGrilling(assessment, 1);
  return {
    result: {
      kind: "waiting",
      wait: {
        type: "human",
        pendingActionRef: THETA_APPROVAL_KEYS.researchClarification,
        reason:
          grilling.activeQuestion ??
          "Structured research clarification is required.",
        metadata: sanitizeResearchAssessment(assessment),
      },
    },
  };
};

const columnConfirmationWait = (
  profile: DatasetProfile,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "waiting",
    wait: {
      type: "human",
      pendingActionRef: THETA_APPROVAL_KEYS.columnConfirmation,
      reason:
        "Confirm the text, time, ID, and metadata column roles for this dataset hash.",
      metadata: {
        datasetSha256: profile.datasetSha256,
        columns: profile.columns,
        columnCandidates: profile.columnCandidates,
      },
    },
  },
});

const sanitizeResearchAssessment = (
  assessment: ResearchAssessment,
): Record<string, RuntimeJsonValue> =>
  runtimeRecord({
    brief: assessment.brief,
    gaps: assessment.gaps,
    conflicts: assessment.conflicts,
    questions: assessment.questions,
    blocking: assessment.blocking,
  });

const validateConfirmedColumns = (
  confirmation: ColumnConfirmationDraft,
  columns: readonly string[],
): void => {
  const selected = [
    ...confirmation.textColumns,
    ...(confirmation.timeColumn ? [confirmation.timeColumn] : []),
    ...(confirmation.idColumn ? [confirmation.idColumn] : []),
    ...confirmation.metadataColumns,
  ];
  const unknown = selected.filter((name) => !columns.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Column confirmation references unknown columns: ${unique(unknown).join(", ")}.`,
    );
  }
};

const transition = (
  to: string,
  variablesPatch?: Record<string, unknown>,
  output?: unknown,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "completed",
    ...(variablesPatch === undefined
      ? {}
      : { variablesPatch: variablesPatch as Record<string, RuntimeJsonValue> }),
    ...(output === undefined ? {} : { output: output as RuntimeJsonValue }),
  },
  transition: { to },
});

const failed = (
  code:
    | "RUNTIME_INVARIANT_FAILED"
    | "RUNTIME_INTERNAL_ERROR"
    | "RUNTIME_STATE_NOT_FOUND"
    | "RUNTIME_CANCELLED",
  message: string,
  stateId: string,
): BoundedStateExecutionDecision => ({
  result: {
    kind: "failed",
    error: { code, message, retryable: false, stateId },
  },
});

const seedRun = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  scope: RuntimeScope,
  input: ThetaWorkflowInput,
  timestamp: string,
): Promise<void> => {
  const existing = await events.getStreamHead(streamScope(scope));
  if (existing) return;
  const event = (
    id: string,
    type: EventCreateInput["type"],
    payload: Record<string, unknown>,
  ): EventCreateInput => ({
    id,
    type,
    version: "1.0.0",
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
      event(`${scope.runId}:created`, "run.created", { runId: scope.runId }),
      event(`${scope.runId}:started`, "run.started", {
        runId: scope.runId,
        input,
      }),
    ],
    expectedLastSequence: 0,
    idempotencyKey: `theta-workflow-seed:${scope.runId}`,
  });
};

const hydrateVariables = async (
  events: Awaited<ReturnType<typeof createThetaWorkflowRuntime>>["events"],
  scope: RuntimeScope,
): Promise<Record<string, unknown>> => {
  const stream = await events.read({ scope: streamScope(scope) });
  const variables: Record<string, unknown> = {};
  for (const event of stream) {
    if (event.type === "run.started") {
      const input = recordProperty(event.payload, "input");
      if (input) variables.input = input;
    }
    if (event.type === "fsm.transition.accepted") {
      const patch = recordProperty(event.payload, "variablesPatch");
      if (patch) Object.assign(variables, patch);
    }
    if (
      event.type === "reasoning.decision.recorded" &&
      stringProperty(event.payload, "pendingActionRef")
    ) {
      const researchAnswers = recordProperty(event.payload, "researchAnswers");
      if (researchAnswers) {
        variables.researchAnswers = {
          ...(isRecord(variables.researchAnswers)
            ? variables.researchAnswers
            : {}),
          ...researchAnswers,
        };
      }
      const columnConfirmation = recordProperty(
        event.payload,
        "columnConfirmation",
      );
      if (columnConfirmation) {
        variables.columnConfirmation = columnConfirmation;
      }
    }
  }
  return variables;
};

const sanitizeDatasetProfile = (
  inspection: Record<string, unknown>,
  columns: Record<string, unknown>,
): DatasetProfile => {
  const columnNames = stringArray(inspection.columns);
  const profiles = arrayValue(inspection.columnProfiles).map((value) =>
    isRecord(value) ? value : {},
  );
  const missingRatio =
    profiles.length === 0
      ? 0
      : profiles.reduce(
          (total, profile) =>
            total + (numberValue(profile.missingSampleRatio) ?? 0),
          0,
        ) / profiles.length;
  const averageTextLength =
    profiles.length === 0
      ? 0
      : profiles.reduce(
          (total, profile) => total + (numberValue(profile.avgLength) ?? 0),
          0,
        ) / profiles.length;
  const maximumTextLength = profiles.reduce(
    (maximum, profile) =>
      Math.max(maximum, numberValue(profile.maxLength) ?? 0),
    0,
  );
  return datasetProfileSchema.parse({
    schemaVersion: RESEARCH_CONTRACT_VERSION,
    datasetSha256: requiredString(inspection.datasetSha256, "datasetSha256"),
    fileName: stringValue(inspection.fileName) ?? "unknown",
    fileSizeBytes: numberValue(inspection.fileSizeBytes) ?? 0,
    format: stringValue(inspection.suffix)?.replace(/^\./, "") || "unknown",
    encoding: stringValue(inspection.encoding) ?? "unknown",
    rowCount: numberValue(inspection.rowCount) ?? 0,
    columnCount: columnNames.length,
    columns: columnNames,
    missingRatio,
    duplicateRatio: numberValue(inspection.sampleDuplicateRatio) ?? 0,
    textLengthDistribution: {
      average: averageTextLength,
      maximum: maximumTextLength,
    },
    languageDistribution: arrayValue(inspection.languageDistribution).map(
      (value) => {
        const distribution = isRecord(value) ? value : {};
        return {
          language: stringValue(distribution.language) ?? "unknown",
          ratio: numberValue(distribution.ratio) ?? 0,
        };
      },
    ),
    timeCoverage: {
      start: nullableStringProperty(inspection.timeCoverage, "start"),
      end: nullableStringProperty(inspection.timeCoverage, "end"),
    },
    columnCandidates: {
      text: sanitizeCandidates(columns.textColumns),
      time: sanitizeCandidates(columns.timeColumns),
      metadata: sanitizeCandidates(columns.metadataColumns),
    },
    sensitiveRiskCodes: sensitiveRiskCodes(columnNames),
  });
};

const sanitizeCandidates = (
  value: unknown,
): Array<{ name: string; score: number; reason: string }> =>
  arrayValue(value).map((candidate) => {
    const item = isRecord(candidate) ? candidate : {};
    return {
      name: stringValue(item.name) ?? "",
      score: numberValue(item.score) ?? 0,
      reason: stringValue(item.reason) ?? "",
    };
  });

const sensitiveRiskCodes = (columns: readonly string[]): string[] => {
  const risks = new Set<string>();
  for (const column of columns) {
    const normalized = column.toLowerCase();
    if (/(email|e-mail)/.test(normalized)) risks.add("possible_email");
    if (/(phone|mobile|tel)/.test(normalized)) risks.add("possible_phone");
    if (/(name|user_name|username)/.test(normalized))
      risks.add("possible_person_name");
    if (/(address|location|gps)/.test(normalized))
      risks.add("possible_location");
    if (/(id_card|identity|passport|ssn)/.test(normalized))
      risks.add("possible_government_id");
  }
  return [...risks].sort();
};

const sanitizeCatalog = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  source: "theta-model-catalog",
  supportedModelIds: stringArray(value.supportedModelIds),
});

const sanitizeRecommendation = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  schemaVersion: stringValue(value.schemaVersion) ?? "1.0.0",
  deterministic: value.deterministic === true,
  recommendationVersion: stringValue(value.recommendationVersion) ?? "1.0.0",
  catalogSource: stringValue(value.catalogSource) ?? "unknown",
  dataProfileSummary: (isRecord(value.dataProfileSummary)
    ? value.dataProfileSummary
    : {}) as Record<string, RuntimeJsonValue>,
  recommendations: arrayValue(value.recommendations) as RuntimeJsonValue[],
  skipped: arrayValue(value.skipped) as RuntimeJsonValue[],
  warnings: stringArray(value.warnings),
  constraintsApplied: (isRecord(value.constraintsApplied)
    ? value.constraintsApplied
    : {}) as Record<string, RuntimeJsonValue>,
  noEvidence: value.noEvidence === true,
});

const candidatePlan = (
  input: Record<string, unknown>,
  datasetProfile: Record<string, unknown>,
  recommendation: Record<string, unknown>,
  columnConfirmation: Record<string, unknown>,
): ThetaTrainingPlan => {
  if (isRecord(input.plan)) return input.plan as ThetaTrainingPlan;
  const top = isRecord(arrayValue(recommendation.recommendations)[0])
    ? (arrayValue(recommendation.recommendations)[0] as Record<string, unknown>)
    : {};
  const patch = isRecord(top.recommendedPlanPatch)
    ? top.recommendedPlanPatch
    : {};
  const constraints = isRecord(input.constraints) ? input.constraints : {};
  const fileName = stringValue(datasetProfile.fileName) ?? "dataset";
  return {
    ...patch,
    datasetId: stringValue(input.datasetId) ?? path.parse(fileName).name,
    modelId: requiredString(
      top.modelId ?? patch.modelId,
      "recommendation.modelId",
    ),
    mode: normalizedMode(patch.mode),
    numTopics:
      numberValue(patch.numTopics) ?? numberValue(constraints.maxTopics) ?? 10,
    ...(stringArray(columnConfirmation.textColumns)[0]
      ? { textColumn: stringArray(columnConfirmation.textColumns)[0] }
      : {}),
  };
};

const normalizedMode = (value: unknown): ThetaTrainingPlan["mode"] => {
  const mode = stringValue(value);
  return mode &&
    ["zero_shot", "finetune", "supervised", "unsupervised"].includes(mode)
    ? (mode as ThetaTrainingPlan["mode"])
    : "unsupervised";
};

const sanitizeArtifact = (value: unknown): Record<string, RuntimeJsonValue> => {
  const artifact = isRecord(value) ? value : {};
  return {
    kind: stringValue(artifact.kind) ?? "artifact",
    path: stringValue(artifact.path) ?? "",
    description: stringValue(artifact.description) ?? "",
  };
};

const sanitizeTrainingStatus = (
  status: Record<string, unknown>,
): Record<string, RuntimeJsonValue> => ({
  trainingRunId: requiredString(status.trainingRunId, "trainingRunId"),
  status: stringValue(status.status) ?? "unknown",
  progress: numberValue(status.progress) ?? 0,
  currentStep: stringValue(status.currentStep) ?? "unknown",
  artifacts: arrayValue(status.artifacts).map(sanitizeArtifact),
});

const approvalActor = (
  variables: Record<string, unknown>,
  key: string,
): string => {
  const actors = requireRecord(variables.approvalActors, "approval actors");
  return requiredString(actors[key], `approval actor for ${key}`);
};

const completedOutput = (
  toolId: string,
  result: ToolCallResult,
): Record<string, unknown> => {
  if (result.status !== "completed" || !isRecord(result.output)) {
    const detail =
      typeof result.error === "string"
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
  ...(result.projection.pendingWait?.reason
    ? { pendingReason: result.projection.pendingWait.reason }
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
    .find((event) => event.type === "run.completed");
  return recordProperty(terminal?.payload, "output") as
    | RuntimeJsonValue
    | undefined;
};

const invocationKey = (request: ThetaWorkflowToolRequest): string =>
  createHash("sha256")
    .update(
      `${request.runId}:${request.stateId}:${request.stateAttempt}:${request.toolId}`,
    )
    .digest("hex");

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
  if (!input || typeof input !== "object")
    throw new Error("Workflow input must be an object.");
  required(input.filePath, "input.filePath");
  if (
    input.sampleSize !== undefined &&
    (!Number.isInteger(input.sampleSize) ||
      input.sampleSize < 1 ||
      input.sampleSize > 1000)
  ) {
    throw new Error("input.sampleSize must be an integer from 1 to 1000.");
  }
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const runtimeRecord = (
  value: Record<string, unknown>,
): Record<string, RuntimeJsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, RuntimeJsonValue>;

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const stringArray = (value: unknown): string[] =>
  arrayValue(value).filter((item): item is string => typeof item === "string");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
const nullableStringProperty = (
  value: unknown,
  property: string,
): string | null =>
  isRecord(value) ? (stringValue(value[property]) ?? null) : null;
