import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FrameworkEvent } from '@hypha/core';
import { THETA_APPROVAL_KEYS, THETA_WORKFLOW_STATES } from './theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowToolPort,
  type ThetaWorkflowToolRequest,
} from './theta-workflow-service.js';
import { THETA_TOOL_IDS } from './tools/tool-ids.js';

const RAW_SAMPLE_SENTINEL = 'RAW_SAMPLE_MUST_NOT_ENTER_CANONICAL_EVENTS';

class FakeThetaTools implements ThetaWorkflowToolPort {
  private readonly events: FrameworkEvent[] = [];
  private readonly statusCalls = new Map<string, number>();
  private sequence = 0;

  async invoke(
    request: ThetaWorkflowToolRequest,
  ): Promise<Record<string, unknown>> {
    this.record(request, 'tool.policy.checked', {
      toolId: request.toolId,
      ruleId: 'fake-governed-tool-allow',
    });
    this.record(request, 'tool.call.completed', { toolId: request.toolId });
    switch (request.toolId) {
      case THETA_TOOL_IDS.datasetInspect:
        return {
          filePath: request.input.filePath,
          fileName: 'research.csv',
          suffix: '.csv',
          supported: true,
          encoding: 'utf8',
          delimiter: ',',
          rowCount: 120,
          sampleRowCount: 1,
          columns: ['text', 'created_at'],
          columnProfiles: [
            {
              name: 'text',
              nonEmptySampleCount: 1,
              missingSampleCount: 0,
              missingSampleRatio: 0,
              uniqueSampleCount: 1,
              avgLength: 42,
              maxLength: 42,
              inferredType: 'text',
              sampleValues: [RAW_SAMPLE_SENTINEL],
              estimatedTotalRows: 120,
            },
          ],
          sampleRows: [{ text: RAW_SAMPLE_SENTINEL }],
          textColumnCandidates: [
            { name: 'text', score: 1, reason: 'Long-form text column.' },
          ],
        };
      case THETA_TOOL_IDS.datasetDetectColumns:
        return {
          filePath: request.input.filePath,
          rowCount: 120,
          columns: ['text', 'created_at'],
          textColumns: [{ name: 'text', score: 1, reason: 'Text column.' }],
          timeColumns: [
            { name: 'created_at', score: 1, reason: 'Timestamp column.' },
          ],
          metadataColumns: [],
          recommendedTextColumn: 'text',
          warnings: [],
        };
      case THETA_TOOL_IDS.modelCatalog:
        return {
          source: 'fake-model-catalog',
          runnableSource: 'fake',
          models: [],
          supportedModelIds: ['bertopic'],
        };
      case THETA_TOOL_IDS.modelRecommend:
        return {
          deterministic: true,
          catalogSource: 'fake-model-catalog',
          dataProfileSummary: {},
          recommendations: [
            {
              rank: 1,
              modelId: 'bertopic',
              modelName: 'BERTopic',
              score: 100,
              reasons: ['Text profile matches topic modelling.'],
              warnings: [],
              requirements: ['text'],
              recommendedPlanPatch: { mode: 'unsupervised', numTopics: 8 },
            },
          ],
          skipped: [],
          warnings: [],
          constraintsApplied: {},
        };
      case THETA_TOOL_IDS.planValidate:
        return {
          valid: true,
          errors: [],
          warnings: [],
          normalizedPlan: request.input.plan,
          catalogSource: 'fake-model-catalog',
        };
      case THETA_TOOL_IDS.planCreate:
        return {
          planId: 'plan-smoke-001',
          planHash: 'plan-hash-smoke-001',
          valid: true,
          approvalRequired: true,
          createdAt: '2026-07-28T00:00:00.000Z',
          normalizedPlan: request.input.plan,
          validation: { valid: true },
          stateDb: 'not-persisted-in-runtime-events',
        };
      case THETA_TOOL_IDS.planApprove:
        return {
          approvalId: 'approval-smoke-001',
          planId: request.input.planId,
          planHash: request.input.planHash,
          approvedBy: request.input.approvedBy,
          approvedAt: '2026-07-28T00:00:01.000Z',
          stateDb: 'not-persisted-in-runtime-events',
        };
      case THETA_TOOL_IDS.trainingDryRun:
        return {
          planId: request.input.planId,
          planHash: request.input.planHash,
          valid: true,
          approved: true,
          approvals: [
            {
              approvalId: 'approval-smoke-001',
              approvedBy: 'owner.smoke',
              approvedAt: '2026-07-28T00:00:01.000Z',
            },
          ],
          validation: { valid: true },
          commands: [
            {
              step: 'train',
              cwd: '/redacted',
              argv: ['python', 'train.py'],
              sideEffect: 'external_effect',
            },
          ],
          expectedArtifacts: [
            {
              kind: 'model',
              path: '/results/model',
              description: 'Trained model.',
            },
          ],
          notes: [],
        };
      case THETA_TOOL_IDS.trainingStart:
        return {
          trainingRunId: 'training-smoke-001',
          planId: request.input.planId,
          planHash: request.input.planHash,
          approvalId: request.input.approvalId,
          status: 'running',
          progress: 0,
          processStarted: true,
          currentStep: 'prepare',
          commands: [],
          expectedArtifacts: [],
        };
      case THETA_TOOL_IDS.trainingStatus: {
        const statusCalls = (this.statusCalls.get(request.runId) ?? 0) + 1;
        this.statusCalls.set(request.runId, statusCalls);
        if (request.runId === 'theta-workflow-timer' && statusCalls === 1) {
          return {
            trainingRunId: request.input.trainingRunId,
            found: true,
            status: 'running',
            logs: ['training in progress'],
            artifacts: [],
            progress: 50,
            currentStep: 'train',
          };
        }
        return {
          trainingRunId: request.input.trainingRunId,
          found: true,
          status: 'completed',
          logs: ['training complete'],
          artifacts: [
            {
              kind: 'model',
              path: '/results/model',
              description: 'Trained model.',
            },
          ],
          progress: 100,
          currentStep: 'completed',
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
    type: FrameworkEvent['type'],
    payload: Record<string, unknown>,
  ): void {
    this.sequence += 1;
    this.events.push({
      id: `fake-tool-event-${this.sequence}`,
      type,
      version: '1.0.0',
      userId: 'local_user',
      workspaceId: 'local_workspace',
      sessionId: request.sessionId,
      runId: request.runId,
      stepId: request.stateId,
      agentId: 'agent.theta.cli',
      fsmState: request.stateId,
      correlationId: request.runId,
      timestamp: new Date(
        Date.UTC(2026, 6, 28, 0, 0, this.sequence),
      ).toISOString(),
      payload,
    });
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-workflow-smoke-'));
const runtimeDb = path.join(root, 'workflow.sqlite');
const tools = new FakeThetaTools();
const service = new ThetaWorkflowService({ toolPort: tools });
const input = {
  filePath: path.join(root, 'research.csv'),
  datasetId: 'research-smoke',
  researchGoal: 'Discover stable research topics.',
  constraints: { maxTopics: 8 },
};

try {
  const completed = await service.run({
    input,
    runId: 'theta-workflow-completed',
    runtimeDb,
    approvalKeys: Object.values(THETA_APPROVAL_KEYS),
    approvedBy: 'owner.smoke',
  });
  if (
    completed.disposition !== 'completed' ||
    completed.status !== 'completed'
  ) {
    throw new Error(
      `Expected completed workflow, received ${completed.disposition}.`,
    );
  }
  const expectedPath = [
    THETA_WORKFLOW_STATES.intake,
    THETA_WORKFLOW_STATES.inspectDataset,
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
    THETA_WORKFLOW_STATES.startTraining,
    THETA_WORKFLOW_STATES.monitorTraining,
    THETA_WORKFLOW_STATES.completed,
  ];
  if (JSON.stringify(completed.statePath) !== JSON.stringify(expectedPath)) {
    throw new Error(
      `Unexpected completed state path: ${completed.statePath.join(' -> ')}`,
    );
  }

  const evidence = await service.evidence(completed.runId, runtimeDb);
  if (
    JSON.stringify(evidence.orchestrationEvents).includes(RAW_SAMPLE_SENTINEL)
  ) {
    throw new Error('Raw dataset sample leaked into canonical runtime events.');
  }
  const replay = await service.replay(completed.runId, runtimeDb);
  const replayAgain = await service.replay(completed.runId, runtimeDb);
  if (replay.digest !== replayAgain.digest) {
    throw new Error('Replay fixture digest is not deterministic.');
  }

  const recoveryRunId = 'theta-workflow-recovery';
  const first = await service.run({ input, runId: recoveryRunId, runtimeDb });
  if (first.pendingActionRef !== THETA_APPROVAL_KEYS.planCreate) {
    throw new Error(
      'Workflow did not stop at the plan creation approval gate.',
    );
  }
  const second = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: 'owner.smoke',
  });
  if (second.pendingActionRef !== THETA_APPROVAL_KEYS.planApprove) {
    throw new Error(
      'Recovered workflow did not stop at the plan approval gate.',
    );
  }
  const third = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: 'owner.smoke',
  });
  if (third.pendingActionRef !== THETA_APPROVAL_KEYS.trainingStart) {
    throw new Error(
      'Recovered workflow did not stop at the training approval gate.',
    );
  }
  const fourth = await service.resume({
    runId: recoveryRunId,
    runtimeDb,
    approve: true,
    approvedBy: 'owner.smoke',
  });
  if (fourth.disposition !== 'completed') {
    throw new Error('Recovered workflow did not complete after all approvals.');
  }

  const rejectedRunId = 'theta-workflow-rejected';
  const rejectedWait = await service.run({
    input,
    runId: rejectedRunId,
    runtimeDb,
  });
  if (rejectedWait.pendingActionRef !== THETA_APPROVAL_KEYS.planCreate) {
    throw new Error('Rejected workflow did not reach the expected approval gate.');
  }
  const rejected = await service.resume({
    runId: rejectedRunId,
    runtimeDb,
    reject: true,
    approvedBy: 'owner.smoke',
  });
  if (rejected.disposition !== 'failed' || rejected.status !== 'failed') {
    throw new Error('Rejected human wait did not fail the Run.');
  }

  const timerRunId = 'theta-workflow-timer';
  const timerWait = await service.run({
    input,
    runId: timerRunId,
    runtimeDb,
    approvalKeys: Object.values(THETA_APPROVAL_KEYS),
    approvedBy: 'owner.smoke',
  });
  if (
    timerWait.disposition !== 'waiting' ||
    timerWait.status !== 'waiting_timer'
  ) {
    throw new Error('Running training did not create a durable timer wait.');
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const timerCompleted = await service.resume({ runId: timerRunId, runtimeDb });
  if (timerCompleted.disposition !== 'completed') {
    throw new Error('Durable timer did not resume training monitoring.');
  }

  console.log(
    JSON.stringify({
      status: 'ok',
      completedRun: completed.runId,
      statePath: completed.statePath,
      canonicalEventCount: evidence.orchestrationEvents.length,
      toolEventCount: evidence.toolEvents.length,
      replayDigest: replay.digest,
      recoveryRun: recoveryRunId,
      recoveryDisposition: fourth.disposition,
      rejectionDisposition: rejected.disposition,
      timerDisposition: timerCompleted.disposition,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
