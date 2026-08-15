import type {
  ApproveTrainingRequest,
  CheckpointConfirmationReceipt,
  CommandReceipt,
  ConfirmCheckpointRequest,
  ConversationPage,
  ConversationalCheckpointView,
  CreateRemoteSampleAuthorizationRequest,
  CreateRunAccepted,
  CreateRunRequest,
  DatasetCatalogPage,
  MessageAccepted,
  RecoveryCommandAccepted,
  RecoveryCommandRequest,
  RemoteSampleAuthorizationReceipt,
  ResultAnalysisMessageRequest,
  ResultArtifactPage,
  SendMessageRequest,
  ThetaHealthV3,
  ThetaRunSummaryV3,
  ThetaRunViewV3,
  TrainingApprovalReceipt,
} from './contracts.generated';
import { createClientId } from './ids';
import { HttpTransport, type ThetaV3Transport } from './transport';

export interface ListMessagesOptions {
  afterSequence?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface DeleteRunReceipt {
  runId: string;
  deleted: boolean;
}

export class ThetaAgentV3Client {
  constructor(private readonly transport: ThetaV3Transport = new HttpTransport()) {}

  health(signal?: AbortSignal): Promise<ThetaHealthV3> {
    return this.transport.request({ method: 'GET', path: 'health', signal });
  }

  listRuns(signal?: AbortSignal): Promise<{ items: ThetaRunSummaryV3[] }> {
    return this.transport.request({ method: 'GET', path: 'runs', signal });
  }

  listDatasets(signal?: AbortSignal): Promise<DatasetCatalogPage> {
    return this.transport.request({ method: 'GET', path: 'datasets', signal });
  }

  createRun(
    input: Omit<CreateRunRequest, 'clientCommandId'> & { clientCommandId?: string },
    signal?: AbortSignal,
  ): Promise<CreateRunAccepted> {
    return this.transport.request({
      method: 'POST',
      path: 'runs',
      body: { ...input, clientCommandId: input.clientCommandId ?? createClientId('command') },
      signal,
    });
  }

  deleteRun(runId: string, signal?: AbortSignal): Promise<DeleteRunReceipt> {
    return this.transport.request({
      method: 'DELETE',
      path: `runs/${encodeURIComponent(runId)}`,
      signal,
    });
  }

  getRunView(runId: string, signal?: AbortSignal): Promise<ThetaRunViewV3> {
    return this.transport.request({
      method: 'GET',
      path: `runs/${encodeURIComponent(runId)}/view`,
      signal,
    });
  }

  listMessages(runId: string, options: ListMessagesOptions = {}): Promise<ConversationPage> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) query.set('afterSequence', String(options.afterSequence));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.transport.request({
      method: 'GET',
      path: `runs/${encodeURIComponent(runId)}/messages${suffix}`,
      signal: options.signal,
    });
  }

  sendMessage(
    runId: string,
    input: Omit<SendMessageRequest, 'clientMessageId' | 'clientCommandId'> &
      Partial<Pick<SendMessageRequest, 'clientMessageId' | 'clientCommandId'>>,
    signal?: AbortSignal,
  ): Promise<MessageAccepted> {
    return this.transport.request({
      method: 'POST',
      path: `runs/${encodeURIComponent(runId)}/messages`,
      body: {
        ...input,
        clientMessageId: input.clientMessageId ?? createClientId('message'),
        clientCommandId: input.clientCommandId ?? createClientId('command'),
      },
      signal,
    });
  }

  getCommand(runId: string, commandId: string, signal?: AbortSignal): Promise<CommandReceipt> {
    return this.transport.request({
      method: 'GET',
      path: `runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`,
      signal,
    });
  }

  getCurrentCheckpoint(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ConversationalCheckpointView | null> {
    return this.transport.request({
      method: 'GET',
      path: `runs/${encodeURIComponent(runId)}/checkpoints/current`,
      signal,
    });
  }

  confirmCheckpoint(
    runId: string,
    checkpointId: string,
    input: Omit<ConfirmCheckpointRequest, 'clientCommandId'> & { clientCommandId?: string },
    signal?: AbortSignal,
  ): Promise<CheckpointConfirmationReceipt> {
    return this.transport.request({
      method: 'POST',
      path: `runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/confirmations`,
      body: { ...input, clientCommandId: input.clientCommandId ?? createClientId('command') },
      signal,
    });
  }

  authorizeRemoteSample(
    datasetRef: string,
    input: Omit<CreateRemoteSampleAuthorizationRequest, 'clientCommandId'> & {
      clientCommandId?: string;
    },
    signal?: AbortSignal,
  ): Promise<RemoteSampleAuthorizationReceipt> {
    return this.transport.request({
      method: 'POST',
      path: `datasets/${encodeURIComponent(datasetRef)}/remote-sample-authorizations`,
      body: { ...input, clientCommandId: input.clientCommandId ?? createClientId('command') },
      signal,
    });
  }

  approveTraining(
    runId: string,
    input: Omit<ApproveTrainingRequest, 'clientCommandId'> & { clientCommandId?: string },
    signal?: AbortSignal,
  ): Promise<TrainingApprovalReceipt> {
    return this.transport.request({
      method: 'POST',
      path: `runs/${encodeURIComponent(runId)}/training/approvals`,
      body: { ...input, clientCommandId: input.clientCommandId ?? createClientId('command') },
      signal,
    });
  }

  executeRecoveryCommand(
    runId: string,
    input: Omit<RecoveryCommandRequest, 'clientCommandId'> & { clientCommandId?: string },
    signal?: AbortSignal,
  ): Promise<RecoveryCommandAccepted> {
    return this.transport.request({
      method: 'POST',
      path: `runs/${encodeURIComponent(runId)}/recovery-commands`,
      body: { ...input, clientCommandId: input.clientCommandId ?? createClientId('command') },
      signal,
    });
  }

  listResultArtifacts(runId: string, signal?: AbortSignal): Promise<ResultArtifactPage> {
    return this.transport.request({
      method: 'GET',
      path: `runs/${encodeURIComponent(runId)}/results/artifacts`,
      signal,
    });
  }

  sendResultAnalysisMessage(
    runId: string,
    input: Omit<ResultAnalysisMessageRequest, 'clientMessageId' | 'clientCommandId'> &
      Partial<Pick<ResultAnalysisMessageRequest, 'clientMessageId' | 'clientCommandId'>>,
    signal?: AbortSignal,
  ): Promise<MessageAccepted> {
    return this.transport.request({
      method: 'POST',
      path: `runs/${encodeURIComponent(runId)}/results/analysis-messages`,
      body: {
        ...input,
        clientMessageId: input.clientMessageId ?? createClientId('message'),
        clientCommandId: input.clientCommandId ?? createClientId('command'),
      },
      signal,
    });
  }
}
