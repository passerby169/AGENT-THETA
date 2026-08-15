import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { ThetaPlannerEventRepository } from '../planner-v3/event-store.js';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import {
  canonicalPlanRecord,
  compileCanonicalPlan,
  dryRunReceiptHash,
  dryRunReceiptSchema,
  humanPlanReviewSchema,
  ThetaExecutionEventRepository,
  type DryRunCheck,
  type DryRunReceipt,
  type HumanPlanReview,
} from '../execution/index.js';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const planCreateInputSchema: JsonSchema = {
  type: 'object',
  required: ['candidateRef', 'expectedPlanApprovalHash'],
  properties: {
    candidateRef: { type: 'string', minLength: 1 },
    expectedPlanApprovalHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  },
  additionalProperties: false,
};

const dryRunInputSchema: JsonSchema = {
  type: 'object',
  required: ['planId', 'expectedPlanHash'],
  properties: {
    planId: { type: 'string', minLength: 1 },
    expectedPlanHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const thetaPlanCreateToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.planCreate,
  version: '1.0.0',
  displayName: 'Create approved canonical plan',
  description: 'Compile the exact approved CandidatePlan into the single executable CanonicalPlan V3. Inputs are references only; arbitrary plan JSON is rejected.',
  tags: ['theta', 'execution', 'canonical-plan'],
  inputSchema: planCreateInputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.planWrite],
  timeoutPolicy: { timeoutMs: 60_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaTrainingDryRunToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingDryRun,
  version: '1.0.0',
  displayName: 'Verify training plan without training',
  description: 'Run plan-bound dataset, environment and command preflight checks. This Tool never starts a training process.',
  tags: ['theta', 'execution', 'dry-run'],
  inputSchema: dryRunInputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'write',
  permissionScope: [
    THETA_PERMISSION_SCOPES.datasetRead,
    THETA_PERMISSION_SCOPES.planRead,
    THETA_PERMISSION_SCOPES.planWrite,
    THETA_PERMISSION_SCOPES.runtimeRead,
  ],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaPlanCreateHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const request = record(input);
  const candidateRef = requiredText(request.candidateRef, 'candidateRef');
  const expectedApprovalHash = requiredText(request.expectedPlanApprovalHash, 'expectedPlanApprovalHash');
  return withExecutionRuntime(context, async (runtime, registry) => {
    const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
    const candidate = await planner.candidate(context.runId, candidateRef);
    if (!candidate) throw new Error(`Candidate was not found: ${candidateRef}.`);
    const evidenceReceipt = await planner.evidenceReceipt(context.runId, candidate.candidatePlanHash);
    const validationReceipt = await planner.validationReceipt(context.runId, candidate.candidatePlanHash);
    const approvalReceipt = await planner.approvalReceipt(context.runId, candidate.candidatePlanHash);
    if (!evidenceReceipt || !validationReceipt || !approvalReceipt) {
      throw new Error('The current candidate is missing its evidence, validation or human approval receipt.');
    }
    if (approvalReceipt.planApprovalHash !== expectedApprovalHash) {
      throw new Error('expectedPlanApprovalHash targets a stale or different approval receipt.');
    }
    const existing = await execution.currentCanonicalPlan(context.runId);
    if (
      existing?.canonicalPlanRecord.canonicalPlan.provenance.candidatePlanHash === candidate.candidatePlanHash &&
      existing.canonicalPlanRecord.canonicalPlan.provenance.planApprovalHash === expectedApprovalHash
    ) {
      return presentCreatedPlan(existing.canonicalPlanRecord, existing.planReview, true, existing.bridgeStateDb);
    }
    const datasetWorkspace = await workspaces.current(context.runId, 'dataset');
    const researchWorkspace = await workspaces.current(context.runId, 'research');
    if (!datasetWorkspace || datasetWorkspace.workspaceType !== 'dataset' || !researchWorkspace || researchWorkspace.workspaceType !== 'research') {
      throw new Error('Current DatasetWorkspace and ResearchWorkspace are required to create a Canonical Plan.');
    }
    const owner = ownerFrom(context);
    const datasetRecord = registry.require(candidate.datasetRef, owner);
    const canonicalPlan = compileCanonicalPlan({
      candidate,
      datasetWorkspace,
      researchWorkspace,
      datasetRecord,
      evidenceReceipt,
      validationReceipt,
      approvalReceipt,
    });
    const planRecord = canonicalPlanRecord(canonicalPlan);
    const bridge = await callThetaBridge('plan.create', {
      plan: planRecord.canonicalPlan,
      canonicalJson: planRecord.canonicalJson,
      canonicalPlanHash: planRecord.planHash,
      rationale: planRecord.canonicalPlan.rationale,
    }, { runId: context.runId, stepId: context.stepId });
    if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Bridge plan.create failed.');
    const bridgeData = record(bridge.data);
    if (bridgeData.valid !== true || bridgeData.planId !== planRecord.planId || bridgeData.planHash !== planRecord.planHash || bridgeData.canonicalJson !== planRecord.canonicalJson) {
      throw new Error('Bridge plan.create returned a record that does not match the TypeScript Canonical Plan.');
    }
    const planReview: HumanPlanReview = humanPlanReviewSchema.parse({
      approvalType: 'human_plan_review',
      approvalId: approvalReceipt.receiptId,
      runId: context.runId,
      planId: planRecord.planId,
      planHash: planRecord.planHash,
      candidatePlanHash: candidate.candidatePlanHash,
      planApprovalHash: approvalReceipt.planApprovalHash,
      principalId: approvalReceipt.principalId,
      approvedAt: approvalReceipt.approvedAt,
    });
    const recordedAt = new Date().toISOString();
    await execution.recordCanonicalPlan({
      runId: context.runId,
      sessionId: context.sessionId ?? `session:${context.runId}`,
      userId: context.userId ?? 'local_user',
      value: {
        canonicalPlanRecord: planRecord,
        planReview,
        bridgeStateDb: String(bridgeData.stateDb ?? ''),
        recordedAt,
      },
    });
    return presentCreatedPlan(planRecord, planReview, false, String(bridgeData.stateDb ?? ''));
  });
};

export const thetaTrainingDryRunHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const request = record(input);
  const planId = requiredText(request.planId, 'planId');
  const expectedPlanHash = requiredText(request.expectedPlanHash, 'expectedPlanHash');
  const force = request.force === true;
  return withExecutionRuntime(context, async (runtime, registry) => {
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const current = await execution.currentCanonicalPlan(context.runId);
    if (!current || current.canonicalPlanRecord.planId !== planId || current.canonicalPlanRecord.planHash !== expectedPlanHash) {
      throw new Error('DryRun targeted a stale or unknown Canonical Plan.');
    }
    const existing = await execution.currentDryRun(context.runId, expectedPlanHash);
    if (!force && existing?.passed) return presentDryRun(existing, true);
    const owner = ownerFrom(context);
    const dataset = registry.require(current.canonicalPlanRecord.canonicalPlan.datasetRef, owner);
    if (dataset.sha256 !== current.canonicalPlanRecord.canonicalPlan.datasetSha256) {
      throw new Error('Registered dataset hash changed after Canonical Plan creation.');
    }
    const bridge = await callThetaBridge('training.dry_run', {
      plan: current.canonicalPlanRecord,
      planReview: current.planReview,
      datasetPath: dataset.managedPath,
    }, { runId: context.runId, stepId: context.stepId });
    if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Bridge training.dry_run failed.');
    const data = record(bridge.data);
    const checks = array(data.checks).map((value) => normalizeCheck(record(value)));
    if (checks.length === 0) throw new Error('Bridge DryRun returned no checks.');
    const material = {
      runId: context.runId,
      planId,
      planHash: expectedPlanHash,
      planReviewApprovalId: current.planReview.approvalId,
      datasetHash: dataset.sha256,
      passed: data.passed === true && !checks.some((check) => check.status === 'fail'),
      checks,
      commands: array(data.commands).map(normalizeCommand),
      expectedArtifacts: array(data.expectedArtifacts).map(normalizeArtifact),
      notes: array(data.notes).map(String),
    };
    const dryRunHash = dryRunReceiptHash(material);
    const receipt = dryRunReceiptSchema.parse({
      receiptId: `dry-run:${dryRunHash.slice('sha256:'.length, 'sha256:'.length + 20)}`,
      ...material,
      checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : new Date().toISOString(),
      dryRunHash,
    });
    await execution.recordDryRun({
      runId: context.runId,
      sessionId: context.sessionId ?? `session:${context.runId}`,
      userId: context.userId ?? 'local_user',
      receipt,
    });
    return presentDryRun(receipt, false);
  });
};

