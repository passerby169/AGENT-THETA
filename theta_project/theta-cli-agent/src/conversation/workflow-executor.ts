import path from 'node:path';
import type { FrameworkEvent } from '@hypha/core';
import { THETA_APPROVAL_KEYS } from '../theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowEvidence,
  type ThetaWorkflowRunResult,
  type ThetaWorkflowStatus,
} from '../theta-workflow-service.js';
import type { ConversationCommand } from './contracts.js';

export interface ConversationExecutionContext {
  activeRunId?: string;
  runtimeDb?: string;
}

export interface ConversationExecutionResult {
  value: unknown;
  activeRunId?: string;
}

export class ThetaConversationWorkflowExecutor {
  constructor(private readonly workflow = new ThetaWorkflowService()) {}

  async execute(
    command: ConversationCommand,
    context: ConversationExecutionContext,
  ): Promise<ConversationExecutionResult> {
    if (command.kind === 'start') {
      const result = await this.workflow.run({
        input: { filePath: path.resolve(process.cwd(), command.filePath) },
        ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
      });
      return withRun(result);
    }
    if (command.kind === 'status') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return withRun(
        await this.workflow.status(runId, context.runtimeDb),
      );
    }
    if (command.kind === 'why') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      const status = await this.workflow.status(runId, context.runtimeDb);
      const evidence = await this.workflow.evidence(runId, context.runtimeDb);
      return {
        value: explain(status, evidence),
        activeRunId: runId,
      };
    }
    if (command.kind === 'evidence') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: await this.workflow.evidence(runId, context.runtimeDb),
        activeRunId: runId,
      };
    }
    if (command.kind === 'plan') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: {
          kind: 'plan.review',
          ...(await this.workflow.plan(runId, context.runtimeDb)),
        },
        activeRunId: runId,
      };
    }
    if (
      command.kind === 'approve' ||
      command.kind === 'approvePlan' ||
      command.kind === 'startTraining'
    ) {
      const runId = resolveRunId(command.runId, context.activeRunId);
      const status = await this.workflow.status(runId, context.runtimeDb);
      if (
        command.kind === 'approvePlan' &&
        status.pendingActionRef !== THETA_APPROVAL_KEYS.planReview
      ) {
        throw new Error('当前不是训练方案审批阶段。请先使用 /status 查看当前步骤。');
      }
      if (
        command.kind === 'startTraining' &&
        status.pendingActionRef !== THETA_APPROVAL_KEYS.trainingReview
      ) {
        throw new Error('当前不是训练启动审批阶段。请先使用 /status 查看当前步骤。');
      }
      if (command.kind === 'approvePlan') {
        const plan = await this.workflow.plan(runId, context.runtimeDb);
        const recommendation = record(plan.recommendation);
        const degradation = record(recommendation.degradation);
        const priorAdjustment = record(plan.planAdjustment);
        const requiresDegradation = degradation.required === true;
        const accepted =
          command.acceptDegradation || priorAdjustment.acceptDegradation === true;
        if (requiresDegradation && !accepted) {
          const unmet = strings(degradation.unmetRequirements).join('、');
          throw new Error(
            `当前方案不能满足全部研究目标（${unmet || '能力缺口'}）。请先调整模型，或使用 /approve-plan --accept-degradation 明确接受降级。`,
          );
        }
        if (requiresDegradation && command.acceptDegradation) {
          await this.workflow.resume({
            runId,
            ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
            planAdjustment: { acceptDegradation: true },
            approvedBy: 'local_user',
          });
        }
      }
      const result = await this.workflow.resume({
        runId,
        ...(context.runtimeDb ? { runtimeDb: context.runtimeDb } : {}),
        approve: true,
        approvedBy: 'local_user',
      });
      return withRun(result);
    }
    if (command.kind === 'save') {
      const runId = resolveRunId(command.runId, context.activeRunId);
      return {
        value: {
          kind: 'replay.fixture',
          destination: 'terminal',
          replay: await this.workflow.replay(runId, context.runtimeDb),
        },
        activeRunId: runId,
      };
    }
    if (command.kind === 'next') {
      const runId = resolveRunId(undefined, context.activeRunId);
      return withRun(await this.workflow.status(runId, context.runtimeDb));
    }
    throw new Error(`Command ${command.kind} is handled by the REPL shell.`);
  }
}

const withRun = (
  result: ThetaWorkflowRunResult | ThetaWorkflowStatus,
): ConversationExecutionResult => ({
  value: result,
  activeRunId: result.runId,
});

const resolveRunId = (
  requested: string | undefined,
  active: string | undefined,
): string => {
  const runId = requested ?? active;
  if (!runId) {
    throw new Error('No active Run. Pass a runId or use /start <dataset>.');
  }
  return runId;
};

const explain = (
  status: ThetaWorkflowStatus,
  evidence: ThetaWorkflowEvidence,
): Record<string, unknown> => {
  const failed = latestEvent(evidence.orchestrationEvents, 'run.failed');
  const policy = latestEvent(evidence.toolEvents, 'tool.policy.checked');
  const receipt = record(status.trainingReceipt);
  const trainingFailure = record(receipt.failure);
  const reasonCode =
    stringField(trainingFailure, 'code') ??
    stringField(failed?.payload, 'reasonCode') ??
    stringField(failed?.payload, 'code') ??
    (status.pendingActionRef
      ? 'HUMAN_ACTION_REQUIRED'
      : status.status === 'completed'
        ? 'RUN_COMPLETED'
        : status.status === 'waiting_timer'
          ? 'TIMER_WAIT_ACTIVE'
          : status.status === 'failed'
            ? 'RUN_FAILED'
            : 'RUN_ACTIVE');
  return {
    kind: 'run.explanation',
    runId: status.runId,
    status: status.status,
    currentState: status.currentState ?? null,
    reasonCode,
    reason:
      stringField(trainingFailure, 'summary') ??
      status.pendingReason ??
      stringField(failed?.payload, 'message') ??
      stringField(failed?.payload, 'reason') ??
      'Derived from canonical Runtime events.',
    pendingActionRef: status.pendingActionRef ?? null,
    stage:
      stringField(trainingFailure, 'stage') ??
      stringField(receipt, 'currentStep') ??
      null,
    technicalDetail:
      stringField(trainingFailure, 'technicalDetail') ?? null,
    suggestedCommands: strings(trainingFailure.suggestedCommands),
    partialArtifactsAvailable:
      trainingFailure.partialArtifactsAvailable === true,
    logPath: stringField(receipt, 'logPath') ?? null,
    guard: policy?.payload ?? null,
    evidenceRefs: [
      ...evidence.orchestrationEvents.slice(-3).map((event) => event.id),
      ...evidence.toolEvents.slice(-3).map((event) => event.id),
    ],
  };
};

const latestEvent = (
  events: readonly FrameworkEvent[],
  type: string,
): FrameworkEvent | undefined =>
  [...events].reverse().find((event) => event.type === type);

const stringField = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
