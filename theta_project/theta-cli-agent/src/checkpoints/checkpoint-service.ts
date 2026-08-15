import { randomUUID } from 'node:crypto';
import { createFrameworkEvent, hashCanonicalJson, type EventStore, type FrameworkEvent } from '@hypha/core';
import type { DatasetWorkspace, PlanWorkspace, ResearchWorkspace } from '../workspaces/contracts.js';
import type { CandidatePlan, EvidenceSelectionReceipt, PlanValidationReceipt } from '../planner-v3/contracts.js';
import type { CandidatePlanPresentation } from '../planner-v3/candidate-presenter.js';
import type { CanonicalPlanRecord, DryRunReceipt } from '../execution/index.js';
import type { ConversationalCheckpoint, ConversationalCheckpointKind, ThetaCheckpointStatus } from './contracts.js';
import { THETA_CHECKPOINT_EVENT_TYPE } from './event-schemas.js';

export interface ProposeDatasetCheckpointRequest {
  runId: string;
  sessionId: string;
  userId: string;
  workspace: DatasetWorkspace;
  requestedBy: 'minimax' | 'fsm';
  rationale: string;
}

export interface ProposeResearchCheckpointRequest {
  runId: string;
  sessionId: string;
  userId: string;
  workspace: ResearchWorkspace;
  requestedBy: 'minimax' | 'fsm';
  rationale: string;
  status?: 'proposed' | 'skipped';
}

export interface ProposePlanCheckpointRequest {
  runId: string;
  sessionId: string;
  userId: string;
  workspace: PlanWorkspace;
  candidate: CandidatePlan;
  evidenceReceipt: EvidenceSelectionReceipt;
  validationReceipt: PlanValidationReceipt;
  presentation: CandidatePlanPresentation;
  rationale: string;
}

export interface ProposeTrainingCheckpointRequest {
  runId: string;
  sessionId: string;
  userId: string;
  planRecord: CanonicalPlanRecord;
  dryRun: DryRunReceipt;
  rationale: string;
}

