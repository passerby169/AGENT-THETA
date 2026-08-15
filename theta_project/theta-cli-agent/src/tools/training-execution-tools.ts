import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolExecutionEnvelope, ToolHandler, ToolSpec } from '@hypha/tools';
import {
  artifactManifestHash,
  datasetVerificationReceiptHash,
  datasetVerificationReceiptSchema,
  ThetaExecutionEventRepository,
  trainingCancellationReceiptHash,
  trainingCancellationReceiptSchema,
  trainingProgressSnapshotSchema,
  trainingRunReceiptSchema,
  verifiedArtifactManifestSchema,
  type DatasetVerificationReceipt,
  type TrainingFailureDescriptor,
  type TrainingProgressSnapshot,
  type TrainingRunReceipt,
} from '../execution/index.js';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { SQLiteDatasetRegistry } from '../storage/dataset-registry.js';
import { callThetaBridge } from './bridge.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } as const;
const strict = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

export const thetaDatasetVerifyForTrainingToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetVerifyForTraining,
  version: '1.0.0',
  displayName: 'Re-verify dataset before training',
  description: 'Rehash the registered file and verify the exact approved columns immediately before any training side effect.',
  inputSchema: strict({ planId: { type: 'string' }, expectedPlanHash: hash, expectedDryRunHash: hash, expectedTrainingApprovalHash: hash }, ['planId', 'expectedPlanHash', 'expectedDryRunHash', 'expectedTrainingApprovalHash']),
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetRead, THETA_PERMISSION_SCOPES.trainingWrite],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaTrainingStartToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStart,
  version: '1.0.0',
  displayName: 'Start approved training',
  description: 'Start exactly one idempotent training attempt bound to the current plan, dry run, training approval and dataset verification receipts.',
  inputSchema: strict({
    planId: { type: 'string' }, expectedPlanHash: hash, expectedDryRunHash: hash,
    expectedTrainingApprovalHash: hash, expectedDatasetVerificationHash: hash,
  }, ['planId', 'expectedPlanHash', 'expectedDryRunHash', 'expectedTrainingApprovalHash', 'expectedDatasetVerificationHash']),
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  idempotencyPolicy: { mode: 'required' },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaTrainingStatusToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingStatus,
  version: '1.0.0',
  displayName: 'Read training progress',
  description: 'Read persisted training state and return a semantic phase breakdown without starting or modifying training.',
  inputSchema: strict({ trainingRunId: { type: 'string' } }, ['trainingRunId']),
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'read',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingRead],
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 2 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaTrainingCancelToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.trainingCancel,
  version: '1.0.0',
  displayName: 'Cancel current training',
  description: 'Request cooperative cancellation of the exact current training run.',
  inputSchema: strict({ trainingRunId: { type: 'string' }, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['trainingRunId', 'reason']),
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'external_effect',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingWrite],
  timeoutPolicy: { timeoutMs: 60_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  idempotencyPolicy: { mode: 'required' },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaArtifactsVerifyToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.artifactsVerify,
  version: '1.0.0',
  displayName: 'Verify training artifacts',
  description: 'Create a hash-bound manifest only from the current completed training run and allowed THETA result roots.',
  inputSchema: strict({ trainingRunId: { type: 'string' } }, ['trainingRunId']),
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.trainingRead, THETA_PERMISSION_SCOPES.resultsRead],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaResultsListArtifactsToolSpec: ToolSpec = resultTool(THETA_TOOL_IDS.resultsListArtifacts, 'List verified artifacts');
export const thetaResultsGetSummaryToolSpec: ToolSpec = resultTool(THETA_TOOL_IDS.resultsGetSummary, 'Summarize verified results');

export const thetaDatasetVerifyForTrainingHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const request = record(input);
  return withRuntime(context, async (runtime, registry) => {
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const chain = await requireApprovalChain(execution, context.runId, request);
    const dataset = registry.require(chain.canonical.canonicalPlanRecord.canonicalPlan.datasetRef, owner(context));
    const actualHash = await hashFile(dataset.managedPath);
    const expectedHash = chain.canonical.canonicalPlanRecord.canonicalPlan.datasetSha256;
    const issues: DatasetVerificationReceipt['issues'] = [];
    if (actualHash !== expectedHash || dataset.sha256 !== expectedHash) issues.push({ code: 'DATASET_HASH_CHANGED', message: '数据文件内容已在批准后发生变化。', recoveryTarget: 'DatasetDiscovery' });
    let actualColumns: string[] = [];
    if (issues.length === 0) {
      const inspected = await callThetaBridge('dataset.inspect', { filePath: dataset.managedPath, sampleSize: 1 }, { runId: context.runId, stepId: context.stepId });
      if (inspected.status !== 'ok') issues.push({ code: 'DATASET_INSPECTION_FAILED', message: inspected.error?.message ?? '无法重新读取数据列。', recoveryTarget: 'HumanRecovery' });
      else actualColumns = strings(record(inspected.data).columns);
    }
    const requiredColumns = canonicalColumns(chain.canonical.canonicalPlanRecord.canonicalPlan);
    const missing = requiredColumns.filter((column) => !actualColumns.includes(column));
    if (missing.length > 0) issues.push({ code: 'DATASET_COLUMNS_CHANGED', message: `批准的列已经不存在：${missing.join('、')}`, recoveryTarget: 'DatasetDiscovery' });
    const material = {
      runId: context.runId,
      planId: chain.canonical.canonicalPlanRecord.planId,
      planHash: chain.canonical.canonicalPlanRecord.planHash,
      dryRunHash: chain.dryRun.dryRunHash,
      trainingApprovalHash: chain.approval.trainingApprovalHash,
      datasetRef: dataset.datasetRef,
      expectedDatasetHash: expectedHash,
      actualDatasetHash: actualHash,
      datasetPath: dataset.managedPath,
      columns: actualColumns.length > 0 ? actualColumns : requiredColumns,
      verified: issues.length === 0,
      issues,
    };
    const verificationHash = datasetVerificationReceiptHash(material);
    const receipt = datasetVerificationReceiptSchema.parse({ receiptId: `dataset-verification:${verificationHash.slice(7, 27)}`, ...material, verifiedAt: new Date().toISOString(), verificationHash });
    await execution.recordDatasetVerification({ ...identity(context), receipt });
    return { kind: 'dataset_verification', receipt, nextAction: receipt.verified ? '可以启动当前已批准训练。' : '数据复核失败，禁止启动训练。' };
  });
};

export const thetaTrainingStartHandler: ToolHandler<unknown, ToolExecutionEnvelope<Record<string, unknown>>> = async (input, context) => {
  const request = record(input);
  return withRuntime(context, async (runtime) => {
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const chain = await requireApprovalChain(execution, context.runId, request);
    const verification = await execution.currentDatasetVerification(context.runId, chain.approval.trainingApprovalHash);
    if (!verification?.verified || verification.verificationHash !== request.expectedDatasetVerificationHash) throw new Error('Training start requires the current passed DatasetVerificationReceipt.');
    const idempotencyKey = required(context.idempotencyKey, 'Tool context idempotencyKey');
    const existing = await execution.currentTrainingRun(context.runId);
    if (existing && existing.idempotencyKey === idempotencyKey) return envelope(existing, true);
    const bridge = await callThetaBridge('training.start', {
      plan: chain.canonical.canonicalPlanRecord,
      planReview: chain.canonical.planReview,
      dryRun: chain.dryRun,
      trainingReview: chain.approval,
      idempotencyKey,
    }, { runId: context.runId, stepId: context.stepId });
    if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Bridge training.start failed.');
    const data = record(bridge.data);
    const status = trainingStatus(data.status);
    const receipt: TrainingRunReceipt = trainingRunReceiptSchema.parse({
      receiptId: `training-run:${required(data.trainingRunId, 'trainingRunId')}`,
      runId: context.runId,
      trainingRunId: data.trainingRunId,
      planId: chain.canonical.canonicalPlanRecord.planId,
      planHash: chain.canonical.canonicalPlanRecord.planHash,
      dryRunHash: chain.dryRun.dryRunHash,
      trainingApprovalHash: chain.approval.trainingApprovalHash,
      datasetHash: chain.dryRun.datasetHash,
      datasetVerificationHash: verification.verificationHash,
      idempotencyKey,
      status,
      acceptedAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    });
    await execution.recordTrainingRun({ ...identity(context), receipt });
    return envelope(receipt, false);
  });
};

