import assert from 'node:assert/strict';
import { ThetaAgentV3Client } from '../../lib/api/v3/client';
import type { ProductRunEvent } from '../../lib/api/v3/contracts.generated';
import { ThetaApiError } from '../../lib/api/v3/errors';
import { RunViewStore } from '../../lib/agent/run-view-store';
import { defaultRunView } from './fixtures/default-scenario';
import { MockThetaV3Transport } from './scenario-router';

const main = async (): Promise<void> => {
  const transport = new MockThetaV3Transport();
  const client = new ThetaAgentV3Client(transport);

  const health = await client.health();
  assert.equal(health.status, 'ready');
  assert.equal(health.capabilities.events, true);

  const datasets = await client.listDatasets();
  assert.equal(datasets.items.length, 2);
  const remoteDataset = datasets.items.find((item) => item.source === 'remote');
  assert.ok(remoteDataset);

  await assert.rejects(
    client.createRun({ datasetRef: remoteDataset.datasetRef }),
    (error: unknown) =>
      error instanceof ThetaApiError &&
      error.descriptor.code === 'REMOTE_SAMPLE_AUTHORIZATION_REQUIRED',
  );

  const remoteAuthorization = await client.authorizeRemoteSample(remoteDataset.datasetRef, {
    maxRows: 10,
    purpose: 'dataset_understanding',
    expiresInMinutes: 120,
    acceptedRedactionPolicyVersion: 'theta-redaction@1.0.0',
  });
  const remoteRun = await client.createRun({
    datasetRef: remoteDataset.datasetRef,
    remoteSampleAuthorizationId: remoteAuthorization.authorizationId,
  });
  assert.equal(remoteRun.view.phase, 'research_dialogue');
  assert.equal(remoteRun.view.checkpoint, undefined);
  assert.equal(remoteRun.view.dataset?.datasetRef, remoteDataset.datasetRef);

  const researchMessage = await client.sendMessage(remoteRun.runId, {
    expectedRunRevision: remoteRun.view.revision,
    content: '比较不同媒体对人工智能监管议题的关注重点。',
  });
  const researchCheckpointView = await client.getRunView(remoteRun.runId);
  assert.equal(researchMessage.runRevision, remoteRun.view.revision + 1);
  assert.equal(researchCheckpointView.checkpoint?.kind, 'research');
  assert.equal(researchCheckpointView.research?.statements[0].status, 'confirmed');

  await client.sendMessage(remoteRun.runId, {
    expectedRunRevision: researchCheckpointView.revision,
    content: '确认并修改：只看最近三个月，同时比较中文和英文报道。',
    checkpointContext: {
      checkpointId: researchCheckpointView.checkpoint!.checkpointId,
      revision: researchCheckpointView.checkpoint!.revision,
      contentHash: researchCheckpointView.checkpoint!.contentHash,
    },
  });
  const revisedResearchView = await client.getRunView(remoteRun.runId);
  assert.equal(revisedResearchView.phase, 'research_dialogue');
  assert.equal(revisedResearchView.checkpoint?.status, 'proposed');
  assert.equal(revisedResearchView.checkpoint?.revision, 2);

  const researchReceipt = await client.confirmCheckpoint(
    revisedResearchView.runId,
    revisedResearchView.checkpoint!.checkpointId,
    {
      expectedRunRevision: revisedResearchView.revision,
      checkpointRevision: revisedResearchView.checkpoint!.revision,
      contentHash: revisedResearchView.checkpoint!.contentHash,
    },
  );
  assert.equal(researchReceipt.kind, 'research');
  const planCheckpointView = await client.getRunView(remoteRun.runId);
  assert.equal(planCheckpointView.phase, 'plan_confirmation');
  assert.equal(planCheckpointView.checkpoint?.kind, 'plan');
  assert.equal(planCheckpointView.checkpoint?.mandatory, true);
  assert.equal(planCheckpointView.plan?.status, 'valid');
  assert.equal(
    planCheckpointView.checkpoint?.contentHash,
    planCheckpointView.plan?.candidatePlanHash,
  );

  const oldPlanCheckpoint = structuredClone(planCheckpointView.checkpoint!);
  await client.sendMessage(remoteRun.runId, {
    expectedRunRevision: planCheckpointView.revision,
    content: '将主题数量调整为 12，并保留 NMF 作为基线。',
    checkpointContext: {
      checkpointId: oldPlanCheckpoint.checkpointId,
      revision: oldPlanCheckpoint.revision,
      contentHash: oldPlanCheckpoint.contentHash,
    },
  });
  const revisedPlanView = await client.getRunView(remoteRun.runId);
  assert.equal(revisedPlanView.plan?.revision, oldPlanCheckpoint.revision + 1);
  assert.notEqual(revisedPlanView.plan?.candidatePlanHash, oldPlanCheckpoint.contentHash);
  assert.equal(revisedPlanView.plan?.parameters[0].source, 'user');

  await assert.rejects(
    client.confirmCheckpoint(
      revisedPlanView.runId,
      oldPlanCheckpoint.checkpointId,
      {
        expectedRunRevision: revisedPlanView.revision,
        checkpointRevision: oldPlanCheckpoint.revision,
        contentHash: oldPlanCheckpoint.contentHash,
      },
    ),
    (error: unknown) =>
      error instanceof ThetaApiError && error.descriptor.code === 'CHECKPOINT_SUPERSEDED',
  );

  const planReceipt = await client.confirmCheckpoint(
    revisedPlanView.runId,
    revisedPlanView.checkpoint!.checkpointId,
    {
      expectedRunRevision: revisedPlanView.revision,
      checkpointRevision: revisedPlanView.checkpoint!.revision,
      contentHash: revisedPlanView.plan!.candidatePlanHash,
    },
  );
  assert.equal(planReceipt.kind, 'plan');
  assert.equal(planReceipt.contentHash, revisedPlanView.plan?.candidatePlanHash);
  const trainingApprovalView = await client.getRunView(remoteRun.runId);
  assert.equal(trainingApprovalView.phase, 'training_confirmation');
  assert.equal(trainingApprovalView.capabilities.canApprovePlan, false);
  assert.equal(trainingApprovalView.capabilities.canApproveTraining, true);
  assert.ok(trainingApprovalView.training?.dryRunHash);

  await assert.rejects(
    client.approveTraining(trainingApprovalView.runId, {
      expectedRunRevision: trainingApprovalView.revision,
      dryRunHash: 'sha256:stale-dry-run',
    }),
    (error: unknown) =>
      error instanceof ThetaApiError && error.descriptor.code === 'DRY_RUN_SUPERSEDED',
  );

  const trainingReceipt = await client.approveTraining(trainingApprovalView.runId, {
    expectedRunRevision: trainingApprovalView.revision,
    dryRunHash: trainingApprovalView.training!.dryRunHash!,
  });
  assert.equal(trainingReceipt.dryRunHash, trainingApprovalView.training?.dryRunHash);
  assert.equal(trainingReceipt.canonicalPlanHash, revisedPlanView.plan?.candidatePlanHash);

  const runningView = await client.getRunView(remoteRun.runId);
  assert.equal(runningView.phase, 'training');
  assert.equal(runningView.training?.status, 'running');
  assert.equal(runningView.training?.progress.percent, null);
  assert.equal(runningView.training?.progress.indeterminate, true);

  const evaluatingView = await client.getRunView(remoteRun.runId);
  assert.equal(evaluatingView.training?.status, 'evaluating');
  assert.equal(evaluatingView.training?.progress.percent, 72);
  assert.equal(evaluatingView.training?.experiments.length, 6);

  const completedView = await client.getRunView(remoteRun.runId);
  assert.equal(completedView.phase, 'completed');
  assert.equal(completedView.results?.status, 'available');
  const artifacts = await client.listResultArtifacts(remoteRun.runId);
  assert.equal(artifacts.items.length, completedView.results?.artifactCount);
  assert.ok(artifacts.items.every((artifact) => artifact.contentUrl.startsWith('/api/agent-v3/mock-artifacts/')));

  const analysis = await client.sendResultAnalysisMessage(remoteRun.runId, {
    expectedRunRevision: completedView.revision,
    content: '哪些主题最稳定？',
    artifactIds: artifacts.items.map((artifact) => artifact.artifactId),
  });
  assert.equal(analysis.command.status, 'accepted');
  assert.equal(analysis.message.citations?.length, artifacts.items.length);

  const delegatedTransport = new MockThetaV3Transport();
  const delegatedClient = new ThetaAgentV3Client(delegatedTransport);
  const delegatedAuthorization = await delegatedClient.authorizeRemoteSample(remoteDataset.datasetRef, {
    maxRows: 10,
    purpose: 'dataset_understanding',
    expiresInMinutes: 120,
    acceptedRedactionPolicyVersion: 'theta-redaction@1.0.0',
  });
  const delegatedRun = await delegatedClient.createRun({
    datasetRef: remoteDataset.datasetRef,
    remoteSampleAuthorizationId: delegatedAuthorization.authorizationId,
    initialMessage: '研究方向由你决定，直接规划。',
  });
  assert.equal(delegatedRun.view.phase, 'plan_confirmation');
  assert.equal(delegatedRun.view.checkpoint?.kind, 'plan');
  assert.ok(delegatedRun.view.research);

  const failureMessage = await delegatedClient.sendMessage(delegatedRun.runId, {
    expectedRunRevision: delegatedRun.view.revision,
    content: '模拟工具权限拒绝。',
    checkpointContext: {
      checkpointId: delegatedRun.view.checkpoint!.checkpointId,
      revision: delegatedRun.view.checkpoint!.revision,
      contentHash: delegatedRun.view.checkpoint!.contentHash,
    },
  });
  const failureView = await delegatedClient.getRunView(delegatedRun.runId);
  assert.equal(failureMessage.runRevision, delegatedRun.view.revision + 1);
  assert.equal(failureView.phase, 'recovery');
  assert.equal(failureView.failure?.code, 'TOOL_PERMISSION_DENIED');

  await assert.rejects(
    delegatedClient.executeRecoveryCommand(failureView.runId, {
      expectedRunRevision: failureView.revision,
      actionId: 'create_recovery_run',
    }),
    (error: unknown) =>
      error instanceof ThetaApiError && error.descriptor.code === 'RECOVERY_ACTION_NOT_ALLOWED',
  );
  const recovery = await delegatedClient.executeRecoveryCommand(failureView.runId, {
    expectedRunRevision: failureView.revision,
    actionId: 'retry_plan_validation',
  });
  assert.equal(recovery.failureId, failureView.failure?.failureId);
  const recoveredView = await delegatedClient.getRunView(delegatedRun.runId);
  assert.equal(recoveredView.runId, delegatedRun.runId);
  assert.equal(recoveredView.phase, 'plan_confirmation');
  assert.equal(recoveredView.failure, undefined);

  const checkpointTransport = new MockThetaV3Transport();
  const checkpointClient = new ThetaAgentV3Client(checkpointTransport);

  const initial = await checkpointClient.getRunView(defaultRunView.runId);
  const accepted = await checkpointClient.sendMessage(defaultRunView.runId, {
    expectedRunRevision: initial.revision,
    content: '正文列应当是 comment。',
    checkpointContext: {
      checkpointId: initial.checkpoint!.checkpointId,
      revision: initial.checkpoint!.revision,
      contentHash: initial.checkpoint!.contentHash,
    },
  });
  assert.equal(accepted.command.status, 'accepted');
  assert.equal(accepted.runRevision, initial.revision + 1);

  const page = await checkpointClient.listMessages(defaultRunView.runId, { afterSequence: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].sequence, 2);

  await assert.rejects(
    checkpointClient.sendMessage(defaultRunView.runId, {
      expectedRunRevision: initial.revision,
      content: '这是使用旧 revision 的重复提交。',
    }),
    (error: unknown) => error instanceof ThetaApiError && error.isStaleRevision,
  );

  const current = await checkpointClient.getRunView(defaultRunView.runId);
  const receipt = await checkpointClient.confirmCheckpoint(
    current.runId,
    current.checkpoint!.checkpointId,
    {
      expectedRunRevision: current.revision,
      checkpointRevision: current.checkpoint!.revision,
      contentHash: current.checkpoint!.contentHash,
    },
  );
  assert.equal(receipt.contentHash, current.checkpoint!.contentHash);

  const store = new RunViewStore();
  assert.equal(store.hydrateView(current), true);
  const staleEvent: ProductRunEvent = {
    eventId: 'event_stale',
    sequence: 10,
    type: 'agent.activity.updated',
    runId: current.runId,
    runRevision: current.revision - 1,
    occurredAt: new Date().toISOString(),
    payload: { view: { activity: { kind: 'idle', label: '陈旧状态' } } },
  };
  assert.equal(store.applyEvent(staleEvent), false);
  assert.equal(store.getSnapshot().view?.activity.label, current.activity.label);

  const conversationalTransport = new MockThetaV3Transport();
  const conversationalClient = new ThetaAgentV3Client(conversationalTransport);
  const readyDataset = datasets.items.find((item) => item.availability === 'ready');
  assert.ok(readyDataset);
  const conversationalRun = await conversationalClient.createRun({
    datasetRef: readyDataset.datasetRef,
    initialMessage: '请在对话中导入并分析数据。',
  });
  assert.equal(conversationalRun.view.phase, 'research_dialogue');
  const conversationalMessages = await conversationalClient.listMessages(conversationalRun.runId);
  assert.ok(conversationalMessages.items.some((message) => message.role === 'user'));
  const secondConversationalRun = await conversationalClient.createRun({
    datasetRef: readyDataset.datasetRef,
    initialMessage: '创建第二个独立分析项目。',
  });
  assert.notEqual(secondConversationalRun.runId, conversationalRun.runId);
  const conversationalRuns = await conversationalClient.listRuns();
  assert.ok(conversationalRuns.items.some((run) => run.runId === conversationalRun.runId));
  assert.ok(conversationalRuns.items.some((run) => run.runId === secondConversationalRun.runId));
  const reopenedFirstRun = await conversationalClient.getRunView(conversationalRun.runId);
  assert.equal(reopenedFirstRun.runId, conversationalRun.runId);
  const reopenedFirstMessages = await conversationalClient.listMessages(conversationalRun.runId);
  assert.ok(reopenedFirstMessages.items.some((message) => message.content.includes('导入并分析数据')));

  const deleteTransport = new MockThetaV3Transport();
  const deleteClient = new ThetaAgentV3Client(deleteTransport);
  const deletion = await deleteClient.deleteRun(defaultRunView.runId);
  assert.equal(deletion.deleted, true);
  assert.equal((await deleteClient.listRuns()).items.length, 0);

  console.log(JSON.stringify({ status: 'ok', suite: 'theta-web-v3-contracts', phase: 'F9' }));
};

void main();
