import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FrameworkEvent } from "@hypha/core";
import { THETA_APPROVAL_KEYS, THETA_WORKFLOW_STATES } from "./theta-domain.js";
import {
  ThetaWorkflowService,
  type ThetaWorkflowToolPort,
  type ThetaWorkflowToolRequest,
} from "./theta-workflow-service.js";
import { THETA_TOOL_IDS } from "./tools/tool-ids.js";

const RAW_SAMPLE_SENTINEL = "RAW_SAMPLE_MUST_NOT_ENTER_CANONICAL_EVENTS";
const DATASET_SHA_A = "a".repeat(64);
const DATASET_SHA_B = "b".repeat(64);

class FakeThetaTools implements ThetaWorkflowToolPort {
  private readonly events: FrameworkEvent[] = [];
  private readonly statusCalls = new Map<string, number>();
  private readonly inspectCalls = new Map<string, number>();
  private sequence = 0;

  async invoke(
    request: ThetaWorkflowToolRequest,
  ): Promise<Record<string, unknown>> {
    this.record(request, "tool.policy.checked", {
      toolId: request.toolId,
      ruleId: "fake-governed-tool-allow",
    });
    this.record(request, "tool.call.completed", { toolId: request.toolId });
    switch (request.toolId) {
      case THETA_TOOL_IDS.datasetInspect: {
        const inspectCalls = (this.inspectCalls.get(request.runId) ?? 0) + 1;
        this.inspectCalls.set(request.runId, inspectCalls);
        const datasetSha256 =
          (request.runId === "theta-workflow-column-hash-change" &&
            inspectCalls > 1) ||
          (request.runId === "theta-workflow-training-hash-change" &&
            inspectCalls > 2)
            ? DATASET_SHA_B
            : DATASET_SHA_A;
        return {
          filePath: request.input.filePath,
          fileName: "research.csv",
          datasetSha256,
          fileSizeBytes: 4096,
          suffix: ".csv",
          supported: true,
          encoding: "utf8",
          delimiter: ",",
          rowCount: 120,
          sampleRowCount: 1,
          sampleDuplicateRatio: 0,
          languageDistribution: [{ language: "latin", ratio: 1 }],
          timeCoverage: {
            start: "2026-07-01T00:00:00.000Z",
            end: "2026-07-01T00:00:00.000Z",
          },
          columns: ["text", "created_at"],
          columnProfiles: [
            {
              name: "text",
              nonEmptySampleCount: 1,
              missingSampleCount: 0,
              missingSampleRatio: 0,
              uniqueSampleCount: 1,
              avgLength: 42,
              maxLength: 42,
              inferredType: "text",
              sampleValues: [RAW_SAMPLE_SENTINEL],
              estimatedTotalRows: 120,
            },
          ],
          sampleRows: [{ text: RAW_SAMPLE_SENTINEL }],
          textColumnCandidates: [
            { name: "text", score: 1, reason: "Long-form text column." },
          ],
        };
      }
      case THETA_TOOL_IDS.datasetDetectColumns:
        return {
          filePath: request.input.filePath,
          rowCount: 120,
          columns: ["text", "created_at"],
          textColumns: [{ name: "text", score: 1, reason: "Text column." }],
          timeColumns: [
            { name: "created_at", score: 1, reason: "Timestamp column." },
          ],
          metadataColumns: [],
          recommendedTextColumn: "text",
          warnings: [],
        };
      case THETA_TOOL_IDS.modelCatalog:
        return {
          source: "fake-model-catalog",
          runnableSource: "fake",
          models: [],
          supportedModelIds: ["bertopic"],
        };
      case THETA_TOOL_IDS.ragSearch:
        return {
          schemaVersion: "1.0.0",
          query: request.input.query,
          evidence: [],
          noEvidence: true,
        };
      case THETA_TOOL_IDS.modelRecommend:
        if (request.runId === "theta-workflow-no-compatible-model") {
          return {
            schemaVersion: "1.0.0",
            deterministic: true,
            recommendationVersion: "1.0.0",
            catalogSource: "fake-model-catalog",
            dataProfileSummary: {},
            recommendations: [],
            skipped: [
              {
                modelId: "bertopic",
                reasonCodes: ["DATASET_BELOW_ABSOLUTE_MINIMUM"],
              },
            ],
            warnings: ["NO_COMPATIBLE_MODEL"],
            constraintsApplied: {
              preferredModelIds: [],
              forbiddenModelIds: [],
              unavailableRequirements: [],
              mode: null,
              maxTopics: null,
            },
            noEvidence: true,
          };
        }
        return {
          schemaVersion: "1.0.0",
          deterministic: true,
          recommendationVersion: "1.0.0",
          catalogSource: "fake-model-catalog",
          dataProfileSummary: {},
          recommendations: [
            {
              rank: 1,
              modelId: "bertopic",
              modelName: "BERTopic",
              score: 100,
              confidence: "medium",
              reasonCodes: ["TEXT_PROFILE_MATCH"],
              warnings: [],
              requirements: ["text"],
              topicRecommendation: {
                range: [5, 10],
                firstRun: 8,
                alternatives: [5, 10],
              },
              parameters: [],
              resourceEstimate: {
                cpu: "high",
                gpu: "optional",
                memory: "high",
                disk: "high",
                relativeRuntime: "long",
                network: "optional",
              },
              evidenceRefs: [],
              recommendedPlanPatch: {
                modelId: "bertopic",
                mode: "unsupervised",
                numTopics: 8,
                batchSize: 32,
                epochs: 30,
              },
            },
          ],
          skipped: [],
          warnings: ["NO_EVIDENCE_AVAILABLE"],
          constraintsApplied: {
            preferredModelIds: [],
            forbiddenModelIds: [],
            unavailableRequirements: [],
            mode: null,
            maxTopics: null,
          },
          noEvidence: true,
        };
      case THETA_TOOL_IDS.planValidate:
        return {
          valid: true,
          errors: [],
          warnings: [],
          normalizedPlan: request.input.plan,
          catalogSource: "fake-model-catalog",
        };
      case THETA_TOOL_IDS.planCreate:
        return {
          planId: "plan-smoke-001",
          planHash: "plan-hash-smoke-001",
          valid: true,
          approvalRequired: true,
          createdAt: "2026-07-28T00:00:00.000Z",
          normalizedPlan: request.input.plan,
          validation: { valid: true },
          stateDb: "not-persisted-in-runtime-events",
        };
      case THETA_TOOL_IDS.planApprove:
        return {
          approvalId: "approval-smoke-001",
          planId: request.input.planId,
          planHash: request.input.planHash,
          approvedBy: request.input.approvedBy,
          approvedAt: "2026-07-28T00:00:01.000Z",
          stateDb: "not-persisted-in-runtime-events",
        };
      case THETA_TOOL_IDS.trainingDryRun:
        return {
          planId: request.input.planId,
          planHash: request.input.planHash,
          valid: true,
          approved: true,
          approvals: [
            {
              approvalId: "approval-smoke-001",
              approvedBy: "owner.smoke",
              approvedAt: "2026-07-28T00:00:01.000Z",
            },
          ],
          validation: { valid: true },
          commands: [
            {
              step: "train",
              cwd: "/redacted",
              argv: ["python", "train.py"],
              sideEffect: "external_effect",
            },
          ],
          expectedArtifacts: [
            {
              kind: "model",
              path: "/results/model",
              description: "Trained model.",
            },
          ],
          notes: [],
        };
      case THETA_TOOL_IDS.trainingStart:
        return {
          trainingRunId: "training-smoke-001",
          planId: request.input.planId,
          planHash: request.input.planHash,
          approvalId: request.input.approvalId,
          status: "running",
          progress: 0,
          processStarted: true,
          currentStep: "prepare",
          commands: [],
          expectedArtifacts: [],
        };
      case THETA_TOOL_IDS.trainingStatus: {
        const statusCalls = (this.statusCalls.get(request.runId) ?? 0) + 1;
        this.statusCalls.set(request.runId, statusCalls);
        if (request.runId === "theta-workflow-timer" && statusCalls === 1) {
          return {
            trainingRunId: request.input.trainingRunId,
            found: true,
            status: "running",
            logs: ["training in progress"],
            artifacts: [],
            progress: 50,
            currentStep: "train",
          };
        }
        return {
          trainingRunId: request.input.trainingRunId,
          found: true,
          status: "completed",
          logs: ["training complete"],
          artifacts: [
            {
              kind: "model",
              path: "/results/model",
              description: "Trained model.",
            },
          ],
          progress: 100,
          currentStep: "completed",
        };
      }
      default:
        throw new Error(`Unexpected fake THETA tool: ${request.toolId}`);
    }
  }