const presentCreatedPlan = (
  planRecord: ReturnType<typeof canonicalPlanRecord>,
  planReview: HumanPlanReview,
  reused: boolean,
  bridgeStateDb: string,
): Record<string, unknown> => ({
  kind: 'canonical_plan_created',
  reused,
  planId: planRecord.planId,
  planHash: planRecord.planHash,
  candidatePlanHash: planReview.candidatePlanHash,
  planApprovalHash: planReview.planApprovalHash,
  datasetHash: planRecord.canonicalPlan.datasetSha256,
  bridgeStateDb,
  summary: {
    model: planRecord.canonicalPlan.model.modelId,
    topicCountMode: planRecord.canonicalPlan.model.topicCountMode,
    numTopics: planRecord.canonicalPlan.model.numTopics,
    estimatedTrainingRuns: planRecord.canonicalPlan.experimentProtocol.estimatedTrainingRuns,
    textColumns: planRecord.canonicalPlan.columns.textColumns,
  },
});

const presentDryRun = (receipt: DryRunReceipt, reused: boolean): Record<string, unknown> => {
  const failed = receipt.checks.filter((check) => check.status === 'fail');
  const warnings = receipt.checks.filter((check) => check.status === 'warn');
  return {
    kind: 'training_dry_run',
    reused,
    receipt,
    summary: {
      passed: receipt.passed,
      passedChecks: receipt.checks.filter((check) => check.status === 'pass').length,
      warnings: warnings.map((check) => ({ code: check.code, detail: check.detail })),
      failures: failed.map((check) => ({ code: check.code, detail: check.detail, recoveryTarget: check.recoveryTarget })),
      commandCount: receipt.commands.length,
      expectedArtifactCount: receipt.expectedArtifacts.length,
      nextAction: receipt.passed
        ? '请单独确认是否开始训练；当前尚未启动任何训练进程。'
        : recoveryMessage(failed),
    },
  };
};