export const thetaTrainingStatusHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const trainingRunId = required(record(input).trainingRunId, 'trainingRunId');
  const bridge = await callThetaBridge('training.status', { trainingRunId, logLimit: 0 }, { runId: context.runId, stepId: context.stepId });
  if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Bridge training.status failed.');
  const data = record(bridge.data);
  if (data.found !== true) throw new Error(`Training run was not found: ${trainingRunId}.`);
  const receipt = record(data.receipt);
  return { kind: 'training_progress', snapshot: normalizeTrainingProgress(receipt), quality: record(receipt.quality), resultArtifacts: array(receipt.resultArtifacts), cancellation: receipt.cancellation ?? null };
};

export const thetaTrainingCancelHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const request = record(input);
  const trainingRunId = required(request.trainingRunId, 'trainingRunId');
  const reason = required(request.reason, 'reason');
  return withRuntime(context, async (runtime) => {
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const current = await execution.currentTrainingRun(context.runId);
    if (!current || current.trainingRunId !== trainingRunId) throw new Error('Cancellation targeted a stale or unknown TrainingRunReceipt.');
    const bridge = await callThetaBridge('training.cancel', { trainingRunId, reason, operator: context.userId ?? 'local_user' }, { runId: context.runId, stepId: context.stepId });
    if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Bridge training.cancel failed.');
    const data = record(bridge.data);
    const cancellation = record(data.cancellation);
    const status = data.changed === false && !['cancel_requested', 'cancelled'].includes(String(data.status)) ? 'already_terminal' : String(data.status) === 'cancel_requested' ? 'cancel_requested' : 'cancelled';
    const material = { cancellationId: required(cancellation.cancellationId ?? `cancel:${trainingRunId}`, 'cancellationId'), runId: context.runId, trainingRunId, operator: context.userId ?? 'local_user', reason, status } as const;
    const cancellationHash = trainingCancellationReceiptHash(material);
    const receipt = trainingCancellationReceiptSchema.parse({ ...material, requestedAt: typeof cancellation.requestedAt === 'string' ? cancellation.requestedAt : new Date().toISOString(), cancellationHash });
    await execution.recordCancellation({ ...identity(context), receipt });
    return { kind: 'training_cancellation', receipt };
  });
};

export const thetaArtifactsVerifyHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const trainingRunId = required(record(input).trainingRunId, 'trainingRunId');
  return withRuntime(context, async (runtime) => {
    const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
    const run = await execution.currentTrainingRun(context.runId);
    if (!run || run.trainingRunId !== trainingRunId) throw new Error('Artifact verification targeted a stale training run.');
    const existing = await execution.currentArtifactManifest(context.runId, trainingRunId);
    if (existing) return { kind: 'verified_artifact_manifest', manifest: existing, reused: true };
    const bridge = await callThetaBridge('training.status', { trainingRunId, logLimit: 0 }, { runId: context.runId, stepId: context.stepId });
    if (bridge.status !== 'ok') throw new Error(bridge.error?.message ?? 'Unable to read completed training artifacts.');
    const bridgeReceipt = record(record(bridge.data).receipt);
    if (bridgeReceipt.status !== 'completed') throw new Error('Artifacts can only be verified after training completes.');
    const candidates = array(bridgeReceipt.resultArtifacts).map(record);
    if (candidates.length === 0 || candidates.some((item) => item.exists !== true)) throw new Error('Required run-bound artifacts are missing.');
    const artifacts = [];
    for (const [index, candidate] of candidates.entries()) {
      const verified = await verifyArtifact(candidate, trainingRunId);
      artifacts.push({ artifactId: `${String(candidate.kind ?? 'artifact')}:${index + 1}`, kind: required(candidate.kind, 'artifact.kind'), ...verified, verified: true as const });
    }
    const material = { runId: context.runId, trainingRunId, planHash: run.planHash, artifacts };
    const manifestHash = artifactManifestHash(material);
    const manifest = verifiedArtifactManifestSchema.parse({ manifestId: `artifact-manifest:${manifestHash.slice(7, 27)}`, ...material, verifiedAt: new Date().toISOString(), manifestHash });
    await execution.recordArtifactManifest({ ...identity(context), manifest });
    return { kind: 'verified_artifact_manifest', manifest, reused: false, quality: record(bridgeReceipt.quality) };
  });
};

