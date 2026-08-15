import { randomUUID } from 'node:crypto';
import type {
  ContextEnvelope,
  ContextItem,
  ManagedMemoryRecord,
  ManagedMemoryType,
  MemoryApplicationService,
  MemorySource,
  WorkingMemoryStore,
} from '@hypha/memory';
import type { ThetaIntelligentPhase } from '../agent-runtime/contracts.js';
import type { ThetaConversationMessage } from '../messages/contracts.js';
import type { DatasetWorkspace, ResearchWorkspace, ThetaWorkspace } from '../workspaces/contracts.js';
import type { PlanWorkspace } from '../workspaces/contracts.js';
import type { CandidatePlan, PlanApprovalReceipt, PlanValidationReceipt } from '../planner-v3/contracts.js';
import {
  THETA_CONTEXT_PROFILE_ID,
  THETA_CONTEXT_PROFILE_REVISION,
  THETA_MEMORY_PROFILE_ID,
  THETA_MEMORY_PROFILE_REVISION,
  thetaRealityContextProfile,
} from './theta-memory-profile.js';
import {
  thetaMemoryPrincipal,
  thetaMemoryScope,
  type ThetaMemoryIdentity,
} from './theta-memory-scope.js';

export interface ThetaMemoryWriteRequest {
  identity: ThetaMemoryIdentity;
  phase: ThetaIntelligentPhase;
  memoryType: ManagedMemoryType;
  subtype: string;
  input: unknown;
  canonicalText: string;
  source: MemorySource;
  tags?: string[];
  sourceRefs?: string[];
  workspaceHash?: string;
  humanVerified?: boolean;
  idempotencyKey: string;
}

export interface ThetaContextRequest {
  identity: ThetaMemoryIdentity;
  phase: ThetaIntelligentPhase;
  stateId: string;
  systemInstructions: string;
  currentWorkspace: ThetaWorkspace;
  relatedWorkspaces?: ThetaWorkspace[];
  messages: ThetaConversationMessage[];
  query: string;
  pendingAction?: { ref: string; reason?: string };
}

