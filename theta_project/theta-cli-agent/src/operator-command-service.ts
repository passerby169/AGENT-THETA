import { createHash } from 'node:crypto';
import type { ToolCallResult } from '@hypha/tools';
import type { AgentInvocation } from './conversation/contracts.js';
import { THETA_APPROVAL_KEYS } from './theta-domain.js';
import { ThetaWorkflowService } from './theta-workflow-service.js';
import {
  requestThetaTrainingCancel,
  runApprovedThetaTrainingCancel,
  runThetaRagBuild,
  runThetaRagStatus,
  runThetaTrainingStatus,
} from './tools/hypha-runner.js';

export type OperatorInvocation = Exclude<
  AgentInvocation,
  | { kind: 'doctor' }
  | { kind: 'workflow' }
  | { kind: 'status' }
  | { kind: 'audit' }
  | { kind: 'repl' }
>;

export interface OperatorCommandExecutor {
  execute(invocation: OperatorInvocation): Promise<unknown>;
}

export interface OperatorCommandDependencies {
  workflow?: Pick<
    ThetaWorkflowService,
    'plan' | 'status' | 'resume' | 'evidence'
  >;
  trainingStatus?: typeof runThetaTrainingStatus;
  requestTrainingCancel?: typeof requestThetaTrainingCancel;
  approveTrainingCancel?: typeof runApprovedThetaTrainingCancel;
  ragBuild?: typeof runThetaRagBuild;
  ragStatus?: typeof runThetaRagStatus;
}

export class ThetaOperatorCommandService implements OperatorCommandExecutor {
  private readonly workflow: Pick<
    ThetaWorkflowService,
    'plan' | 'status' | 'resume' | 'evidence'
  >;

  constructor(private readonly dependencies: OperatorCommandDependencies = {}) {
    this.workflow = dependencies.workflow ?? new ThetaWorkflowService();
  }

  async execute(invocation: OperatorInvocation): Promise<unknown> {
    if (invocation.kind === 'planShow') {
      return this.workflow.plan(invocation.runId, invocation.runtimeDb);
    }
    if (invocation.kind === 'planApprove') {
      const status = await this.workflow.status(
        invocation.runId,
        invocation.runtimeDb,
      );
      if (status.pendingActionRef !== THETA_APPROVAL_KEYS.planReview) {
        throw new Error(
          `Run ${invocation.runId} is not waiting at ${THETA_APPROVAL_KEYS.planReview}.`,
        );
      }
      return this.workflow.resume({
        runId: invocation.runId,
        ...(invocation.runtimeDb
          ? { runtimeDb: invocation.runtimeDb }
          : {}),
        approve: true,
        approvedBy: invocation.approvedBy ?? 'local_user',
      });
    }
    if (invocation.kind === 'evidenceShow') {
      return this.workflow.evidence(invocation.runId, invocation.runtimeDb);
    }
    if (invocation.kind === 'trainingStatus') {
      return requireCompleted(
        await (this.dependencies.trainingStatus ?? runThetaTrainingStatus)({
          trainingRunId: invocation.trainingRunId,
          ...(invocation.logLimit === undefined
            ? {}
            : { logLimit: invocation.logLimit }),
        }),
        'Training status',
      );
    }
    if (invocation.kind === 'trainingCancel') {
      const input = {
        trainingRunId: invocation.trainingRunId,
        reason: invocation.reason,
      };
      const key = `theta-agent-training-cancel-${createHash('sha256')
        .update(JSON.stringify(input))
        .digest('hex')
        .slice(0, 20)}`;
      const options = {
        invocationId: key,
        idempotencyKey: key,
      };
      if (!invocation.approve) {
        const result = await (
          this.dependencies.requestTrainingCancel ??
          requestThetaTrainingCancel
        )(input, options);
        return {
          status: result.status,
          toolId: result.toolId,
          approvalRequired: result.status === 'human_review_required',
          cancellationRecorded: false,
          message:
            'Review the cancellation reason, then repeat with --approve.',
        };
      }
      return requireCompleted(
        await (
          this.dependencies.approveTrainingCancel ??
          runApprovedThetaTrainingCancel
        )(input, options),
        'Approved training cancellation',
      );
    }
    if (invocation.kind === 'ragBuild') {
      return requireCompleted(
        await (this.dependencies.ragBuild ?? runThetaRagBuild)(),
        'RAG index build',
      );
    }
    return requireCompleted(
      await (this.dependencies.ragStatus ?? runThetaRagStatus)(),
      'RAG index status',
    );
  }
}

const requireCompleted = <T>(
  result: ToolCallResult<T>,
  operation: string,
): T => {
  if (result.status !== 'completed' || result.output === undefined) {
    throw new Error(
      `${operation} failed: ${JSON.stringify(result.error ?? result.status)}`,
    );
  }
  return result.output;
};