const normalizeCheck = (value: Record<string, unknown>): DryRunCheck => {
  const code = requiredText(value.code, 'DryRun check code');
  const status = value.status === 'pass' || value.status === 'warn' || value.status === 'fail' ? value.status : 'fail';
  return {
    code,
    status,
    detail: requiredText(value.detail, `DryRun ${code} detail`),
    recoveryTarget: status === 'fail' ? recoveryTarget(code) : null,
  };
};

const recoveryTarget = (code: string): DryRunCheck['recoveryTarget'] => {
  if (/^(DATASET_|TEXT_|NONEMPTY_|BTM_|DTM_|STM_)/u.test(code)) return 'DatasetDiscovery';
  if (/^(PYTHON_|MODEL_DEPENDENCIES|COMMAND_|DISK_|GPU_|OFFLINE_)/u.test(code)) return 'HumanRecovery';
  return 'PlanDesign';
};

const recoveryMessage = (checks: DryRunCheck[]): string => {
  const targets = new Set(checks.map((check) => check.recoveryTarget));
  if (targets.has('DatasetDiscovery')) return '数据或列绑定未通过检查，需要返回数据理解阶段。';
  if (targets.has('HumanRecovery')) return '本地环境或模型资产尚未就绪，需要先修复环境。';
  return '当前计划无法安全执行，需要返回计划设计阶段调整。';
};

const normalizeCommand = (value: unknown): DryRunReceipt['commands'][number] => {
  const item = record(value);
  return {
    step: requiredText(item.step, 'command.step'),
    cwd: requiredText(item.cwd, 'command.cwd'),
    argv: array(item.argv).map(String),
    sideEffect: requiredText(item.sideEffect, 'command.sideEffect'),
  };
};

const normalizeArtifact = (value: unknown): DryRunReceipt['expectedArtifacts'][number] => {
  const item = record(value);
  return {
    kind: requiredText(item.kind, 'artifact.kind'),
    path: requiredText(item.path, 'artifact.path'),
    description: requiredText(item.description, 'artifact.description'),
  };
};

const withExecutionRuntime = async <T>(
  context: ToolCallContext,
  operation: (
    runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>,
    registry: SQLiteDatasetRegistry,
  ) => Promise<T>,
): Promise<T> => {
  const runtimeDb = typeof context.metadata?.thetaRuntimeDb === 'string'
    ? context.metadata.thetaRuntimeDb
    : defaultThetaV6RuntimeDb();
  const runtime = await createThetaRuntimeComposition(runtimeDb);
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try { return await operation(runtime, registry); }
  finally { registry.close(); await runtime.close(); }
};

const ownerFrom = (context: ToolCallContext): { userId: string; workspaceId: string } => ({
  userId: context.userId ?? 'local_user',
  workspaceId: context.workspaceId ?? 'local_workspace',
});

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