export const thetaResultsListArtifactsHandler: ToolHandler<unknown, Record<string, unknown>> = async (_input, context) => withRuntime(context, async (runtime) => {
  const manifest = await new ThetaExecutionEventRepository(runtime.eventBridge).currentArtifactManifest(context.runId);
  if (!manifest) throw new Error('No VerifiedArtifactManifest is available for this Run.');
  return { kind: 'verified_artifacts', manifestId: manifest.manifestId, manifestHash: manifest.manifestHash, artifacts: manifest.artifacts };
});

export const thetaResultsGetSummaryHandler: ToolHandler<unknown, Record<string, unknown>> = async (_input, context) => withRuntime(context, async (runtime) => {
  const execution = new ThetaExecutionEventRepository(runtime.eventBridge);
  const canonical = await execution.currentCanonicalPlan(context.runId);
  const run = await execution.currentTrainingRun(context.runId);
  const progress = await execution.currentTrainingProgress(context.runId, run?.trainingRunId);
  const manifest = await execution.currentArtifactManifest(context.runId, run?.trainingRunId);
  if (!canonical || !run || !manifest) throw new Error('Verified training results are not ready.');
  return {
    kind: 'verified_results_summary',
    trainingRunId: run.trainingRunId,
    model: canonical.canonicalPlanRecord.canonicalPlan.model.modelId,
    experimentCount: canonical.canonicalPlanRecord.canonicalPlan.experimentProtocol.estimatedTrainingRuns,
    status: progress?.status ?? run.status,
    verifiedArtifactCount: manifest.artifacts.length,
    manifestHash: manifest.manifestHash,
    automaticPostTrainingOutputs: true,
  };
});

const requireApprovalChain = async (execution: ThetaExecutionEventRepository, runId: string, request: Record<string, unknown>) => {
  const canonical = await execution.currentCanonicalPlan(runId);
  if (!canonical || canonical.canonicalPlanRecord.planId !== request.planId || canonical.canonicalPlanRecord.planHash !== request.expectedPlanHash) throw new Error('Operation targeted a stale Canonical Plan.');
  const dryRun = await execution.currentDryRun(runId, canonical.canonicalPlanRecord.planHash);
  if (!dryRun?.passed || dryRun.dryRunHash !== request.expectedDryRunHash) throw new Error('Operation requires the current passed DryRunReceipt.');
  const approval = await execution.currentTrainingApproval(runId, dryRun.dryRunHash);
  if (!approval || approval.trainingApprovalHash !== request.expectedTrainingApprovalHash || approval.planHash !== canonical.canonicalPlanRecord.planHash || approval.datasetHash !== dryRun.datasetHash) throw new Error('Operation requires the current bound HumanTrainingReview.');
  return { canonical, dryRun, approval };
};

export const normalizeTrainingProgress = (receipt: Record<string, unknown>): TrainingProgressSnapshot => {
  const status = trainingStatus(receipt.status);
  const bridgePhase = String(receipt.currentPhase ?? 'preparing');
  const phase = phaseFromBridge(status, bridgePhase);
  const context = record(receipt.phaseContext);
  const totalRuns = positive(context.totalRuns, 1);
  const runIndex = Math.max(0, integer(context.runIndex, phase === 'training' ? 1 : 0));
  const rawPercent = number(receipt.progress, 0);
  const overallPercent = status === 'completed' ? 100 : Math.max(0, Math.min(99, rawPercent));
  const failure = normalizeFailure(receipt.failure, receipt.errorMessage, status);
  const started = typeof receipt.startedAt === 'string' ? Date.parse(receipt.startedAt) : NaN;
  const updated = typeof receipt.updatedAt === 'string' ? Date.parse(receipt.updatedAt) : Date.now();
  return trainingProgressSnapshotSchema.parse({
    trainingRunId: required(receipt.trainingRunId, 'trainingRunId'), status, phase,
    phaseLabel: phaseLabel(phase, context), completedRuns: phase === 'completed' ? totalRuns : Math.max(0, runIndex - (phase === 'training' ? 1 : 0)), totalRuns,
    overallPercent, elapsedMs: Number.isFinite(started) ? Math.max(0, updated - started) : 0,
    nextPollAfterMs: status === 'queued' ? 2_000 : 5_000,
    activitySummary: activitySummary(phase, context, totalRuns), updatedAt: typeof receipt.updatedAt === 'string' ? receipt.updatedAt : new Date().toISOString(), failure,
  });
};