  async listTrace(runId: string): Promise<FrameworkEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  private record(
    request: ThetaWorkflowToolRequest,
    type: FrameworkEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    this.sequence += 1;
    this.events.push({
      id: `fake-tool-event-${this.sequence}`,
      type,
      version: "1.0.0",
      userId: "local_user",
      workspaceId: "local_workspace",
      sessionId: request.sessionId,
      runId: request.runId,
      stepId: request.stateId,
      agentId: "agent.theta.cli",
      fsmState: request.stateId,
      correlationId: request.runId,
      timestamp: new Date(
        Date.UTC(2026, 6, 28, 0, 0, this.sequence),
      ).toISOString(),
      payload,
    });
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "theta-workflow-smoke-"));
const runtimeDb = path.join(root, "workflow.sqlite");
const tools = new FakeThetaTools();
const service = new ThetaWorkflowService({ toolPort: tools });
const input = {
  filePath: path.join(root, "research.csv"),
  datasetId: "research-smoke",
  researchGoal: "Discover stable research topics.",
  research: {
    analysisUnit: "one research document",
    textFieldIntent: "analyze the primary document body",
    sensitiveData: { status: "no" as const, categories: [] },
    successCriteria: ["Produce stable, interpretable topics."],
    hardwareLimit: { device: "cpu" as const, memoryGb: 16 },
  },
  constraints: { maxTopics: 8 },
};
const columnConfirmation = {
  textColumns: ["text"],
  timeColumn: "created_at",
  idColumn: null,
  metadataColumns: [],
};