export class ThetaCheckpointEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async current(runId: string, kind?: ConversationalCheckpointKind): Promise<ConversationalCheckpoint | null> {
    return projectCheckpoint(await this.events.list({ runId }), kind);
  }

  async proposeDataset(request: ProposeDatasetCheckpointRequest): Promise<ConversationalCheckpoint> {
    const current = await this.current(request.runId, 'dataset');
    const revision = (current?.revision ?? 0) + 1;
    const timestamp = this.now();
    const content = {
      targetWorkspaceRef: `workspace:dataset:${request.workspace.revision}`,
      targetHash: request.workspace.workspaceHash,
      content: {
        narrative: request.workspace.narrative,
        statements: request.workspace.statements.map(({ semanticLabel, statement, confidence }) => ({ semanticLabel, statement, confidence })),
        columnRoles: request.workspace.columnRoles.map(({ column, proposedRole, confidence }) => ({ column, proposedRole, confidence })),
        risks: request.workspace.risks,
      },
      summaryForUser: request.workspace.narrative,
      assumptions: request.workspace.statements.filter((item) => item.epistemicStatus === 'inferred' || item.epistemicStatus === 'proposed').map((item) => item.statement),
      warnings: request.workspace.risks,
      sourceRefs: request.workspace.sourceRefs.map((source) => source.id),
    };
    const checkpoint: ConversationalCheckpoint = {
      checkpointId: `checkpoint:dataset:${request.runId}:${revision}`,
      kind: 'dataset',
      runId: request.runId,
      revision,
      ...content,
      contentHash: hashCanonicalJson(content),
      status: 'proposed',
      requestedBy: request.requestedBy,
      mandatory: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolutionReason: request.rationale,
    };
    await this.append(request.runId, request.sessionId, request.userId, 'theta.checkpoint.proposed', checkpoint);
    return checkpoint;
  }

  async proposeResearch(request: ProposeResearchCheckpointRequest): Promise<ConversationalCheckpoint> {
    const current = await this.current(request.runId, 'research');
    const revision = (current?.revision ?? 0) + 1;
    const timestamp = this.now();
    const content = {
      targetWorkspaceRef: `workspace:research:${request.workspace.revision}`,
      targetHash: request.workspace.workspaceHash,
      content: {
        narrative: request.workspace.narrative,
        statements: request.workspace.statements,
        openQuestions: request.workspace.questions.filter((question) => question.status === 'open'),
        assumptions: request.workspace.assumptions,
        decisions: request.workspace.decisions,
        preferences: request.workspace.preferences,
        boundaries: request.workspace.boundaries,
      },
      summaryForUser: researchSynthesis(request.workspace),
      assumptions: request.workspace.assumptions
        .filter((assumption) => assumption.status === 'proposed')
        .map((assumption) => assumption.statement),
      warnings: [
        ...request.workspace.contradictions.filter((contradiction) => contradiction.status === 'open').map((contradiction) => contradiction.description),
        ...request.workspace.questions.filter((question) => question.status === 'open' && question.blocking).map((question) => question.question),
      ],
      sourceRefs: request.workspace.sourceRefs.map((source) => source.id),
    };
    const checkpoint: ConversationalCheckpoint = {
      checkpointId: `checkpoint:research:${request.runId}:${revision}`,
      kind: 'research',
      runId: request.runId,
      revision,
      ...content,
      contentHash: hashCanonicalJson(content),
      status: request.status ?? 'proposed',
      requestedBy: request.requestedBy,
      mandatory: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolutionReason: request.rationale,
    };
    await this.append(request.runId, request.sessionId, request.userId, 'theta.checkpoint.proposed', checkpoint);
    return checkpoint;
  }

  async proposePlan(request: ProposePlanCheckpointRequest): Promise<ConversationalCheckpoint> {
    if (!request.validationReceipt.valid) throw new Error('PlanCheckpoint requires a valid ValidationReceipt.');
    if (
      request.workspace.activeCandidateRef !== request.candidate.candidateRef ||
      request.evidenceReceipt.candidatePlanHash !== request.candidate.candidatePlanHash ||
      request.validationReceipt.candidatePlanHash !== request.candidate.candidatePlanHash ||
      request.validationReceipt.evidenceBundleHash !== request.evidenceReceipt.evidenceBundleHash
    ) throw new Error('PlanCheckpoint inputs are not bound to one current candidate hash chain.');
    const current = await this.current(request.runId, 'plan');
    const revision = (current?.revision ?? 0) + 1;
    const timestamp = this.now();
    const content = {
      targetWorkspaceRef: request.candidate.candidateRef,
      targetHash: request.candidate.candidatePlanHash,
      content: {
        planWorkspaceHash: request.workspace.workspaceHash,
        candidate: request.candidate,
        evidenceSelectionReceipt: request.evidenceReceipt,
        validationReceipt: request.validationReceipt,
        presentation: request.presentation,
      },
      summaryForUser: [request.presentation.title, request.presentation.summary, ...request.presentation.sections.map((section) => `${section.title}：${section.content}`)].join('\n'),
      assumptions: request.candidate.assumptions,
      warnings: request.presentation.warnings,
      sourceRefs: [
        request.candidate.candidateRef,
        ...request.evidenceReceipt.selectedEvidenceIds,
        request.validationReceipt.receiptId,
      ],
    };
    const checkpoint: ConversationalCheckpoint = {
      checkpointId: `checkpoint:plan:${request.runId}:${revision}`,
      kind: 'plan',
      runId: request.runId,
      revision,
      ...content,
      contentHash: hashCanonicalJson(content),
      status: 'proposed',
      requestedBy: 'fsm',
      mandatory: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolutionReason: request.rationale,
    };
    await this.append(request.runId, request.sessionId, request.userId, 'theta.checkpoint.proposed', checkpoint);
    return checkpoint;
  }

  async proposeTraining(request: ProposeTrainingCheckpointRequest): Promise<ConversationalCheckpoint> {
    if (!request.dryRun.passed) throw new Error('TrainingCheckpoint requires a passed DryRunReceipt.');
    if (request.dryRun.planId !== request.planRecord.planId || request.dryRun.planHash !== request.planRecord.planHash) {
      throw new Error('TrainingCheckpoint DryRun does not bind the current Canonical Plan.');
    }
    const current = await this.current(request.runId, 'training');
    const revision = (current?.revision ?? 0) + 1;
    const timestamp = this.now();
    const plan = request.planRecord.canonicalPlan;
    const warnings = request.dryRun.checks.filter((check) => check.status === 'warn').map((check) => check.detail);
    const content = {
      targetWorkspaceRef: request.planRecord.planId,
      targetHash: request.dryRun.dryRunHash,
      content: {
        planId: request.planRecord.planId,
        planHash: request.planRecord.planHash,
        dryRunHash: request.dryRun.dryRunHash,
        datasetHash: request.dryRun.datasetHash,
        model: plan.model,
        seed: plan.experimentProtocol.primarySeeds[0],
        estimatedTrainingRuns: 1,
        commands: request.dryRun.commands.map((command) => ({ step: command.step, sideEffect: command.sideEffect })),
        expectedArtifacts: request.dryRun.expectedArtifacts,
      },
      summaryForUser: [
        `训练方案：${plan.model.modelId}，随机种子 ${plan.experimentProtocol.primarySeeds[0]}，执行 1 次训练。`,
        `模型超参数：${Object.entries(plan.model.parameters).map(([key, value]) => `${key}=${String(value)}`).join('，') || '使用模型默认值'}。`,
        `正文列：${plan.columns.textColumns.join('、')}。`,
        '评估指标、质量检查和可视化由 Python 训练管线自动生成。',
        `训练前检查已通过，共 ${request.dryRun.checks.length} 项检查，预计生成 ${request.dryRun.expectedArtifacts.length} 类产物。`,
        warnings.length > 0 ? `需要注意：${warnings.join('；')}` : '训练前检查没有警告。',
        '当前尚未启动训练。只有你明确、无条件确认后，系统才会重新核验数据并启动。',
      ].join('\n'),
      assumptions: plan.assumptions,
      warnings: [...plan.warnings, ...warnings],
      sourceRefs: [request.planRecord.planHash, request.dryRun.dryRunHash],
    };
    const checkpoint: ConversationalCheckpoint = {
      checkpointId: `checkpoint:training:${request.runId}:${revision}`,
      kind: 'training',
      runId: request.runId,
      revision,
      ...content,
      contentHash: hashCanonicalJson(content),
      status: 'proposed',
      requestedBy: 'fsm',
      mandatory: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolutionReason: request.rationale,
    };
    await this.append(request.runId, request.sessionId, request.userId, 'theta.checkpoint.proposed', checkpoint);
    return checkpoint;
  }

  async changeStatus(request: {
    runId: string;
    sessionId: string;
    userId: string;
    checkpointId: string;
    expectedContentHash: string;
    status: Exclude<ThetaCheckpointStatus, 'proposed'>;
    messageId: string;
    reason: string;
  }): Promise<ConversationalCheckpoint> {
    const current = await this.current(request.runId);
    if (!current || current.checkpointId !== request.checkpointId) {
      throw new Error(`Current checkpoint does not match: ${request.checkpointId}.`);
    }
    if (current.contentHash !== request.expectedContentHash) {
      throw new Error('Checkpoint feedback targets a stale content hash.');
    }
    if (!['proposed', 'revising'].includes(current.status)) {
      throw new Error(`Checkpoint is already resolved: ${current.status}.`);
    }
    const checkpoint: ConversationalCheckpoint = {
      ...current,
      status: request.status,
      updatedAt: this.now(),
      resolvedByMessageId: request.messageId,
      resolutionReason: request.reason,
    };
    await this.append(request.runId, request.sessionId, request.userId, 'theta.checkpoint.status_changed', checkpoint);
    return checkpoint;
  }

  private async append(
    runId: string,
    sessionId: string,
    userId: string,
    kind: 'theta.checkpoint.proposed' | 'theta.checkpoint.status_changed',
    checkpoint: ConversationalCheckpoint,
  ): Promise<void> {
    await this.events.append(createFrameworkEvent({
      id: `theta-checkpoint:${runId}:${randomUUID()}`,
      type: THETA_CHECKPOINT_EVENT_TYPE,
      version: '1.0.0',
      runId,
      sessionId,
      userId,
      timestamp: checkpoint.updatedAt,
      payload: { kind, checkpoint },
      metadata: { checkpointId: checkpoint.checkpointId, status: checkpoint.status },
    }));
  }
}