const normalizeFailure = (value: unknown, error: unknown, status: TrainingProgressSnapshot['status']): TrainingFailureDescriptor | null => {
  if (!['failed', 'quarantined'].includes(status)) return null;
  const item = record(value);
  const code = typeof item.code === 'string' ? item.code : status === 'quarantined' ? 'TRAINING_STATE_UNKNOWN' : 'TRAINING_FAILED';
  const category = /DATASET|COLUMN/u.test(code) ? 'dataset' : /PYTHON|DEPEND|ENV/u.test(code) ? 'environment' : status === 'quarantined' ? 'runtime' : 'runtime';
  return { code, category, message: String(item.summary ?? item.message ?? error ?? '训练执行失败。'), retryable: item.retryable === true, recoveryTarget: category === 'dataset' ? 'DatasetDiscovery' : category === 'environment' ? 'HumanRecovery' : 'MonitorTraining', details: { stage: String(item.stage ?? 'unknown'), technicalDetail: String(item.technicalDetail ?? '') } };
};

const envelope = (receipt: TrainingRunReceipt, reused: boolean): ToolExecutionEnvelope<Record<string, unknown>> => ({
  kind: 'tool_execution_envelope',
  output: { kind: 'training_started', receipt, reused, nextAction: '训练已进入持久监控。' },
  externalReceipt: { provider: 'theta-python-bridge', receiptId: receipt.trainingRunId, status: receipt.status, metadata: { planHash: receipt.planHash, dryRunHash: receipt.dryRunHash } },
});

const verifyArtifact = async (candidate: Record<string, unknown>, trainingRunId: string): Promise<{ path: string; sha256: string; sizeBytes: number }> => {
  const candidatePath = path.resolve(required(candidate.path, 'artifact.path'));
  const canonical = await realpath(candidatePath);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const resultRoot = await realpath(path.join(projectRoot, 'THETA', 'result')).catch(() => path.join(projectRoot, 'THETA', 'result'));
  const workspaceRoot = await realpath(path.join(projectRoot, 'THETA', 'data', 'workspace')).catch(() => path.join(projectRoot, 'THETA', 'data', 'workspace'));
  if (!within(canonical, resultRoot) && !within(canonical, workspaceRoot)) throw new Error(`Artifact escaped THETA result roots: ${canonical}`);
  if (String(candidate.kind).startsWith('results') && !canonical.includes(trainingRunId)) throw new Error('Result artifact is not bound to the current trainingRunId.');
  const info = await lstat(canonical);
  if (info.isSymbolicLink()) throw new Error('Symbolic-link artifacts are not accepted.');
  const computed = info.isDirectory() ? await hashTree(canonical) : { sha256: await hashFile(canonical), sizeBytes: info.size };
  if (typeof candidate.sha256 === 'string' && candidate.sha256 !== computed.sha256) throw new Error(`Artifact hash changed after Bridge binding: ${canonical}`);
  return { path: canonical, ...computed };
};

