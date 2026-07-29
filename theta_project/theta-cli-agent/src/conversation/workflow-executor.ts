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
      const status = await this.workflow.status(runId, context.runtimeDb);
      return {
        value: {
          kind: 'plan.review',
          runId,
          currentState: status.currentState ?? null,
          pendingActionRef: status.pendingActionRef ?? null,
          pendingReason: status.pendingReason ?? null,
          statePath: status.statePath,
          approvalReady:
            status.pendingActionRef === THETA_APPROVAL_KEYS.planReview,
        },
        activeRunId: runId,
      };
    }
    if (command.kind === 'approve') {
      const runId = resolveRunId(command.runId, context.activeRunId);
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
  const reasonCode =
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
      status.pendingReason ??
      stringField(failed?.payload, 'message') ??
      stringField(failed?.payload, 'reason') ??
      'Derived from canonical Runtime events.',
    pendingActionRef: status.pendingActionRef ?? null,
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