try {
  const completedWait = await service.run({
    input,
    runId: "theta-workflow-completed",
    runtimeDb,
  });
  if (
    completedWait.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation
  ) {
    throw new Error("Completed workflow did not require column confirmation.");
  }
  const completed = await service.resume({
    runId: completedWait.runId,
    runtimeDb,
    columnConfirmation,
    approvalKeys: [
      THETA_APPROVAL_KEYS.planCreate,
      THETA_APPROVAL_KEYS.planApprove,
      THETA_APPROVAL_KEYS.trainingStart,
    ],
    approvedBy: "owner.smoke",
  });
  if (
    completed.disposition !== "completed" ||
    completed.status !== "completed"
  ) {
    throw new Error(
      `Expected completed workflow, received ${completed.disposition}.`,
    );
  }
  const expectedPath = [
    THETA_WORKFLOW_STATES.intake,
    THETA_WORKFLOW_STATES.inspectDataset,
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
    THETA_WORKFLOW_STATES.awaitColumnConfirmation,
    THETA_WORKFLOW_STATES.recommendModel,
    THETA_WORKFLOW_STATES.validatePlan,
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    THETA_WORKFLOW_STATES.awaitPlanCreationApproval,
    THETA_WORKFLOW_STATES.createPlan,
    THETA_WORKFLOW_STATES.awaitPlanApproval,
    THETA_WORKFLOW_STATES.awaitPlanApproval,
    THETA_WORKFLOW_STATES.approvePlan,
    THETA_WORKFLOW_STATES.dryRun,
    THETA_WORKFLOW_STATES.awaitTrainingStartApproval,
    THETA_WORKFLOW_STATES.awaitTrainingStartApproval,
    THETA_WORKFLOW_STATES.verifyDatasetBeforeTraining,
    THETA_WORKFLOW_STATES.startTraining,
    THETA_WORKFLOW_STATES.monitorTraining,
    THETA_WORKFLOW_STATES.completed,
  ];
  if (JSON.stringify(completed.statePath) !== JSON.stringify(expectedPath)) {
    throw new Error(
      `Unexpected completed state path: ${completed.statePath.join(" -> ")}`,
    );
  }

  const evidence = await service.evidence(completed.runId, runtimeDb);
  if (
    JSON.stringify(evidence.orchestrationEvents).includes(RAW_SAMPLE_SENTINEL)
  ) {
    throw new Error("Raw dataset sample leaked into canonical runtime events.");
  }
  const replay = await service.replay(completed.runId, runtimeDb);
  const replayAgain = await service.replay(completed.runId, runtimeDb);
  if (replay.digest !== replayAgain.digest) {
    throw new Error("Replay fixture digest is not deterministic.");
  }

  const recoveryRunId = "theta-workflow-recovery";
  const first = await service.run({ input, runId: recoveryRunId, runtimeDb });
  if (first.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation) {
    throw new Error("Workflow did not stop at the column confirmation gate.");
  }
  const second = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    columnConfirmation,
    approvedBy: "owner.smoke",
  });
  if (second.pendingActionRef !== THETA_APPROVAL_KEYS.planCreate) {
    throw new Error(
      "Recovered workflow did not stop at the plan creation approval gate.",
    );
  }
  const third = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: "owner.smoke",
  });
  if (third.pendingActionRef !== THETA_APPROVAL_KEYS.planApprove) {
    throw new Error(
      "Recovered workflow did not stop at the plan approval gate.",
    );
  }
  const fourth = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: "owner.smoke",
  });
  if (fourth.pendingActionRef !== THETA_APPROVAL_KEYS.trainingStart) {
    throw new Error(
      "Recovered workflow did not stop at the training approval gate.",
    );
  }
  const fifth = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: "owner.smoke",
  });
  if (fifth.disposition !== "completed") {
    throw new Error("Recovered workflow did not complete after all approvals.");
  }

  const clarificationRunId = "theta-workflow-clarification";
  const clarificationWait = await service.run({
    input: {
      filePath: input.filePath,
      researchGoal: input.researchGoal,
    },
    runId: clarificationRunId,
    runtimeDb,
  });
  if (
    clarificationWait.pendingActionRef !==
    THETA_APPROVAL_KEYS.researchClarification
  ) {
    throw new Error(
      "Incomplete research intake did not request clarification.",
    );
  }
  const clarified = await service.resume({
    runId: clarificationRunId,
    runtimeDb,
    researchAnswers: input.research,
    approvedBy: "owner.smoke",
  });
  if (clarified.pendingActionRef !== THETA_APPROVAL_KEYS.columnConfirmation) {
    throw new Error(
      "Structured research answers did not advance to column confirmation.",
    );
  }

  const noCompatibleRunId = "theta-workflow-no-compatible-model";
  await service.run({ input, runId: noCompatibleRunId, runtimeDb });
  const noCompatible = await service.resume({
    runId: noCompatibleRunId,
    runtimeDb,
    columnConfirmation,
    approvedBy: "owner.smoke",
  });
  if (
    noCompatible.disposition !== "failed" ||
    noCompatible.currentState !== THETA_WORKFLOW_STATES.failed
  ) {
    throw new Error(
      "No-compatible-model result improperly advanced to plan validation.",
    );
  }

  const columnHashRunId = "theta-workflow-column-hash-change";
  const columnHashWait = await service.run({
    input,
    runId: columnHashRunId,
    runtimeDb,
  });
  const columnHashChanged = await service.resume({
    runId: columnHashRunId,
    runtimeDb,
    columnConfirmation,
    approvedBy: "owner.smoke",
  });
  if (
    columnHashChanged.pendingActionRef !==
      THETA_APPROVAL_KEYS.columnConfirmation ||
    columnHashChanged.currentState !==
      THETA_WORKFLOW_STATES.awaitColumnConfirmation
  ) {
    const columnHashEvidence = await service.evidence(
      columnHashRunId,
      runtimeDb,
    );
    throw new Error(
      `A changed dataset hash did not invalidate column confirmation: ${JSON.stringify(
        {
          columnHashChanged,
          events: columnHashEvidence.orchestrationEvents
            .slice(-8)
            .map((event) => ({ type: event.type, payload: event.payload })),
        },
      )}`,
    );
  }

  const trainingHashRunId = "theta-workflow-training-hash-change";
  await service.run({ input, runId: trainingHashRunId, runtimeDb });
  const trainingHashChanged = await service.resume({
    runId: trainingHashRunId,
    runtimeDb,
    columnConfirmation,
    approvalKeys: [
      THETA_APPROVAL_KEYS.planCreate,
      THETA_APPROVAL_KEYS.planApprove,
      THETA_APPROVAL_KEYS.trainingStart,
    ],
    approvedBy: "owner.smoke",
  });
  if (
    trainingHashChanged.pendingActionRef !==
      THETA_APPROVAL_KEYS.columnConfirmation ||
    trainingHashChanged.currentState !==
      THETA_WORKFLOW_STATES.awaitColumnConfirmation
  ) {
    throw new Error(
      `A changed preflight dataset hash did not invalidate approvals and return to confirmation: ${JSON.stringify(
        trainingHashChanged,
      )}`,
    );
  }

  const rejectedRunId = "theta-workflow-rejected";
  const rejectedWait = await service.run({
    input: {
      filePath: input.filePath,
      researchGoal: input.researchGoal,
    },
    runId: rejectedRunId,
    runtimeDb,
  });
  if (
    rejectedWait.pendingActionRef !== THETA_APPROVAL_KEYS.researchClarification
  ) {
    throw new Error(
      "Rejected workflow did not reach the research clarification gate.",
    );
  }
  const rejected = await service.resume({
    runId: rejectedRunId,
    runtimeDb,
    reject: true,
    approvedBy: "owner.smoke",
  });
  if (rejected.disposition !== "failed" || rejected.status !== "failed") {
    throw new Error("Rejected human wait did not fail the Run.");
  }

  const timerRunId = "theta-workflow-timer";
  const timerWait = await service.run({
    input,
    runId: timerRunId,
    runtimeDb,
  });
  const timerStarted = await service.resume({
    runId: timerRunId,
    runtimeDb,
    columnConfirmation,
    approvalKeys: [
      THETA_APPROVAL_KEYS.planCreate,
      THETA_APPROVAL_KEYS.planApprove,
      THETA_APPROVAL_KEYS.trainingStart,
    ],
    approvedBy: "owner.smoke",
  });
  if (
    timerStarted.disposition !== "waiting" ||
    timerStarted.status !== "waiting_timer"
  ) {
    throw new Error("Running training did not create a durable timer wait.");
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const timerCompleted = await service.resume({ runId: timerRunId, runtimeDb });
  if (timerCompleted.disposition !== "completed") {
    throw new Error("Durable timer did not resume training monitoring.");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      completedRun: completed.runId,
      statePath: completed.statePath,
      canonicalEventCount: evidence.orchestrationEvents.length,
      toolEventCount: evidence.toolEvents.length,
      replayDigest: replay.digest,
      recoveryRun: recoveryRunId,
      recoveryDisposition: fifth.disposition,
      clarificationDisposition: clarified.disposition,
      columnHashDisposition: columnHashChanged.disposition,
      trainingHashDisposition: trainingHashChanged.disposition,
      rejectionDisposition: rejected.disposition,
      timerDisposition: timerCompleted.disposition,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