export const projectCheckpoint = (
  events: readonly FrameworkEvent[],
  kind?: ConversationalCheckpointKind,
): ConversationalCheckpoint | null => {
  let current: ConversationalCheckpoint | null = null;
  for (const event of events) {
    if (event.type !== THETA_CHECKPOINT_EVENT_TYPE) continue;
    const candidate = record(event.payload).checkpoint;
    if (!isCheckpoint(candidate) || (kind !== undefined && candidate.kind !== kind)) continue;
    if (kind !== undefined && current && candidate.revision < current.revision) continue;
    current = structuredClone(candidate);
  }
  return current;
};

const isCheckpoint = (value: unknown): value is ConversationalCheckpoint => {
  const candidate = record(value);
  return typeof candidate.checkpointId === 'string' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.revision === 'number' &&
    typeof candidate.targetHash === 'string' &&
    Boolean(candidate.content) && typeof candidate.content === 'object' &&
    typeof candidate.contentHash === 'string' &&
    typeof candidate.summaryForUser === 'string' &&
    typeof candidate.status === 'string';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const researchSynthesis = (workspace: ResearchWorkspace): string => {
  const sections = [
    workspace.narrative.trim(),
    workspace.statements.length > 0
      ? `研究重点：${workspace.statements.map((item) => item.statement).join('；')}`
      : '',
    workspace.decisions.length > 0
      ? `已作决定：${workspace.decisions.map((item) => item.decision).join('；')}`
      : '',
    workspace.preferences.length > 0
      ? `偏好：${workspace.preferences.map((item) => item.preference).join('；')}`
      : '',
    workspace.boundaries.length > 0
      ? `范围与约束：${workspace.boundaries.map((item) => item.boundary).join('；')}`
      : '',
  ].filter(Boolean);
  return sections.join('\n');
};