export class ThetaGovernedMemoryService {
  constructor(
    private readonly memory: MemoryApplicationService,
    private readonly working: WorkingMemoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async remember(request: ThetaMemoryWriteRequest): Promise<ManagedMemoryRecord[]> {
    const result = await this.memory.add({
      operationId: `theta-memory-add:${request.identity.runId}:${randomUUID()}`,
      principal: thetaMemoryPrincipal(request.identity),
      scope: thetaMemoryScope(request.identity),
      input: request.input,
      inputType: 'structured',
      memoryType: request.memoryType,
      source: request.source,
      extractionMode: 'none',
      writeMode: 'async',
      idempotencyKey: request.idempotencyKey,
      profileRef: memoryProfileRef,
      tags: unique(['theta', `phase:${request.phase}`, `subtype:${request.subtype}`, ...(request.tags ?? [])]),
      metadata: {
        phase: request.phase,
        subtype: request.subtype,
        canonicalText: request.canonicalText,
        sourceRefs: request.sourceRefs ?? [],
        workspaceHash: request.workspaceHash,
        humanVerified: request.humanVerified ?? false,
        canonicalKey: request.workspaceHash === undefined
          ? `${request.subtype}:${request.idempotencyKey}`
          : `${request.subtype}:${request.identity.runId}`,
      },
    });
    if (result.status === 'rejected' || result.status === 'failed') {
      throw new Error(`Hypha Memory rejected ${request.subtype}: ${JSON.stringify(result.rejectedItems ?? [])}`);
    }
    return result.records;
  }

  async rememberDatasetWorkspace(
    identity: ThetaMemoryIdentity,
    workspace: DatasetWorkspace,
    options: { phase?: ThetaIntelligentPhase; checkpointStatus?: string; humanVerified?: boolean } = {},
  ): Promise<ManagedMemoryRecord[]> {
    const phase = options.phase ?? 'DatasetDiscovery';
    return this.remember({
      identity,
      phase,
      memoryType: options.humanVerified ? 'semantic' : 'episodic',
      subtype: 'dataset-understanding',
      input: {
        workspaceType: workspace.workspaceType,
        revision: workspace.revision,
        workspaceHash: workspace.workspaceHash,
        datasetHash: workspace.datasetHash,
        narrative: workspace.narrative,
        statements: workspace.statements,
        columnRoles: workspace.columnRoles,
        risks: workspace.risks,
        checkpointStatus: options.checkpointStatus,
      },
      canonicalText: datasetWorkspaceText(workspace),
      source: { type: options.humanVerified ? 'human_review' : 'workflow_state', sourceRunId: identity.runId },
      sourceRefs: workspace.sourceRefs.map((source) => source.id),
      workspaceHash: workspace.workspaceHash,
      humanVerified: options.humanVerified,
      idempotencyKey: `dataset-workspace:${workspace.workspaceHash}:${options.checkpointStatus ?? 'agent'}`,
    });
  }

  async rememberResearchWorkspace(
    identity: ThetaMemoryIdentity,
    workspace: ResearchWorkspace,
    options: { checkpointStatus?: string; humanVerified?: boolean } = {},
  ): Promise<ManagedMemoryRecord[]> {
    return this.remember({
      identity,
      phase: 'ResearchDialogue',
      memoryType: options.humanVerified ? 'semantic' : 'episodic',
      subtype: 'research-understanding',
      input: {
        workspaceType: workspace.workspaceType,
        revision: workspace.revision,
        workspaceHash: workspace.workspaceHash,
        datasetHash: workspace.datasetHash,
        narrative: workspace.narrative,
        statements: workspace.statements,
        questions: workspace.questions,
        assumptions: workspace.assumptions,
        contradictions: workspace.contradictions,
        decisions: workspace.decisions,
        preferences: workspace.preferences,
        boundaries: workspace.boundaries,
        checkpointStatus: options.checkpointStatus,
      },
      canonicalText: researchWorkspaceText(workspace),
      source: { type: options.humanVerified ? 'human_review' : 'workflow_state', sourceRunId: identity.runId },
      sourceRefs: workspace.sourceRefs.map((source) => source.id),
      workspaceHash: workspace.workspaceHash,
      humanVerified: options.humanVerified,
      idempotencyKey: `research-workspace:${workspace.workspaceHash}:${options.checkpointStatus ?? 'agent'}`,
    });
  }

  async rememberPlanWorkspace(
    identity: ThetaMemoryIdentity,
    workspace: PlanWorkspace,
  ): Promise<ManagedMemoryRecord[]> {
    return this.remember({
      identity,
      phase: 'PlanDesign',
      memoryType: 'episodic',
      subtype: 'plan-workspace',
      input: workspace,
      canonicalText: [
        `计划工作区 revision=${workspace.revision}`,
        `当前候选：${workspace.activeCandidateRef ?? '尚无'}`,
        `候选数量：${workspace.candidateRefs.length}`,
        `证据收据：${workspace.evidenceRefs.join('；') || '尚无'}`,
        `验证收据：${workspace.validationReceiptRefs.join('；') || '尚无'}`,
      ].join('\n'),
      source: { type: 'workflow_state', sourceRunId: identity.runId },
      sourceRefs: workspace.sourceRefs.map((source) => source.id),
      workspaceHash: workspace.workspaceHash,
      idempotencyKey: `plan-workspace:${workspace.workspaceHash}`,
    });
  }

  async rememberPlanCandidate(
    identity: ThetaMemoryIdentity,
    candidate: CandidatePlan,
    options: { rejected?: boolean } = {},
  ): Promise<ManagedMemoryRecord[]> {
    return this.remember({
      identity,
      phase: 'PlanDesign',
      memoryType: 'episodic',
      subtype: options.rejected ? 'rejected-plan-alternative' : 'plan-candidate',
      input: {
        candidateRef: candidate.candidateRef,
        candidatePlanHash: candidate.candidatePlanHash,
        modelId: candidate.model.modelId,
        parameters: candidate.model.parameters,
        seed: candidate.experimentProtocol.seeds[0],
        rationale: candidate.rationale,
        warnings: candidate.warnings,
        evidenceRefs: candidate.evidenceRefs,
        researchWorkspaceHash: candidate.researchWorkspaceHash,
      },
      canonicalText: [
        `${options.rejected ? '已放弃方案' : '候选方案'}：${candidate.candidateRef}`,
        `模型：${candidate.model.modelId} (${candidate.model.mode})`,
        `参数：${JSON.stringify(candidate.model.parameters)}`,
        `随机种子：${candidate.experimentProtocol.seeds[0]}`,
        '执行：单模型、单种子、单次训练',
        `理由：${candidate.rationale}`,
        `警告：${candidate.warnings.join('；') || '暂无'}`,
      ].join('\n'),
      source: { type: 'derived', sourceRunId: identity.runId },
      sourceRefs: candidate.evidenceRefs,
      idempotencyKey: `plan-candidate:${candidate.candidatePlanHash}:${options.rejected ? 'rejected' : 'active'}`,
    });
  }

  async rememberPlanValidation(
    identity: ThetaMemoryIdentity,
    receipt: PlanValidationReceipt,
  ): Promise<ManagedMemoryRecord[]> {
    return this.remember({
      identity,
      phase: 'PlanDesign',
      memoryType: 'episodic',
      subtype: 'plan-validation',
      input: receipt,
      canonicalText: [
        `候选 ${receipt.candidateRef} 验证结果：${receipt.valid ? '有效' : '需要修订'}`,
        ...receipt.issues.map((issue) => `${issue.code}/${issue.repairability}：${issue.message}`),
      ].join('\n'),
      source: { type: 'tool_result', sourceRunId: identity.runId },
      sourceRefs: receipt.issues.flatMap((issue) => issue.evidenceRefs),
      idempotencyKey: `plan-validation:${receipt.validationReceiptHash}`,
    });
  }

  async rememberPlanApproval(
    identity: ThetaMemoryIdentity,
    receipt: PlanApprovalReceipt,
  ): Promise<ManagedMemoryRecord[]> {
    return this.remember({
      identity,
      phase: 'PlanConfirmation',
      memoryType: 'episodic',
      subtype: 'plan-approval',
      input: receipt,
      canonicalText: [
        `用户已确认候选：${receipt.candidateRef}`,
        `候选哈希：${receipt.candidatePlanHash}`,
        `确认消息：${receipt.messageId}`,
        `审批收据：${receipt.planApprovalHash}`,
      ].join('\n'),
      source: { type: 'human_review', sourceRunId: identity.runId },
      sourceRefs: [receipt.messageId, receipt.checkpointId],
      workspaceHash: receipt.planWorkspaceHash,
      humanVerified: true,
      idempotencyKey: `plan-approval:${receipt.planApprovalHash}`,
    });
  }

  async rememberMessage(
    identity: ThetaMemoryIdentity,
    phase: ThetaIntelligentPhase,
    message: ThetaConversationMessage,
  ): Promise<void> {
    const timestamp = this.now();
    await this.working.set({
      id: `message:${message.messageId}`,
      scope: thetaMemoryScope(identity),
      value: {
        role: message.role,
        content: message.content,
        contentHash: message.contentHash,
        createdAt: message.createdAt,
        phase,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { phase, messageId: message.messageId },
    }, 86_400);
  }

  async buildContext(request: ThetaContextRequest): Promise<ContextEnvelope> {
    const scope = thetaMemoryScope(request.identity);
    const principal = thetaMemoryPrincipal(request.identity);
    const [working, durable] = await Promise.all([
      this.working.list(scope),
      this.memory.search({
        operationId: `theta-memory-search:${request.identity.runId}:${randomUUID()}`,
        principal,
        scope,
        profileRef: memoryProfileRef,
        query: request.query,
        memoryTypes: ['episodic', 'semantic', 'preference'],
        mode: 'hybrid',
        topK: 12,
        includeContent: true,
        includeProvenance: true,
        includeRelations: true,
        updateAccessStats: true,
      }),
    ]);
    const sourceItems = contextItems(request, working, durable);
    return this.memory.buildContext({
      operationId: `theta-context-build:${request.identity.runId}:${randomUUID()}`,
      principal,
      scope,
      runId: request.identity.runId,
      stepId: `context:${request.phase}:${request.currentWorkspace.workspaceHash.slice(7, 23)}`,
      stateId: request.stateId,
      profileRef: contextProfileRef,
      modelContextWindowTokens: 40_000,
      reservedSystemTokens: 2_000,
      reservedInstructionTokens: 2_000,
      reservedOutputTokens: 4_000,
      query: request.query,
      profile: thetaRealityContextProfile,
      sourceItems,
      metadata: { phase: request.phase, workspaceHash: request.currentWorkspace.workspaceHash },
    });
  }
}

const memoryProfileRef = {
  id: THETA_MEMORY_PROFILE_ID,
  version: '1.0.0',
  revision: THETA_MEMORY_PROFILE_REVISION,
};

const contextProfileRef = {
  id: THETA_CONTEXT_PROFILE_ID,
  version: '1.0.0',
  revision: THETA_CONTEXT_PROFILE_REVISION,
};

const contextItems = (
  request: ThetaContextRequest,
  working: Awaited<ReturnType<WorkingMemoryStore['list']>>,
  durable: Awaited<ReturnType<MemoryApplicationService['search']>>,
): ContextItem[] => {
  const now = new Date().toISOString();
  const system = item('system:theta', 'system', 'theta.system', request.systemInstructions, 100, true, false, { authority: 'authoritative' });
  const workflow = item(
    `workflow:${request.stateId}`,
    'workflow_state',
    'theta.workflow',
    JSON.stringify({ phase: request.phase, stateId: request.stateId, pendingAction: request.pendingAction ?? null }),
    98,
    true,
    false,
    { authority: 'authoritative', observedAt: now },
  );
  const workspaces = [request.currentWorkspace, ...(request.relatedWorkspaces ?? [])].map((workspace) =>
    item(
      `workspace:${workspace.workspaceType}:${workspace.workspaceHash}`,
      'custom',
      'theta.workspace',
      JSON.stringify(workspace),
      workspace.workspaceType === request.currentWorkspace.workspaceType ? 96 : 94,
      true,
      false,
      { authority: 'authoritative', workspaceHash: workspace.workspaceHash },
    ));
  const messages = request.messages.slice(-20).map((message, index) =>
    item(
      `message:${message.messageId}`,
      'messages',
      'theta.messages',
      JSON.stringify({ role: message.role, content: message.content, createdAt: message.createdAt }),
      90 + index / 100,
      index >= Math.max(0, request.messages.length - 8),
      true,
      { authority: message.role === 'user' ? 'user_asserted' : 'unverified', messageId: message.messageId },
    ));
  const workingItems = working.slice(-12).map((entry) =>
    item(`working:${entry.id}`, 'working_memory', 'theta.working', JSON.stringify(entry.value), 82, false, true, {
      authority: 'unverified', scopeHash: entry.scopeHash,
    }));
  const durableItems = durable.map(({ record, score }) =>
    item(
      `memory:${record.id}:${record.versionId}`,
      'long_term_memory',
      'theta.durable',
      durableCanonicalText(record),
      isHumanVerified(record) ? 90 : 84,
      false,
      false,
      {
        authority: isHumanVerified(record) ? 'verified' : record.source.type === 'workflow_state' ? 'system_observed' : 'unverified',
        memoryId: record.id,
        memoryVersionId: record.versionId,
        scopeHash: record.scopeHash,
        score,
      },
      score,
    ));
  return [system, workflow, ...workspaces, ...messages, ...workingItems, ...durableItems];
};

const item = (
  id: string,
  sourceType: ContextItem['sourceType'],
  sourceId: string,
  text: string,
  priority: number,
  required: boolean,
  untrusted: boolean,
  metadata: Record<string, unknown>,
  score?: number,
): ContextItem => ({
  id,
  sourceType,
  sourceId,
  content: text,
  text,
  tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
  priority,
  required,
  untrusted,
  provenance: { ...metadata, createdAt: new Date().toISOString(), createdBy: 'theta-agent', providerId: 'memory.provider.theta-native' },
  metadata,
  ...(score === undefined ? {} : { score }),
});

const datasetWorkspaceText = (workspace: DatasetWorkspace): string => [
  `数据理解：${workspace.narrative}`,
  `列角色：${workspace.columnRoles.map((role) => `${role.column}=${role.proposedRole}`).join('；') || '尚未确定'}`,
  `关键事实：${workspace.statements.map((statement) => statement.statement).join('；') || '暂无'}`,
  `风险：${workspace.risks.join('；') || '暂无'}`,
].join('\n');

const researchWorkspaceText = (workspace: ResearchWorkspace): string => [
  `研究意图：${workspace.narrative}`,
  `已知陈述：${workspace.statements.map((statement) => statement.statement).join('；') || '暂无'}`,
  `待解决问题：${workspace.questions.filter((question) => question.status === 'open').map((question) => question.question).join('；') || '暂无'}`,
  `约束：${workspace.boundaries.map((boundary) => boundary.boundary).join('；') || '暂无'}`,
].join('\n');

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const isHumanVerified = (record: ManagedMemoryRecord): boolean =>
  record.humanVerified === true || record.metadata?.humanVerified === true;

const durableCanonicalText = (record: ManagedMemoryRecord): string => {
  const metadataText = record.metadata?.canonicalText;
  return typeof metadataText === 'string' && metadataText.trim()
    ? metadataText
    : record.canonicalText ?? record.summary ?? JSON.stringify(record.content);
};
