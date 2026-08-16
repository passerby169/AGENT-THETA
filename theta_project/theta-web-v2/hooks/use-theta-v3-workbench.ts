'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createClientId,
  createThetaAgentV3Client,
  ThetaApiError,
  type CommandReceipt,
  type ConversationMessage,
  type DatasetCatalogItem,
  type ResultArtifactSummary,
  type ThetaHealthV3,
  type ThetaRunSummaryV3,
} from '@/lib/api/v3';
import { RunViewStore } from '@/lib/agent/run-view-store';
import { useRunEvents, type EventConnectionStatus } from './use-run-events';

interface PendingMessage {
  clientMessageId: string;
  content: string;
  createdAt: string;
}

export interface ThetaV3WorkbenchController {
  health?: ThetaHealthV3;
  datasets: DatasetCatalogItem[];
  resultArtifacts: ResultArtifactSummary[];
  runs: ThetaRunSummaryV3[];
  activeRunId?: string;
  state: ReturnType<RunViewStore['getSnapshot']>;
  pendingMessages: PendingMessage[];
  loading: boolean;
  refreshing: boolean;
  commandBusy: boolean;
  deletingRunId?: string;
  eventStatus: EventConnectionStatus;
  error?: string;
  openRun: (runId: string) => Promise<void>;
  startNewProject: () => void;
  deleteRun: (runId: string) => Promise<void>;
  refresh: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  confirmCheckpoint: () => Promise<void>;
  approveTraining: () => Promise<void>;
  executeRecovery: (actionId: string) => Promise<void>;
  createRun: (input: { initialMessage: string; datasetRef?: string }) => Promise<boolean>;
}