const hashTree = async (root: string): Promise<{ sha256: string; sizeBytes: number }> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact tree contains a symbolic link: ${full}`);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(root);
  // Match pathlib.WindowsPath ordering used by the Python Bridge.  Comparing
  // absolute Windows strings (or using localeCompare) changes the order of
  // path separators, ASCII names and Chinese artifact names, which makes an
  // unchanged directory produce a different cross-language tree hash.
  const relativeKey = (file: string): string => path.relative(root, file).split(path.sep).join('/').toLowerCase();
  files.sort((a, b) => {
    const left = relativeKey(a);
    const right = relativeKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const info = await stat(file);
    const fileHash = await hashFile(file);
    sizeBytes += info.size;
    digest.update(relative); digest.update('\0'); digest.update(fileHash); digest.update('\n');
  }
  return { sha256: digest.digest('hex'), sizeBytes };
};

const hashFile = (filename: string): Promise<string> => new Promise((resolvePromise, reject) => {
  const digest = createHash('sha256');
  const stream = createReadStream(filename);
  stream.on('data', (chunk) => digest.update(chunk)); stream.on('error', reject); stream.on('end', () => resolvePromise(digest.digest('hex')));
});

function resultTool(id: string, displayName: string): ToolSpec { return { id, version: '1.0.0', displayName, description: 'Read only artifacts already admitted to the current VerifiedArtifactManifest.', inputSchema: strict({}, []), outputSchema: { type: 'object', additionalProperties: true }, sideEffectLevel: 'read', permissionScope: [THETA_PERMISSION_SCOPES.resultsRead], timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' }, retryPolicy: { maxAttempts: 2 }, auditPolicy: { enabled: true, includeInput: true, includeOutput: true }, source: 'local' }; }
const withRuntime = async <T>(context: ToolCallContext, operation: (runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>, registry: SQLiteDatasetRegistry) => Promise<T>): Promise<T> => { const runtimeDb = typeof context.metadata?.thetaRuntimeDb === 'string' ? context.metadata.thetaRuntimeDb : defaultThetaV6RuntimeDb(); const runtime = await createThetaRuntimeComposition(runtimeDb); const registry = new SQLiteDatasetRegistry(runtimeDb); try { return await operation(runtime, registry); } finally { registry.close(); await runtime.close(); } };
const identity = (context: ToolCallContext) => ({ runId: context.runId, sessionId: context.sessionId ?? `session:${context.runId}`, userId: context.userId ?? 'local_user' });
const owner = (context: ToolCallContext) => ({ userId: context.userId ?? 'local_user', workspaceId: context.workspaceId ?? 'local_workspace' });
const canonicalColumns = (plan: { columns: { textColumns: string[]; timeColumn: string | null; idColumn: string | null; covariateColumns: string[]; groupingColumns: string[] } }): string[] => [...new Set([...plan.columns.textColumns, plan.columns.timeColumn, plan.columns.idColumn, ...plan.columns.covariateColumns, ...plan.columns.groupingColumns].filter((item): item is string => Boolean(item)))];
const trainingStatus = (value: unknown): TrainingRunReceipt['status'] => ['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'quarantined'].includes(String(value)) ? String(value) as TrainingRunReceipt['status'] : 'unknown';
const phaseFromBridge = (status: TrainingProgressSnapshot['status'], bridgePhase: string): TrainingProgressSnapshot['phase'] => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'quarantined' || status === 'cancelled') return 'failed';
  const phases: Record<string, TrainingProgressSnapshot['phase']> = {
    preparing: 'queued', preprocessing: 'preparing_data', features: 'building_features',
    training: 'training', evaluating: 'evaluating', visualizing: 'visualizing', packaging: 'verifying_artifacts',
  };
  return phases[bridgePhase] ?? 'queued';
};
const phaseLabel = (phase: TrainingProgressSnapshot['phase'], context: Record<string, unknown>): string => phase === 'training' ? `训练 ${String(context.modelId ?? 'model')}（种子 ${String(context.seed ?? '?')}）` : ({ queued: '等待训练进程', preparing_data: '准备数据', building_features: '构建特征', evaluating: '评估结果', visualizing: '生成可视化', verifying_artifacts: '验证产物', completed: '训练完成', failed: '训练失败' } as Record<string, string>)[phase] ?? phase;
const activitySummary = (phase: TrainingProgressSnapshot['phase'], context: Record<string, unknown>, total: number): string => phase === 'training' ? `正在执行第 ${String(context.runIndex ?? '?')} / ${total} 个训练实验。` : phaseLabel(phase, context);
const within = (candidate: string, root: string): boolean => { const relative = path.relative(root, candidate); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const strings = (value: unknown): string[] => array(value).map(String).filter(Boolean);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const required = (value: unknown, label: string): string => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); return value.trim(); };
const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const integer = (value: unknown, fallback: number): number => Number.isInteger(value) ? Number(value) : fallback;
const positive = (value: unknown, fallback: number): number => { const parsed = integer(value, fallback); return parsed > 0 ? parsed : fallback; };