export const useThetaV3Workbench = (): ThetaV3WorkbenchController => {
  const client = useMemo(() => createThetaAgentV3Client(), []);
  const store = useMemo(() => new RunViewStore(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [health, setHealth] = useState<ThetaHealthV3>();
  const [datasets, setDatasets] = useState<DatasetCatalogItem[]>([]);
  const [resultArtifacts, setResultArtifacts] = useState<ResultArtifactSummary[]>([]);
  const [runs, setRuns] = useState<ThetaRunSummaryV3[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string>();
  const [error, setError] = useState<string>();

  const mergeAcceptedMessage = useCallback((message: ConversationMessage, command: CommandReceipt) => {
    store.mergeMessages([message]);
    store.trackCommand(command);
    setPendingMessages((current) =>
      current.filter((pending) => pending.clientMessageId !== message.clientMessageId),
    );
  }, [store]);

  const loadRun = useCallback(async (runId: string) => {
    const [view, messages] = await Promise.all([
      client.getRunView(runId),
      client.listMessages(runId, { limit: 100 }),
    ]);
    store.hydrateView(view);
    store.mergeMessages(messages.items);
    if (view.results?.status === 'available') {
      const artifacts = await client.listResultArtifacts(runId);
      setResultArtifacts(artifacts.items);
    } else {
      setResultArtifacts([]);
    }
    setActiveRunId(runId);
  }, [client, store]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      const [healthResult, runResult, datasetResult] = await Promise.all([
        client.health(),
        client.listRuns(),
        client.listDatasets(),
      ]);
      setHealth(healthResult);
      setRuns(runResult.items);
      setDatasets(datasetResult.items);
      const requested = typeof window === 'undefined'
        ? undefined
        : new URLSearchParams(window.location.search).get('run') ?? undefined;
      const runId = requested ?? activeRunId;
      if (runId) await loadRun(runId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeRunId, client, loadRun]);

  useEffect(() => {
    void refresh();
  }, []); // The client and store are stable for the lifetime of this workbench.

  const openRun = useCallback(async (runId: string) => {
    setLoading(true);
    setError(undefined);
    try {
      store.reset();
      await loadRun(runId);
      replaceWorkbenchUrl(runId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [loadRun, store]);

  const startNewProject = useCallback(() => {
    store.reset();
    setActiveRunId(undefined);
    setPendingMessages([]);
    setResultArtifacts([]);
    setError(undefined);
    replaceWorkbenchUrl();
  }, [store]);

  const deleteRun = useCallback(async (runId: string) => {
    if (deletingRunId) return;
    setDeletingRunId(runId);
    setError(undefined);
    try {
      await client.deleteRun(runId);
      setRuns((current) => current.filter((run) => run.runId !== runId));
      if (store.getSnapshot().view?.runId === runId) startNewProject();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDeletingRunId(undefined);
    }
  }, [client, deletingRunId, startNewProject, store]);

  const refreshActiveRun = useCallback(async () => {
    if (!activeRunId) return;
    await loadRun(activeRunId);
  }, [activeRunId, loadRun]);

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim();
    const view = store.getSnapshot().view;
    if (!view || !trimmed || commandBusy || !view.capabilities.canSendMessage) return;

    const clientMessageId = createClientId('message');
    setCommandBusy(true);
    setError(undefined);
    setPendingMessages((current) => [
      ...current,
      { clientMessageId, content: trimmed, createdAt: new Date().toISOString() },
    ]);
    try {
      const accepted = view.results?.status === 'available'
        ? await client.sendResultAnalysisMessage(view.runId, {
            clientMessageId,
            expectedRunRevision: view.revision,
            content: trimmed,
            artifactIds: resultArtifacts.map((artifact) => artifact.artifactId),
          })
        : await client.sendMessage(view.runId, {
        clientMessageId,
        expectedRunRevision: view.revision,
        content: trimmed,
        ...(view.checkpoint
          ? {
              checkpointContext: {
                checkpointId: view.checkpoint.checkpointId,
                revision: view.checkpoint.revision,
                contentHash: view.checkpoint.contentHash,
              },
            }
          : {}),
          });
      mergeAcceptedMessage(accepted.message, accepted.command);
      await refreshActiveRun();
    } catch (cause) {
      setPendingMessages((current) =>
        current.filter((pending) => pending.clientMessageId !== clientMessageId),
      );
      if (cause instanceof ThetaApiError && cause.isStaleRevision) await refreshActiveRun();
      setError(errorMessage(cause));
    } finally {
      setCommandBusy(false);
    }
  }, [client, commandBusy, mergeAcceptedMessage, refreshActiveRun, resultArtifacts, store]);

  const confirmCheckpoint = useCallback(async () => {
    const view = store.getSnapshot().view;
    const checkpoint = view?.checkpoint;
    if (
      !view ||
      !checkpoint ||
      commandBusy ||
      !(checkpoint.kind === 'plan'
        ? view.capabilities.canApprovePlan
        : view.capabilities.canConfirmCheckpoint) ||
      (checkpoint.kind === 'plan' && view.plan?.candidatePlanHash !== checkpoint.contentHash) ||
      !checkpoint.allowedActions.includes('confirm')
    ) return;

    setCommandBusy(true);
    setError(undefined);
    try {
      const receipt = await client.confirmCheckpoint(view.runId, checkpoint.checkpointId, {
        expectedRunRevision: view.revision,
        checkpointRevision: checkpoint.revision,
        contentHash: checkpoint.contentHash,
      });
      store.trackCommand(receipt.command);
      await refreshActiveRun();
    } catch (cause) {
      if (cause instanceof ThetaApiError && cause.descriptor.category === 'conflict') {
        await refreshActiveRun();
      }
      setError(errorMessage(cause));
    } finally {
      setCommandBusy(false);
    }
  }, [client, commandBusy, refreshActiveRun, store]);

  const createRun = useCallback(async ({ initialMessage, datasetRef }: { initialMessage: string; datasetRef?: string }) => {
    const dataset = datasets.find((item) =>
      item.availability === 'ready' && (!datasetRef || item.datasetRef === datasetRef),
    );
    if (!dataset) {
      setError('当前没有可用于启动对话的数据集。');
      return false;
    }
    setCommandBusy(true);
    setError(undefined);
    try {
      const accepted = await client.createRun({
        datasetRef: dataset.datasetRef,
        initialMessage: initialMessage.trim(),
      });
      store.reset();
      store.hydrateView(accepted.view);
      store.trackCommand(accepted.command);
      setActiveRunId(accepted.runId);
      setRuns((current) => {
        const summary: ThetaRunSummaryV3 = {
          runId: accepted.view.runId,
          revision: accepted.view.revision,
          lifecycle: accepted.view.lifecycle,
          phase: accepted.view.phase,
          updatedAt: accepted.view.updatedAt,
          title: initialMessage.trim().slice(0, 36) || accepted.view.dataset?.fileName,
          interaction: accepted.view.interaction,
        };
        return [summary, ...current.filter((run) => run.runId !== summary.runId)];
      });
      const messages = await client.listMessages(accepted.runId, { limit: 100 });
      store.mergeMessages(messages.items);
      replaceWorkbenchUrl(accepted.runId);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setCommandBusy(false);
    }
  }, [client, datasets, store]);

  const approveTraining = useCallback(async () => {
    const view = store.getSnapshot().view;
    const dryRunHash = view?.training?.dryRunHash;
    if (!view || !dryRunHash || commandBusy || !view.capabilities.canApproveTraining) return;
    setCommandBusy(true);
    setError(undefined);
    try {
      const receipt = await client.approveTraining(view.runId, {
        expectedRunRevision: view.revision,
        dryRunHash,
      });
      store.trackCommand(receipt.command);
      await refreshActiveRun();
    } catch (cause) {
      if (cause instanceof ThetaApiError && cause.descriptor.category === 'conflict') {
        await refreshActiveRun();
      }
      setError(errorMessage(cause));
    } finally {
      setCommandBusy(false);
    }
  }, [client, commandBusy, refreshActiveRun, store]);

  const executeRecovery = useCallback(async (actionId: string) => {
    const view = store.getSnapshot().view;
    if (!view?.failure || commandBusy) return;
    setCommandBusy(true);
    setError(undefined);
    try {
      const accepted = await client.executeRecoveryCommand(view.runId, {
        expectedRunRevision: view.revision,
        actionId,
      });
      store.trackCommand(accepted.command);
      await refreshActiveRun();
    } catch (cause) {
      if (cause instanceof ThetaApiError && cause.isStaleRevision) await refreshActiveRun();
      setError(errorMessage(cause));
    } finally {
      setCommandBusy(false);
    }
  }, [client, commandBusy, refreshActiveRun, store]);

  const eventStatus = useRunEvents({
    runId: activeRunId,
    store,
    onSnapshotRequired: refreshActiveRun,
  });

  return {
    health,
    datasets,
    resultArtifacts,
    runs,
    activeRunId,
    state,
    pendingMessages,
    loading,
    refreshing,
    commandBusy,
    deletingRunId,
    eventStatus,
    error,
    openRun,
    startNewProject,
    deleteRun,
    refresh,
    sendMessage,
    confirmCheckpoint,
    approveTraining,
    executeRecovery,
    createRun,
  };
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const replaceWorkbenchUrl = (runId?: string): void => {
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set('run', runId);
  else url.searchParams.delete('run');
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
};
