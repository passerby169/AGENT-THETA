'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Database,
  ExternalLink,
  Home,
  ImageIcon,
  MessageSquareText,
  Play,
  RefreshCw,
  Send,
  Settings2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ResultAnalysisAssistant } from './result-analysis-assistant';
import { ThetaOneWorkbench } from './theta-one-workbench';
import { ZoomableResultImage } from './zoomable-result-image';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ThetaAgentV2API,
  type ThetaDataset,
  type ThetaConversationMessage,
  type ThetaHealth,
  type ThetaModel,
  type ThetaPlan,
  type ThetaActionResult,
  type ThetaRunAction,
  type ThetaRunStatus,
  type ThetaRunSummary,
  type ThetaRunTimeline,
  type ThetaRunResults,
  type ThetaResultAnalysisSelection,
} from '@/lib/api/theta-agent-v2';

const actionableStates = new Set([
  'ResearchClarification',
  'ColumnConfirmation',
  'AwaitPlanCreationApproval',
  'AwaitTrainingStartApproval',
]);

const terminalStates = new Set(['Completed', 'Failed', 'Quarantined', 'Cancelled']);

interface RunActionOutcome {
  requestSucceeded: boolean;
  advanced: boolean;
  result?: ThetaActionResult;
}

interface OptimisticConversationMessage extends ThetaConversationMessage {
  baselineMatches: number;
  delivery: 'sending' | 'failed';
}

interface DisplayConversationMessage {
  message: ThetaConversationMessage;
  current?: boolean;
  delivery?: 'sending' | 'failed';
}

type WorkspaceMode = 'agent' | 'classic';

export default function WorkbenchPage() {
  const router = useRouter();
  const [health, setHealth] = useState<ThetaHealth>();
  const [runs, setRuns] = useState<ThetaRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeStatus, setActiveStatus] = useState<ThetaRunStatus>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [datasets, setDatasets] = useState<ThetaDataset[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetsError, setDatasetsError] = useState<string>();
  const [selectedDataset, setSelectedDataset] = useState('');
  const [researchGoal, setResearchGoal] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextHealth, runData] = await Promise.all([
        ThetaAgentV2API.health(),
        ThetaAgentV2API.runs(50),
      ]);
      setHealth(nextHealth);
      setRuns(runData.runs);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshDatasets = useCallback(async () => {
    setDatasetsLoading(true);
    setDatasetsError(undefined);
    try {
      const result = await ThetaAgentV2API.datasets();
      setDatasets(result.datasets);
      setSelectedDataset((current) =>
        result.datasets.some((dataset) => dataset.filePath === current)
          ? current
          : (result.datasets[0]?.filePath ?? ''),
      );
    } catch (cause) {
      setDatasetsError(errorMessage(cause));
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  const openRun = useCallback(async (runId: string) => {
    setActiveRunId(runId);
    setActiveStatus(undefined);
    setDetailLoading(true);
    setError(undefined);
    try {
      setActiveStatus(await ThetaAgentV2API.status(runId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestedRunId = new URLSearchParams(window.location.search).get('run');
    if (requestedRunId) void openRun(requestedRunId);
  }, [openRun]);

  const actionable = useMemo(
    () => runs.filter((run) => actionableStates.has(run.currentState ?? '')),
    [runs],
  );
  const active = useMemo(
    () => runs.filter((run) => isRunning(run)),
    [runs],
  );
  const history = useMemo(
    () => runs.filter((run) => !actionableStates.has(run.currentState ?? '') && !isRunning(run)),
    [runs],
  );

  const createResearch = useCallback(async () => {
    const goal = researchGoal.trim();
    if (!selectedDataset || goal.length < 8 || goal.length > 2000 || createBusy) return;
    setCreateBusy(true);
    setError(undefined);
    try {
      const status = await ThetaAgentV2API.createRun({
        filePath: selectedDataset,
        researchGoal: goal,
        useMiniMax: true,
      });
      const detailedStatus = await ThetaAgentV2API.status(status.runId);
      setActiveRunId(status.runId);
      setActiveStatus(detailedStatus);
      setResearchGoal('');
      void refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, refresh, researchGoal, selectedDataset]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1500px] items-center justify-between px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/theta-logo.png" alt="THETA" className="h-9 w-auto" />
            <span className="h-5 w-px bg-slate-200" />
            <div>
              <p className="text-sm font-semibold">研究训练工作台</p>
              <p className="hidden text-[11px] text-slate-400 sm:block">THETA 2.0 · Hypha Runtime</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <HealthBadge status={health?.status} />
            <Button type="button" variant="ghost" size="icon" onClick={() => router.push('/')} title="返回首页" className="h-8 w-8 rounded-md">
              <Home className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 sm:py-8">
        {error ? <ErrorNotice message={error} /> : null}
        {activeRunId ? (
          <RunWorkspace
            runId={activeRunId}
            run={runs.find((item) => item.runId === activeRunId)}
            status={activeStatus}
            loading={detailLoading}
            onBack={() => {
              setActiveRunId(undefined);
              setActiveStatus(undefined);
              void refresh();
            }}
            onStatusChange={(status) => {
              setActiveStatus(status);
              if (status.runId !== activeRunId) setActiveRunId(status.runId);
            }}
            onRefresh={() => openRun(activeRunId)}
          />
        ) : (
          <>
            <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-semibold text-blue-600">THETA 2.0</p>
                <h1 className="mt-1 text-2xl font-semibold">我的研究</h1>
                <p className="mt-2 text-sm text-slate-500">选择本地数据集，直接说明研究目标，再由 THETA 通过对话完善设置。</p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} title="刷新" className="h-9 w-9 rounded-md bg-white">
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </section>

            <ResearchStartPanel
              datasets={datasets}
              datasetsLoading={datasetsLoading}
              datasetsError={datasetsError}
              selectedDataset={selectedDataset}
              researchGoal={researchGoal}
              busy={createBusy}
              onDatasetChange={setSelectedDataset}
              onGoalChange={setResearchGoal}
              onRefreshDatasets={refreshDatasets}
              onCreate={createResearch}
            />

            <section className="mt-8">
              <SectionHeading title="现在需要你做" subtitle={actionable.length ? `${actionable.length} 个任务停在人工确认点` : '没有等待确认的任务'} />
              {loading ? <LoadingBlock /> : actionable.length ? (
                <div>
                  <NextTaskCard run={actionable[0]} primary onOpen={() => void openRun(actionable[0].runId)} />
                  {actionable.length > 1 ? (
                    <details className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-white">
                      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:px-5"><span>其他待确认任务</span><span className="text-xs font-normal text-slate-400">{actionable.length - 1} 个</span></summary>
                      <div className="border-t border-slate-100">{actionable.slice(1).map((run) => <RunRow key={run.runId} run={run} onOpen={() => void openRun(run.runId)} />)}</div>
                    </details>
                  ) : null}
                </div>
              ) : (
                <EmptyPanel title="暂无待确认步骤" description="可以新建研究，或等待正在训练的任务完成。" />
              )}
            </section>

            {active.length ? (
              <section className="mt-8">
                <SectionHeading title="正在运行" subtitle="这些任务不需要重复点击，刷新即可查看进度" />
                <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                  {active.map((run) => <RunRow key={run.runId} run={run} onOpen={() => void openRun(run.runId)} />)}
                </div>
              </section>
            ) : null}

            <section className="mt-8">
              <details className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 hover:bg-slate-50 sm:px-5">
                  <span><strong className="text-sm">历史与异常记录</strong><span className="ml-2 text-xs text-slate-400">{history.length} 个</span></span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </summary>
                <div className="border-t border-slate-100">
                  {history.length ? history.map((run) => <RunRow key={run.runId} run={run} onOpen={() => void openRun(run.runId)} />) : <EmptyPanel title="暂无历史记录" description="完成或失败的任务会保留在这里。" compact />}
                </div>
              </details>
            </section>

            <details className="mt-5 rounded-md border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
              <summary className="cursor-pointer font-medium text-slate-600">运行环境</summary>
              <p className="mt-2">{health?.checks.filter((check) => check.status === 'PASS').length ?? 0} 项通过，{health?.checks.filter((check) => check.status !== 'PASS').length ?? 0} 项提醒或阻塞。</p>
            </details>
          </>
        )}
      </main>
    </div>
  );
}

function NextTaskCard({ run, primary, onOpen }: { run: ThetaRunSummary; primary: boolean; onOpen: () => void }) {
  const presentation = run.presentation;
  const action = presentation?.nextActions.find((item) => item.recommended) ?? presentation?.nextActions[0];
  return (
    <button type="button" onClick={onOpen} className={`flex min-h-36 w-full flex-col justify-between rounded-md border p-5 text-left transition-colors ${primary ? 'border-blue-200 bg-blue-50/60 hover:bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
      <div>
        <div className="flex items-center justify-between gap-3"><Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">待确认</Badge><span className="text-xs text-slate-400">步骤 {presentation?.progress?.current ?? '-'} / {presentation?.progress?.total ?? 7}</span></div>
        <h2 className="mt-3 text-base font-semibold text-slate-900">{runLabel(run)}</h2>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-500">{run.pendingReason ?? presentation?.summary ?? '打开任务查看下一步。'}</p>
      </div>
      <span className="mt-4 flex items-center justify-between text-sm font-semibold text-blue-700"><span>{action?.label ?? '继续处理'}</span><ChevronRight className="h-4 w-4" /></span>
    </button>
  );
}

function RunRow({ run, onOpen }: { run: ThetaRunSummary; onOpen: () => void }) {
  const state = statusKind(run);
  return (
    <button type="button" onClick={onOpen} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-100 px-4 py-4 text-left last:border-b-0 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_150px_100px_20px] sm:px-5">
      <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{runLabel(run)}</p><p className="mt-1 truncate text-xs text-slate-400">{runSubtitle(run)}</p></div>
      <Badge variant="outline" className={state.tone}>{state.label}</Badge>
      <span className="hidden text-xs text-slate-400 sm:block">{formatDate(run.lastEventAt ?? run.updatedAt)}</span>
      <ChevronRight className="h-4 w-4 text-slate-300" />
    </button>
  );
}

function ResearchStartPanel({
  datasets,
  datasetsLoading,
  datasetsError,
  selectedDataset,
  researchGoal,
  busy,
  onDatasetChange,
  onGoalChange,
  onRefreshDatasets,
  onCreate,
}: {
  datasets: ThetaDataset[];
  datasetsLoading: boolean;
  datasetsError?: string;
  selectedDataset: string;
  researchGoal: string;
  busy: boolean;
  onDatasetChange: (filePath: string) => void;
  onGoalChange: (goal: string) => void;
  onRefreshDatasets: () => Promise<void>;
  onCreate: () => Promise<void>;
}) {
  const goal = researchGoal.trim();
  const selected = datasets.find((dataset) => dataset.filePath === selectedDataset);
  const datasetReady = Boolean(selected);
  const goalReady = goal.length >= 8 && goal.length <= 2000;
  const canCreate = datasetReady && goalReady && !busy;

  return (
    <section className="mt-7 overflow-hidden rounded-md border border-blue-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-slate-100 bg-blue-50/50 px-5 py-4 sm:px-6">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blue-600 text-white">
          <MessageSquareText className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-900">开始一项新研究</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">先选择要分析的数据集，再直接告诉我你希望研究什么。创建后，THETA 会在对话中补全必要信息。</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(280px,0.8fr)_minmax(420px,1.2fr)]">
        <div className="min-w-0 border-b border-slate-100 p-5 lg:border-b-0 lg:border-r sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-blue-600">1 / 2 · 选择数据集</p>
              <p className="mt-1 text-sm font-medium text-slate-800">允许目录中的本地文件</p>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => void onRefreshDatasets()} disabled={datasetsLoading} title="重新读取数据集" className="h-8 w-8 rounded-md">
              <RefreshCw className={`h-4 w-4 ${datasetsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {datasetsError ? (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">读取数据集失败：{datasetsError}</div>
          ) : datasetsLoading ? (
            <div className="mt-4 flex min-h-20 items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin text-blue-600" />正在读取 THETA 允许目录...</div>
          ) : datasets.length ? (
            <>
              <select value={selectedDataset} onChange={(event) => onDatasetChange(event.target.value)} className="mt-4 h-11 w-full min-w-0 max-w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                {datasets.map((dataset) => <option key={dataset.filePath} value={dataset.filePath}>{dataset.name} · {formatBytes(dataset.sizeBytes)}</option>)}
              </select>
              {selected ? (
                <div className="mt-3 rounded-md bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-700"><Database className="h-3.5 w-3.5 text-blue-600" />已选择 {selected.name}</div>
                  <p className="mt-1 max-w-full break-all font-mono text-[10px] leading-4 text-slate-400">{selected.filePath}</p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">没有找到可用数据集。请把 CSV、TSV、JSON、JSONL 或 TXT 文件放入 `THETA/data` 后重新读取。</div>
          )}
          <p className="mt-3 text-xs leading-5 text-slate-500">只读取 `theta-cli-agent/fixtures` 与 `THETA/data` 的文件列表，不会扫描整块磁盘，也不会在此步骤读取文件正文。</p>
        </div>

        <div className="min-w-0 p-5 sm:p-6">
          <div>
            <p className="text-xs font-semibold text-blue-600">2 / 2 · 说明研究目标</p>
            <p className="mt-1 text-sm font-medium text-slate-800">你希望从这批数据中得到什么？</p>
          </div>
          <div className="mt-4 rounded-md border border-slate-200 bg-white shadow-sm focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
            <Textarea
              value={researchGoal}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => onGoalChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !canCreate) return;
                event.preventDefault();
                void onCreate();
              }}
              placeholder="例如：识别主要主题，提取关键词和代表文本，并分析主题随时间的变化。"
              className="min-h-28 min-w-0 resize-none border-0 bg-transparent shadow-none [field-sizing:fixed] focus-visible:ring-0"
            />
            <div className="flex flex-col items-stretch gap-2 border-t border-slate-100 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <span className={`text-xs ${goal.length > 0 && !goalReady ? 'text-amber-700' : 'text-slate-400'}`}>{goal.length} / 2000 · 至少 8 个字符</span>
              <Button type="button" disabled={!canCreate} onClick={() => void onCreate()} className="h-9 w-full gap-2 rounded-md bg-blue-600 px-4 hover:bg-blue-700 sm:w-auto">
                {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {busy ? '正在预检数据...' : '开始研究对话'}
              </Button>
            </div>
          </div>
          {busy ? (
            <div className="mt-4 overflow-hidden rounded-md border border-blue-200 bg-blue-50/60 px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-blue-800">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                THETA 正在本地建立数据概况
              </div>
              <p className="mt-1 text-xs leading-5 text-blue-700">读取文件结构、识别候选数据列并生成第一版研究档案。原始文本不会在此阶段发送到外部服务。</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-blue-100">
                <div className="h-full w-2/5 animate-pulse rounded-full bg-blue-600" />
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
            <RequirementItem met={datasetReady}>已选择数据集</RequirementItem>
            <RequirementItem met={goalReady}>研究目标信息充分</RequirementItem>
          </div>
        </div>
      </div>
    </section>
  );
}

function RunWorkspace({ runId, run, status, loading, onBack, onRefresh, onStatusChange }: {
  runId: string;
  run?: ThetaRunSummary;
  status?: ThetaRunStatus;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onStatusChange: (status: ThetaRunStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [plan, setPlan] = useState<ThetaPlan>();
  const [models, setModels] = useState<ThetaModel[]>([]);
  const [conversation, setConversation] = useState<ThetaConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [timeline, setTimeline] = useState<ThetaRunTimeline>();
  const [results, setResults] = useState<ThetaRunResults>();
  const [resultsLoading, setResultsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('agent');
  const actionInFlight = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('mode');
    if (requested === 'agent' || requested === 'classic') {
      setWorkspaceMode(requested);
      window.localStorage.setItem('theta-workbench-mode', requested);
      return;
    }
    const stored = window.localStorage.getItem('theta-workbench-mode');
    if (stored === 'agent' || stored === 'classic') setWorkspaceMode(stored);
  }, []);

  const changeWorkspaceMode = (mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    window.localStorage.setItem('theta-workbench-mode', mode);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', mode);
    window.history.replaceState({}, '', url);
  };

  const loadTimeline = useCallback(async (targetRunId: string) => {
    setTimeline(await ThetaAgentV2API.timeline(targetRunId));
  }, []);

  const loadConversation = useCallback(async (targetRunId: string) => {
    setConversationLoading(true);
    try {
      const result = await ThetaAgentV2API.conversation(targetRunId);
      setConversation(result.messages);
    } finally {
      setConversationLoading(false);
    }
  }, []);

  const loadResults = useCallback(async (targetRunId: string) => {
    setResultsLoading(true);
    try {
      setResults(await ThetaAgentV2API.results(targetRunId));
    } finally {
      setResultsLoading(false);
    }
  }, []);

  useEffect(() => {
    setTimeline(undefined);
    setConversation([]);
    setResults(undefined);
    void loadTimeline(runId).catch((cause) => setActionError(errorMessage(cause)));
    void loadConversation(runId).catch((cause) => setActionError(errorMessage(cause)));
  }, [loadConversation, loadTimeline, runId]);

  useEffect(() => {
    if (status?.currentState !== 'Completed') {
      setResults(undefined);
      setResultsLoading(false);
      return;
    }
    void loadResults(runId).catch((cause) => setActionError(`读取分析结果失败：${errorMessage(cause)}`));
  }, [loadResults, runId, status?.currentState]);

  const loadPlan = useCallback(async (targetRunId: string) => {
    const [nextPlan, catalog] = await Promise.all([
      ThetaAgentV2API.plan(targetRunId),
      ThetaAgentV2API.models(),
    ]);
    setPlan(nextPlan);
    setModels(
      catalog.models.filter(
        (model) => model.runnable !== false && !model.experimental,
      ),
    );
  }, []);

  useEffect(() => {
    if (status?.currentState !== 'AwaitPlanCreationApproval') {
      setPlan(undefined);
      return;
    }
    void loadPlan(runId)
      .catch((cause) => setActionError(errorMessage(cause)));
  }, [loadPlan, runId, status?.currentState]);

  const act = async (action: ThetaRunAction): Promise<RunActionOutcome> => {
    if (actionInFlight.current) {
      return { requestSucceeded: false, advanced: false };
    }
    actionInFlight.current = true;
    setBusy(true);
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const result = await ThetaAgentV2API.act(runId, action);
      onStatusChange(result.status);
      const unresolved = result.result.kind === 'research.answer.unresolved';
      setActionNotice(
        result.result.response ??
        result.result.explanation ??
        (unresolved ? '当前回答未能解决这个问题，请根据提示补充后再次提交。' : undefined),
      );
      await Promise.all([
        loadTimeline(result.status.runId),
        loadConversation(result.status.runId),
      ]);
      if (
        action.action === 'adjustPlan' &&
        result.status.currentState === 'AwaitPlanCreationApproval'
      ) {
        await loadPlan(result.status.runId);
      }
      return {
        requestSucceeded: true,
        advanced: !unresolved,
        result: result.result,
      };
    } catch (cause) {
      setActionError(errorMessage(cause));
      return { requestSucceeded: false, advanced: false };
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  const monitoring = status?.currentState === 'MonitorTraining' || status?.currentState === 'StartTraining';
  useEffect(() => {
    if (!monitoring) {
      setSyncing(false);
      return;
    }
    let stopped = false;
    const poll = async () => {
      if (stopped || actionInFlight.current) return;
      actionInFlight.current = true;
      setSyncing(true);
      try {
        const result = await ThetaAgentV2API.act(runId, { action: 'poll' });
        if (stopped) return;
        onStatusChangeRef.current(result.status);
        await loadTimeline(result.status.runId);
        setActionError(undefined);
      } catch (cause) {
        if (!stopped) setActionError(`自动同步训练状态失败：${errorMessage(cause)}`);
      } finally {
        actionInFlight.current = false;
        setSyncing(false);
      }
    };
    const initial = window.setTimeout(() => void poll(), 600);
    const interval = window.setInterval(() => void poll(), 3_000);
    return () => {
      stopped = true;
      setSyncing(false);
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadTimeline, monitoring, runId]);

  const refreshRun = async () => {
    if (syncing) return;
    setSyncing(true);
    setActionError(undefined);
    try {
      await onRefresh();
      await Promise.all([
        loadTimeline(runId),
        loadConversation(runId),
        status?.currentState === 'Completed' ? loadResults(runId) : Promise.resolve(),
      ]);
    } catch (cause) {
      setActionError(`刷新运行状态失败：${errorMessage(cause)}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading || !status) return <LoadingBlock />;
  const actionPanel = <ActionPanel status={status} plan={plan} models={models} conversation={conversation} conversationLoading={conversationLoading} busy={busy} notice={actionNotice} compact={workspaceMode === 'classic'} onAction={act} />;
  const notices = (
    <>
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {actionNotice && !['ResearchClarification', 'ColumnConfirmation'].includes(status.currentState ?? '')
        ? <ActionNotice message={actionNotice} />
        : null}
    </>
  );
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-8 w-fit text-slate-500"><ArrowLeft className="mr-1.5 h-4 w-4" />返回任务列表</Button>
        <div className="relative grid w-full grid-cols-2 items-center overflow-hidden rounded-md border border-blue-200 bg-white p-1 shadow-sm sm:w-[260px]" aria-label="工作模式切换">
          <span aria-hidden="true" className={`absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded bg-blue-600 shadow-sm transition-transform duration-500 ease-in-out ${workspaceMode === 'classic' ? 'translate-x-full' : 'translate-x-0'}`} />
          <button type="button" aria-pressed={workspaceMode === 'agent'} onClick={() => changeWorkspaceMode('agent')} className={`relative z-10 flex min-h-9 items-center justify-center gap-2 rounded px-3 text-xs font-semibold transition-colors duration-300 ${workspaceMode === 'agent' ? 'text-white' : 'text-slate-600 hover:text-slate-900'}`}><MessageSquareText className="h-4 w-4" />二代 Agent</button>
          <button type="button" aria-pressed={workspaceMode === 'classic'} onClick={() => changeWorkspaceMode('classic')} className={`relative z-10 flex min-h-9 items-center justify-center gap-2 rounded px-3 text-xs font-semibold transition-colors duration-300 ${workspaceMode === 'classic' ? 'text-white' : 'text-slate-600 hover:text-slate-900'}`}><Database className="h-4 w-4" />一代工作台</button>
        </div>
      </div>
      <p className="mt-2 text-right text-[11px] text-slate-400">切换只改变操作界面；Run、FSM 进度、对话和训练结果保持同步。</p>
      {notices}
      <ThetaOneWorkbench
        run={run}
        status={status}
        timeline={timeline}
        plan={plan}
        results={results}
        resultsLoading={resultsLoading}
        assistant={actionPanel}
        assistantExpanded={workspaceMode === 'agent'}
      />

      {status.currentState === 'Completed' ? <RunResults runId={runId} results={results} loading={resultsLoading} /> : null}

      <RunActivity timeline={timeline} monitoring={monitoring} syncing={syncing} />

      <details className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:px-5"><span className="flex items-center gap-2"><Settings2 className="h-4 w-4" />技术执行记录</span><span className="text-xs font-normal text-slate-400">{Number.isFinite(status.eventCount) ? `${status.eventCount} 个事件` : '正在同步'}</span></summary>
        <ol className="border-t border-slate-100 px-4 py-3 sm:px-5">
          {uniquePath(status.statePath).map((state, index, states) => {
            const isLast = index === states.length - 1;
            const isCurrent = isLast && !terminalStates.has(status.currentState ?? '');
            const isProblem = isLast && ['Failed', 'Quarantined', 'Cancelled'].includes(state);
            const tone = isCurrent
              ? 'bg-blue-50 text-blue-600'
              : isProblem
                ? 'bg-amber-50 text-amber-700'
                : 'bg-emerald-50 text-emerald-600';
            return <li key={`${state}-${index}`} className="flex items-center gap-3 py-2 text-xs text-slate-500"><span className={`grid h-6 w-6 place-items-center rounded-full ${tone}`}>{isCurrent ? <CircleDot className="h-3.5 w-3.5" /> : isProblem ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}</span><span>{workflowStateLabel(state)}</span></li>;
          })}
        </ol>
      </details>
    </div>
  );
}

function RunResults({ runId, results, loading }: { runId: string; results?: ThetaRunResults; loading: boolean }) {
  const [selection, setSelection] = useState<ThetaResultAnalysisSelection>(emptyResultSelection());
  useEffect(() => {
    setSelection(emptyResultSelection());
  }, [runId]);

  if (loading) return (
    <section className="mt-5 rounded-md border border-slate-200 bg-white px-5 py-8 text-center">
      <RefreshCw className="mx-auto h-5 w-5 animate-spin text-blue-600" />
      <p className="mt-2 text-sm text-slate-500">正在整理训练结果...</p>
    </section>
  );
  if (!results) return null;

  const metricEntries = Object.entries(results.metrics)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 8);
  const selectionCount = selection.metricKeys.length
    + selection.visualizationIds.length
    + Number(selection.includeGoalAssessment)
    + Number(selection.includeWarnings);
  const selectedItems = [
    ...metricEntries
      .filter(([key]) => selection.metricKeys.includes(key))
      .map(([key, value]) => `指标：${metricLabel(key)} = ${formatResultValue(value)}`),
    ...results.visualizations
      .filter((item) => selection.visualizationIds.includes(item.id))
      .map((item) => `图表：${item.label}`),
    ...(selection.includeGoalAssessment ? ['研究目标核对'] : []),
    ...(selection.includeWarnings ? ['结果解读提醒'] : []),
  ];
  const selectedVisualizations = results.visualizations
    .filter((item) => selection.visualizationIds.includes(item.id))
    .map((item) => ({
      id: item.id,
      label: item.label,
      format: item.format,
      src: ThetaAgentV2API.resultAssetUrl(runId, item.relativePath),
    }));
  const allSelection: ThetaResultAnalysisSelection = {
    topicIds: [],
    metricKeys: metricEntries.slice(0, 12).map(([key]) => key),
    visualizationIds: results.visualizations.slice(0, 12).map((item) => item.id),
    includeGoalAssessment: results.goalAssessment.length > 0,
    includeWarnings: results.warnings.length > 0,
  };
  const allSelectedItems = [
    ...metricEntries.slice(0, 12).map(([key, value]) => `指标：${metricLabel(key)} = ${formatResultValue(value)}`),
    ...results.visualizations.slice(0, 12).map((item) => `图表：${item.label}`),
    ...(allSelection.includeGoalAssessment ? ['研究目标核对'] : []),
    ...(allSelection.includeWarnings ? ['结果解读提醒'] : []),
  ];
  const allSelectedVisualizations = results.visualizations.slice(0, 12).map((item) => ({
    id: item.id,
    label: item.label,
    format: item.format,
    src: ThetaAgentV2API.resultAssetUrl(runId, item.relativePath),
  }));
  const allSelectionCount = allSelection.metricKeys.length
    + allSelection.visualizationIds.length
    + Number(allSelection.includeGoalAssessment)
    + Number(allSelection.includeWarnings);
  const selectAll = () => setSelection(allSelection);
  const analysisSelection: ThetaResultAnalysisSelection = {
    ...selection,
    topicIds: [],
  };
  return (
    <div className="mt-5 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
    <section className="overflow-hidden rounded-md border border-emerald-200 bg-white">
      <div className="flex flex-col justify-between gap-3 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-start">
        <div>
          <p className="text-xs font-semibold text-emerald-700">本次训练输出</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">分析结果</h2>
          <p className="mt-1 text-sm text-slate-500">结果已从受治理的训练产物中读取，并绑定到当前研究任务。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={selectionCount ? () => setSelection(emptyResultSelection()) : selectAll} className="h-8 text-xs">
            {selectionCount ? `清除已选 ${selectionCount}` : '选择全部结果'}
          </Button>
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">训练完成</Badge>
          <Badge variant="outline" className={results.researchStatus === 'passed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}>{researchStatusLabel(results.researchStatus)}</Badge>
        </div>
      </div>

      <div className="grid border-b border-slate-100 sm:grid-cols-3">
        <ResultSummary label="识别主题" value={`${results.topics.length} 个`} />
        <ResultSummary label="执行状态" value={results.executionStatus ?? results.status} />
        <ResultSummary label="质量状态" value={results.qualityStatus ?? '尚未评估'} />
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="px-5 py-5">
          <h3 className="text-sm font-semibold text-slate-800">主题结果表</h3>
          <div className="mt-3 overflow-x-auto border-y border-slate-100">
            {results.topics.length ? (
              <table className="w-full min-w-[620px] text-left">
                <thead><tr className="text-xs text-slate-400"><th className="w-14 py-3 font-medium">编号</th><th className="w-40 py-3 font-medium">主题</th><th className="py-3 font-medium">核心关键词</th><th className="w-20 py-3 text-right font-medium">强度</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{results.topics.map((topic, index) => (
                  <tr key={topic.id} className="align-top">
                    <td className="py-3 text-xs font-semibold text-blue-700">{index + 1}</td>
                    <td className="py-3 pr-4 text-sm font-semibold text-slate-800">{topic.name}</td>
                    <td className="py-3 pr-4 text-xs leading-5 text-slate-500">{topic.keywords.length ? topic.keywords.slice(0, 10).join(' · ') : '暂无可展示关键词'}</td>
                    <td className="py-3 text-right text-xs text-slate-500">{typeof topic.strength === 'number' ? formatResultNumber(topic.strength) : '-'}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="py-6 text-sm text-slate-400">训练产物中未找到可解析的主题表。</p>}
          </div>
        </div>

        <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-5 lg:border-l lg:border-t-0">
          <h3 className="text-sm font-semibold text-slate-800">核心指标</h3>
          <dl className="mt-3 divide-y divide-slate-200">
            {metricEntries.length ? metricEntries.map(([key, value]) => (
              <div key={key} className={`flex items-center gap-3 py-2.5 ${selection.metricKeys.includes(key) ? 'bg-blue-50/50' : ''}`}>
                <Checkbox checked={selection.metricKeys.includes(key)} onCheckedChange={(checked) => setSelection((current) => ({ ...current, metricKeys: updateSelection(current.metricKeys, key, checked === true, 12) }))} aria-label={`选择指标 ${metricLabel(key)}`} />
                <dt className="min-w-0 flex-1 text-xs text-slate-500">{metricLabel(key)}</dt>
                <dd className="text-sm font-semibold text-slate-700">{formatResultValue(value)}</dd>
              </div>
            )) : <p className="py-4 text-xs text-slate-400">暂无可展示的聚合指标。</p>}
          </dl>
        </div>
      </div>

      <ResultVisualizations
        runId={runId}
        visualizations={results.visualizations}
        selectedIds={selection.visualizationIds}
        onSelectionChange={(id, checked) => setSelection((current) => ({
          ...current,
          visualizationIds: updateSelection(current.visualizationIds, id, checked, 12),
        }))}
      />

      {results.goalAssessment.length ? <div className={`border-t border-slate-100 px-5 py-5 ${selection.includeGoalAssessment ? 'bg-blue-50/40' : ''}`}><div className="flex items-center gap-2"><Checkbox checked={selection.includeGoalAssessment} onCheckedChange={(checked) => setSelection((current) => ({ ...current, includeGoalAssessment: checked === true }))} aria-label="选择研究目标核对" /><h3 className="text-sm font-semibold text-slate-800">研究目标核对</h3></div><div className="mt-3 space-y-3">{results.goalAssessment.map((item) => <div key={item.criterion} className="flex items-start gap-3"><CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${item.status === 'satisfied' ? 'text-emerald-600' : 'text-amber-600'}`} /><div><p className="text-sm font-medium text-slate-700">{item.criterion}</p><p className="mt-0.5 text-xs leading-5 text-slate-500">{item.evidence}</p></div></div>)}</div></div> : null}

      {results.warnings.length ? <div className="border-t border-amber-100 bg-amber-50 px-5 py-4"><div className="flex items-center gap-2"><Checkbox checked={selection.includeWarnings} onCheckedChange={(checked) => setSelection((current) => ({ ...current, includeWarnings: checked === true }))} aria-label="选择结果解读提醒" /><p className="text-xs font-semibold text-amber-800">结果解读提醒</p></div><ul className="mt-2 space-y-1 text-xs leading-5 text-amber-800">{results.warnings.slice(0, 4).map((warning) => <li key={warning}>• {warning}</li>)}</ul></div> : null}

      {results.resultRoot ? <details className="border-t border-slate-100 px-5 py-4"><summary className="cursor-pointer text-xs font-medium text-slate-500">查看本地结果目录</summary><p className="mt-2 break-all font-mono text-[11px] leading-5 text-slate-500">{results.resultRoot}</p></details> : null}
    </section>
    <ResultAnalysisAssistant
      runId={runId}
      selection={analysisSelection}
      selectionCount={selectionCount}
      selectedItems={selectedItems}
      selectedVisualizations={selectedVisualizations}
      allSelection={allSelection}
      allSelectionCount={allSelectionCount}
      allSelectedItems={allSelectedItems}
      allSelectedVisualizations={allSelectedVisualizations}
      onSelectAll={selectAll}
    />
    </div>
  );
}

function ResultSummary({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-slate-100 px-5 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-base font-semibold text-slate-800">{value}</p></div>;
}

const emptyResultSelection = (): ThetaResultAnalysisSelection => ({
  topicIds: [],
  metricKeys: [],
  visualizationIds: [],
  includeGoalAssessment: false,
  includeWarnings: false,
});

const updateSelection = (
  values: string[],
  value: string,
  checked: boolean,
  limit: number,
): string[] => {
  if (!checked) return values.filter((item) => item !== value);
  if (values.includes(value) || values.length >= limit) return values;
  return [...values, value];
};

function ResultVisualizations({ runId, visualizations, selectedIds, onSelectionChange }: {
  runId: string;
  visualizations: ThetaRunResults['visualizations'];
  selectedIds: string[];
  onSelectionChange: (id: string, checked: boolean) => void;
}) {
  const [preview, setPreview] = useState<ThetaRunResults['visualizations'][number]>();
  const globalImages = visualizations.filter((item) => item.scope === 'global' && item.format === 'image');
  const interactive = visualizations.filter((item) => item.format === 'interactive');
  const topicGroups = Object.entries(
    visualizations
      .filter((item) => item.scope === 'topic' && item.format === 'image')
      .reduce<Record<string, ThetaRunResults['visualizations']>>((groups, item) => {
        const topicId = item.topicId ?? 'unknown';
        (groups[topicId] ??= []).push(item);
        return groups;
      }, {}),
  ).sort(([left], [right]) => Number(left) - Number(right));
  if (!visualizations.length) return null;
  return (
    <div className="border-t border-slate-100 px-5 py-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div><h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ImageIcon className="h-4 w-4 text-blue-600" />可视化图表</h3><p className="mt-1 text-xs text-slate-500">点击查看并缩放原图；勾选图表时仅发送名称与类型，最多 12 项。</p></div>
        {interactive.map((item) => <div key={item.id} className="flex items-center gap-2"><Checkbox checked={selectedIds.includes(item.id)} onCheckedChange={(checked) => onSelectionChange(item.id, checked === true)} aria-label={`选择图表 ${item.label}`} /><button type="button" onClick={() => setPreview(item)} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100">打开交互式主题图<ExternalLink className="h-3.5 w-3.5" /></button></div>)}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {globalImages.map((item) => <VisualizationCard key={item.id} runId={runId} item={item} selected={selectedIds.includes(item.id)} onSelectionChange={(checked) => onSelectionChange(item.id, checked)} onOpen={() => setPreview(item)} />)}
      </div>
      {topicGroups.length ? <div className="mt-5 border-t border-slate-100 pt-4"><p className="text-xs font-semibold text-slate-600">各主题明细图</p><p className="mt-1 text-xs text-slate-400">按需展开词云、词语分布和主题演化图，避免一次加载全部图片。</p><div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">{topicGroups.map(([topicId, items]) => <TopicVisualizationGroup key={topicId} runId={runId} topicId={topicId} items={items} selectedIds={selectedIds} onSelectionChange={onSelectionChange} onPreview={setPreview} />)}</div></div> : null}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(undefined); }}>
        <DialogContent className="max-h-[94vh] overflow-hidden sm:max-w-6xl">
          <DialogHeader><DialogTitle>{preview?.label ?? '图表预览'}</DialogTitle><DialogDescription>按 Esc、点击右上角关闭按钮或点击遮罩即可退出预览。</DialogDescription></DialogHeader>
          {preview ? preview.format === 'interactive' ? <iframe title={preview.label} src={ThetaAgentV2API.resultAssetUrl(runId, preview.relativePath)} sandbox="allow-scripts" className="h-[72vh] w-full rounded-md border border-slate-200 bg-white" /> : <ZoomableResultImage src={ThetaAgentV2API.resultAssetUrl(runId, preview.relativePath)} alt={preview.label} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TopicVisualizationGroup({ runId, topicId, items, selectedIds, onSelectionChange, onPreview }: { runId: string; topicId: string; items: ThetaRunResults['visualizations']; selectedIds: string[]; onSelectionChange: (id: string, checked: boolean) => void; onPreview: (item: ThetaRunResults['visualizations'][number]) => void }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm font-medium text-slate-700"><span>主题 {topicId}</span><span className="text-xs font-normal text-slate-400">{items.length} 张图表</span></summary>{open ? <div className="grid gap-4 pb-4 md:grid-cols-2">{items.map((item) => <VisualizationCard key={item.id} runId={runId} item={item} selected={selectedIds.includes(item.id)} onSelectionChange={(checked) => onSelectionChange(item.id, checked)} onOpen={() => onPreview(item)} />)}</div> : null}</details>;
}

function VisualizationCard({ runId, item, selected, onSelectionChange, onOpen }: { runId: string; item: ThetaRunResults['visualizations'][number]; selected: boolean; onSelectionChange: (checked: boolean) => void; onOpen: () => void }) {
  const source = ThetaAgentV2API.resultAssetUrl(runId, item.relativePath);
  return <div className={`group overflow-hidden rounded-md border bg-white ${selected ? 'border-blue-300 ring-1 ring-blue-100' : 'border-slate-200'}`}><button type="button" onClick={onOpen} className="block w-full text-left"><div className="aspect-[4/3] bg-slate-50 p-2"><img src={source} alt={item.label} loading="lazy" className="h-full w-full object-contain" /></div></button><div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5"><Checkbox checked={selected} onCheckedChange={(checked) => onSelectionChange(checked === true)} aria-label={`选择图表 ${item.label}`} /><button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-700 hover:text-blue-700">{item.label}</button><span className="shrink-0 text-[11px] text-slate-400">{formatBytes(item.sizeBytes)}</span></div></div>;
}

function RunActivity({ timeline, monitoring, syncing }: { timeline?: ThetaRunTimeline; monitoring: boolean; syncing: boolean }) {
  const recent = [...(timeline?.timeline ?? [])].reverse().slice(0, 8);
  return (
    <section className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4 text-blue-600" />运行动态</h2><p className="mt-1 text-xs text-slate-400">训练进程、FSM 推进和受治理工具事件</p></div>
        {monitoring ? <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{syncing ? '正在同步' : '每 3 秒自动同步'}</Badge> : null}
      </div>
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
        <ol className="divide-y divide-slate-100 px-4 sm:px-5">
          {recent.length ? recent.map((event) => (
            <li key={`${event.source}-${event.id}`} className="flex gap-3 py-3">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.source === 'tool' ? 'bg-slate-400' : 'bg-blue-500'}`} />
              <div className="min-w-0 flex-1"><p className="truncate text-sm text-slate-700">{event.title}</p>{event.detail ? <p className="mt-0.5 truncate text-xs text-slate-400">{event.detail}</p> : null}</div>
              <time className="shrink-0 text-xs text-slate-400">{formatTime(event.timestamp)}</time>
            </li>
          )) : <li className="py-6 text-sm text-slate-400">正在读取运行事件...</li>}
        </ol>
        <div className="border-t border-slate-100 bg-slate-50/70 p-4 lg:border-l lg:border-t-0 sm:p-5">
          <p className="text-xs font-semibold text-slate-600">最近训练日志</p>
          <div className="mt-3 max-h-52 space-y-1 overflow-auto font-mono text-[11px] leading-5 text-slate-500">
            {timeline?.logs.length ? timeline.logs.map((line, index) => <p key={`${index}-${line}`} className="break-all">{line}</p>) : <p>暂无训练日志。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function ActionPanel({ status, plan, models, conversation, conversationLoading, busy, notice, compact = false, onAction }: { status: ThetaRunStatus; plan?: ThetaPlan; models: ThetaModel[]; conversation: ThetaConversationMessage[]; conversationLoading: boolean; busy: boolean; notice?: string; compact?: boolean; onAction: (action: ThetaRunAction) => Promise<RunActionOutcome> }) {
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [topics, setTopics] = useState('');
  const [acceptDegradation, setAcceptDegradation] = useState(false);

  useEffect(() => {
    if (!plan) return;
    const options = compatibleModels(plan, models);
    const currentModel = planModelId(plan);
    setModel(
      options.some((item) => item.id === currentModel)
        ? currentModel
        : (options[0]?.id ?? currentModel),
    );
    const count = planTopicCount(plan);
    setTopics(count === undefined || count === null ? '' : String(count));
  }, [models, plan]);

  const state = status.currentState;
  const submitText = async (action: 'answer' | 'columns') => {
    if (!text.trim()) return;
    const outcome = await onAction({ action, text: text.trim() });
    if (outcome.advanced) setText('');
  };

  if (state === 'ResearchClarification') return (
    <ResearchConversation
      status={status}
      messages={conversation}
      loading={conversationLoading}
      busy={busy}
      notice={notice}
      compact={compact}
      onAction={onAction}
    />
  );

  if (state === 'ColumnConfirmation') return (
    <ActionShell title="确认数据列" description="正文列必须确认；时间、ID 和元数据列不使用时可以明确写“无”。">
      <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-950">
        <p className="text-xs font-semibold text-blue-600">本步骤只确认列的用途</p>
        <p className="mt-1 font-medium">请使用数据文件中的真实列名。正文列用于模型训练，其余三类仅在研究需要时填写。</p>
      </div>
      <div className="mb-4 grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2">
        {[
          ['正文列（必填）', '每条记录中需要分析的完整文本，例如 text。'],
          ['时间列（可选）', '只有分析时间趋势时使用，例如 timestamp；否则写无。'],
          ['ID 列（可选）', '每条记录的唯一标识，例如 id；没有就写无。'],
          ['元数据列（可选）', '用于分组或描述的类别，例如 source；没有就写无。'],
        ].map(([label, description]) => (
          <div key={label} className="bg-white px-4 py-3">
            <p className="text-xs font-semibold text-slate-700">{label}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
          </div>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setText('正文列：text\n时间列：无\nID 列：无\n元数据列：无')}>填入仅正文模板</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setText('正文列：text\n时间列：timestamp\nID 列：id\n元数据列：source')}>填入时间趋势模板</Button>
      </div>
      <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={'正文列：text\n时间列：无\nID 列：无\n元数据列：无'} className="min-h-36" />
      <Button type="button" disabled={busy || !text.trim()} onClick={() => void submitText('columns')} className="mt-3 bg-blue-600 hover:bg-blue-700">{busy ? '正在校验...' : '确认列并生成模型建议'}</Button>
      {notice ? <ClarificationFeedback message={notice} /> : null}
    </ActionShell>
  );

  if (state === 'AwaitPlanCreationApproval') return (
    <ActionShell title="选择并确认训练方案" description="这是审批 1/2。批准后只固化方案，不会立即训练。">
      {!plan ? <p className="text-sm text-slate-500">正在读取模型方案...</p> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className="mb-1.5 block text-xs font-medium text-slate-600">训练模型</span><select value={model} onChange={(event) => setModel(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500">{compatibleModels(plan, models).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id.toUpperCase()})</option>)}</select></label>
            <label><span className="mb-1.5 block text-xs font-medium text-slate-600">主题数量</span><Input type="number" min={2} max={200} value={topics} onChange={(event) => setTopics(event.target.value)} /></label>
          </div>
          <div className="mt-4 rounded-md bg-slate-50 px-4 py-3"><p className="text-xs font-semibold text-slate-600">当前建议</p><p className="mt-1 text-sm text-slate-600">{plan.presentation.summary}</p></div>
          {plan.presentation.warnings?.length ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{plan.presentation.warnings[0]}</div> : null}
          <label className="mt-3 flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={acceptDegradation} onChange={(event) => setAcceptDegradation(event.target.checked)} className="mt-0.5" />我已阅读能力缺口，并在仍有警告时接受该降级方案。</label>
          <div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || !model || !topics || !planSettingsDirty(plan, model, topics)} onClick={() => void onAction({ action: 'adjustPlan', text: `将模型改为 ${model.toUpperCase()}，主题数改为 ${topics}` })}>{planSettingsDirty(plan, model, topics) ? '应用模型设置' : '设置已应用'}</Button><Button type="button" disabled={busy || !model || planSettingsDirty(plan, model, topics)} onClick={() => void onAction({ action: 'approvePlan', acceptDegradation })} className="bg-blue-600 hover:bg-blue-700">批准该方案</Button></div>
        </>
      )}
    </ActionShell>
  );

  if (state === 'AwaitTrainingStartApproval') return (
    <ActionShell title="确认启动真实训练" description="这是审批 2/2。点击后会启动本地 Python 进程并写入结果目录。">
      <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /><p className="text-sm text-emerald-800">方案已固化，数据准备和 dry-run 已通过。</p></div>
      <Button type="button" disabled={busy} onClick={() => void onAction({ action: 'startTraining' })} className="mt-4 gap-2 bg-blue-600 hover:bg-blue-700"><Play className="h-4 w-4" />{busy ? '正在启动...' : '批准并开始训练'}</Button>
    </ActionShell>
  );

  if (state === 'MonitorTraining' || state === 'StartTraining') {
    const receipt = status.trainingReceipt;
    const progress = typeof receipt?.progress === 'number' ? Math.round(receipt.progress) : 0;
    return <ActionShell title="训练正在后台运行" description="页面会自动推进耐久定时器并读取真实训练状态，不需要重复启动。"><div className="grid gap-3 sm:grid-cols-3"><Metric label="训练进度" value={`${progress}%`} /><Metric label="当前步骤" value={trainingStepLabel(receipt?.currentStep)} /><Metric label="训练 ID" value={receipt?.trainingRunId ?? '正在分配'} /></div></ActionShell>;
  }
  if (state === 'Failed') return <ActionShell title="运行未完成" description={status.presentation.summary}><p className="mb-3 text-sm text-slate-600">原任务会保持不变。系统将复用已确认的研究设置和数据列，创建一个新的恢复任务。</p><Button type="button" disabled={busy} onClick={() => void onAction({ action: 'retry' })} className="bg-blue-600 hover:bg-blue-700">{busy ? '正在创建恢复任务...' : '创建恢复任务'}</Button></ActionShell>;
  if (state === 'Quarantined') return <ActionShell title="该记录已隔离" description="该次运行的产物或状态不完整，系统不会擅自重启。请保留此记录并新建研究；技术原因可在下方记录中核对。"><p className="text-sm text-amber-700">这不是等待审批，因此不需要点击“开始训练”。</p></ActionShell>;
  if (state === 'Completed') return <ActionShell title="训练已完成" description="训练和产物校验已经结束。"><div className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />结果已通过校验并绑定到本次 Run。</div>{status.trainingReceipt?.resultArtifacts?.length ? <div className="mt-3 space-y-2">{status.trainingReceipt.resultArtifacts.filter((item) => item.exists).map((item) => <div key={item.path} className="rounded-md bg-slate-50 px-3 py-2"><p className="text-xs font-medium text-slate-600">{item.kind}</p><p className="mt-1 break-all font-mono text-[11px] text-slate-500">{item.path}</p></div>)}</div> : null}</ActionShell>;
  return <ActionShell title="系统正在处理" description="当前步骤无需人工输入。稍后刷新状态。"><RefreshCw className="h-5 w-5 animate-spin text-blue-600" /></ActionShell>;
}

function ResearchConversation({ status, messages, loading, busy, notice, compact = false, onAction }: {
  status: ThetaRunStatus;
  messages: ThetaConversationMessage[];
  loading: boolean;
  busy: boolean;
  notice?: string;
  compact?: boolean;
  onAction: (action: ThetaRunAction) => Promise<RunActionOutcome>;
}) {
  const [draft, setDraft] = useState('');
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticConversationMessage[]>([]);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const researchMessages = useMemo(
    () => messages.filter((message) =>
      message.messageKind.startsWith('research.') ||
      message.messageKind.startsWith('conversation.'),
    ),
    [messages],
  );
  const currentPrompt = status.pendingReason ?? '请继续说明你的研究目标和数据背景。';
  const showCurrentPrompt = !researchMessages.some(
    (message) => message.role === 'assistant' && message.content.includes(currentPrompt),
  );
  const displayMessages = useMemo<DisplayConversationMessage[]>(() => {
    const persisted = [...researchMessages]
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
      .map((message) => ({ message }));
    const latestSequence = persisted.reduce(
      (maximum, item) => Math.max(maximum, item.message.sequenceNumber),
      0,
    );
    const pendingPrompt: DisplayConversationMessage[] = showCurrentPrompt
      ? [{
          current: true,
          message: {
            messageId: `pending-${status.runId}-${currentPrompt}`,
            role: 'assistant',
            messageKind: 'research.question',
            content: currentPrompt,
            sequenceNumber: latestSequence + 1,
            createdAt: validIsoTimestamp(status.lastEventAt) ?? new Date().toISOString(),
          },
        }]
      : [];
    const pendingUserMessages = optimisticMessages.map((message, index) => ({
      message: {
        ...message,
        sequenceNumber: latestSequence + pendingPrompt.length + index + 1,
      },
      delivery: message.delivery,
    }));
    return [...persisted, ...pendingPrompt, ...pendingUserMessages];
  }, [currentPrompt, optimisticMessages, researchMessages, showCurrentPrompt, status.lastEventAt, status.runId]);
  const noticeAlreadyShown = notice
    ? researchMessages.some((message) => message.content.includes(notice))
    : false;

  useEffect(() => {
    setOptimisticMessages((pending) => pending.filter((message) => {
      const persistedMatches = researchMessages.filter(
        (candidate) => candidate.role === 'user' && candidate.content === message.content,
      ).length;
      return persistedMatches <= message.baselineMatches;
    }));
  }, [researchMessages]);

  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  }, [busy, currentPrompt, optimisticMessages.length, researchMessages.length]);

  const send = async () => {
    const answer = draft.trim();
    if (!answer || busy) return;
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const baselineMatches = researchMessages.filter(
      (message) => message.role === 'user' && message.content === answer,
    ).length;
    setDraft('');
    setOptimisticMessages((current) => [
      ...current,
      {
        messageId: optimisticId,
        role: 'user',
        messageKind: 'conversation.optimistic',
        content: answer,
        sequenceNumber: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(),
        baselineMatches,
        delivery: 'sending',
      },
    ]);
    const outcome = await onAction({ action: 'message', text: answer, useMiniMax: true });
    if (!outcome.requestSucceeded) {
      setOptimisticMessages((current) => current.map((message) =>
        message.messageId === optimisticId ? { ...message, delivery: 'failed' } : message,
      ));
    }
  };

  return (
    <section className="flex h-[calc(100dvh-12rem)] min-h-[560px] max-h-[820px] flex-col overflow-hidden rounded-md border border-blue-200 bg-white shadow-sm transition-[height,margin] duration-500 ease-in-out">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blue-600 text-white">
            <MessageSquareText className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">THETA 研究助手</h2>
            <p className={`mt-0.5 text-xs text-slate-500 ${compact ? 'line-clamp-2' : ''}`}>我会先自主检查数据并完成可确定的步骤，只在领域判断或审批点询问你。</p>
          </div>
        </div>
        <Badge variant="outline" className="w-fit border-blue-200 bg-blue-50 text-blue-700">Agent 对话进行中</Badge>
      </div>

      <div ref={scrollAreaRef} className={`min-h-0 flex-1 overscroll-contain overflow-y-auto bg-slate-50/60 ${compact ? 'space-y-3 px-3 py-4' : 'space-y-5 px-4 py-6 sm:px-6 sm:py-8'}`} aria-live="polite">
        {loading && researchMessages.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" />正在读取本次研究对话...</div>
        ) : null}
        {status.datasetProfile ? <DatasetProfileSummary status={status} compact={compact} /> : null}
        {displayMessages.map(({ message, current, delivery }) => (
          <ConversationBubble key={message.messageId} message={message} current={current} delivery={delivery} />
        ))}
        {notice && !noticeAlreadyShown ? (
          <div className="ml-11 max-w-3xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">{notice}</div>
        ) : null}
        {busy ? (
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="grid h-8 w-8 place-items-center rounded-md border border-blue-100 bg-white text-blue-600"><MessageSquareText className="h-4 w-4" /></span>
            <span className="flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5 animate-spin" />正在理解你的说明并核对研究档案...</span>
          </div>
        ) : null}
      </div>

      <div className={`shrink-0 border-t border-slate-100 bg-white ${compact ? 'p-3' : 'p-4 sm:p-5'}`}>
        <div className="rounded-md border border-slate-200 bg-white shadow-sm focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
          <Textarea
            id="research-answer"
            value={draft}
            maxLength={4000}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
            placeholder="回答研究问题，或直接询问 THETA 能力、模型、数据与当前步骤"
            className={`${compact ? 'min-h-20' : 'min-h-28'} min-w-0 resize-none border-0 bg-transparent shadow-none [field-sizing:fixed] focus-visible:ring-0`}
          />
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2">
            <span className="text-xs text-slate-400">{draft.length} / 4000</span>
            <Button type="button" size="icon" disabled={busy || !draft.trim()} onClick={() => void send()} title="发送说明" className="h-9 w-9 rounded-md bg-blue-600 hover:bg-blue-700">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className={`mt-3 flex flex-col gap-2 text-xs text-slate-500 ${compact ? '' : 'sm:flex-row sm:items-center sm:justify-between'}`}>
          <p className={compact ? 'text-[11px] leading-5' : ''}>THETA 会先判断你是在回答研究设置，还是在向助手咨询；只有研究答案会推进流程。</p>
          <div className="text-right">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onAction({ action: 'finishInterview' })} className="h-8 justify-start px-2 text-blue-700 hover:bg-blue-50 hover:text-blue-800">检查完整度并进入数据列确认</Button>
            <p className="mt-0.5 text-[11px] text-slate-400">若仍缺必填信息，系统会列出缺项，不会错误跳过。</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DatasetProfileSummary({ status, compact }: { status: ThetaRunStatus; compact: boolean }) {
  const profile = status.datasetProfile;
  if (!profile) return null;
  const primaryText = profile.columnCandidates.text[0]?.name;
  const primaryTime = profile.columnCandidates.time[0]?.name;
  const visibleColumns = profile.columns.slice(0, compact ? 4 : 8);
  const hiddenColumns = Math.max(0, profile.columns.length - visibleColumns.length);
  return (
    <div className="rounded-md border border-blue-200 bg-white px-4 py-3 shadow-sm sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-blue-700">已完成本地数据预检</p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            当前数据共 {profile.rowCount} 行、{profile.columnCount} 列，主要列为 {visibleColumns.length ? visibleColumns.join('、') : '尚未识别'}{hiddenColumns ? ` 等 ${profile.columnCount} 列` : ''}。
          </p>
        </div>
        <Badge variant="outline" className="w-fit shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700">原始文本未外传</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
        <span className="rounded-sm bg-slate-100 px-2 py-1">格式：{profile.format.toUpperCase()}</span>
        <span className="rounded-sm bg-slate-100 px-2 py-1">正文候选：{primaryText ?? '需要确认'}</span>
        <span className="rounded-sm bg-slate-100 px-2 py-1">时间候选：{primaryTime ?? '未识别'}</span>
        <span className="rounded-sm bg-blue-50 px-2 py-1 text-blue-700">领域预判：{profile.inferredDomain?.label ?? '通用文本分析'}</span>
        <span className="rounded-sm bg-slate-100 px-2 py-1">缺失率：{Math.round(profile.missingRatio * 100)}%</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">THETA 已依据结构和样本统计建立初步判断；后续只会询问无法可靠推断的领域含义与必要授权。</p>
    </div>
  );
}

function ConversationBubble({ message, current = false, delivery }: { message: ThetaConversationMessage; current?: boolean; delivery?: 'sending' | 'failed' }) {
  const isUser = message.role === 'user';
  const isAttachedNote = !isUser && message.messageKind === 'research.note';
  if (isAttachedNote) {
    return (
      <div className="-mt-3 ml-11 max-w-[76%] rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">
        <p className="font-semibold text-slate-500">研究档案记录</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    );
  }
  const assistantLabel = current
    ? '当前需要确认'
    : message.messageKind === 'research.progress'
      ? '已更新研究设置并调整下一问'
      : message.messageKind === 'research.clarification'
        ? '需要补充后再继续'
      : message.messageKind === 'research.interview.completed'
          ? '研究设置已完成'
          : message.messageKind === 'conversation.response'
            ? 'THETA 助手回复'
          : undefined;
  return (
    <div className={`flex items-end gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser ? <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-blue-100 bg-white text-blue-600"><MessageSquareText className="h-4 w-4" /></span> : null}
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? 'text-right' : 'text-left'}`}>
        <div className={`inline-block rounded-md px-4 py-3 text-left text-sm leading-6 shadow-sm ${isUser ? 'bg-blue-600 text-white' : current ? 'border border-blue-200 bg-blue-50 text-slate-900' : 'border border-slate-200 bg-white text-slate-700'}`}>
          {!isUser && assistantLabel ? <p className="mb-1 text-[11px] font-semibold text-blue-600">{assistantLabel}</p> : null}
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <AssistantMessageContent content={message.content} />
          )}
        </div>
        <p className={`mt-1 text-[11px] ${delivery === 'failed' ? 'text-red-500' : 'text-slate-400'} ${isUser ? 'text-right' : 'text-left'}`}>{isUser ? '你' : 'THETA'} · {delivery === 'sending' ? '发送中' : delivery === 'failed' ? '发送失败，请重试' : formatTime(message.createdAt)}</p>
      </div>
    </div>
  );
}

function AssistantMessageContent({ content }: { content: string }) {
  const normalized = content
    .replace(/\s+(?=\d+\.\s+(?:\*\*|[\p{L}\p{N}]))/gu, '\n')
    .replace(/\s+(?=\*\s+\S)/gu, '\n')
    .replace(/([。！？；])\s+(?=\*\*[^*]+\*\*[：:])/gu, '$1\n\n');

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        p: ({ children }) => <p className="mb-2 whitespace-pre-wrap break-words last:mb-0">{children}</p>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        em: ({ children }) => <em className="italic text-slate-800">{children}</em>,
        code: ({ children }) => <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.9em]">{children}</code>,
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}

function RequirementItem({ met, children }: { met: boolean; children: React.ReactNode }) {
  return <li className="flex items-start gap-2"><CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${met ? 'text-emerald-600' : 'text-slate-300'}`} /><span className={met ? 'text-slate-700' : undefined}>{children}</span></li>;
}

function ClarificationFeedback({ message }: { message: string }) {
  const isError = /失败|错误|异常|无效|拒绝/.test(message);
  const isSuccess = /已记录|已确认|成功|已完成/.test(message) && !isError;
  const tone = isError
    ? { title: '处理失败', classes: 'border-red-200 bg-red-50 text-red-800' }
    : isSuccess
      ? { title: '上一步已记录', classes: 'border-emerald-200 bg-emerald-50 text-emerald-800' }
      : { title: '需要补充或确认', classes: 'border-amber-200 bg-amber-50 text-amber-800' };
  return <div className={`mt-4 rounded-md border px-4 py-3 text-sm leading-6 ${tone.classes}`}><p className="font-semibold">{tone.title}</p><p className="mt-0.5">{message}</p></div>;
}

function ActionShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="mt-5 rounded-md border border-blue-200 bg-white p-5 sm:p-6"><div className="mb-4"><p className="text-xs font-semibold text-blue-600">你的下一步</p><h2 className="mt-1 text-lg font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-slate-500">{description}</p></div>{children}</section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md bg-slate-50 px-4 py-3"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 truncate text-sm font-semibold text-slate-700" title={value}>{value}</p></div>;
}

const SectionHeading = ({ title, subtitle }: { title: string; subtitle: string }) => <div className="mb-3 flex items-end justify-between gap-4"><div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-xs text-slate-400">{subtitle}</p></div></div>;
const EmptyPanel = ({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) => <div className={`rounded-md border border-dashed border-slate-200 bg-white text-center ${compact ? 'px-4 py-8' : 'px-4 py-12'}`}><Database className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-2 text-sm font-medium text-slate-600">{title}</p><p className="mt-1 text-xs text-slate-400">{description}</p></div>;
const LoadingBlock = () => <div className="grid min-h-44 place-items-center rounded-md border border-slate-200 bg-white"><div className="text-center"><RefreshCw className="mx-auto h-5 w-5 animate-spin text-blue-600" /><p className="mt-2 text-sm text-slate-500">正在读取事件状态...</p></div></div>;
const ErrorNotice = ({ message }: { message: string }) => <div className="my-5 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /><span>{message}</span></div>;
const ActionNotice = ({ message }: { message: string }) => <div className="my-5 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"><CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /><span>{message}</span></div>;
function HealthBadge({ status }: { status?: ThetaHealth['status'] }) { const label = status === 'ready' ? '环境正常' : status === 'degraded' ? '有提醒' : status === 'blocked' ? '环境阻塞' : '检查中'; const tone = status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status === 'degraded' ? 'border-amber-200 bg-amber-50 text-amber-700' : status === 'blocked' ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-500'; return <Badge variant="outline" className={tone}>{label}</Badge>; }

const statusKind = (run: ThetaRunSummary): { label: string; tone: string } => actionableStates.has(run.currentState ?? '') ? { label: '待确认', tone: 'border-amber-200 bg-amber-50 text-amber-700' } : isRunning(run) ? { label: '运行中', tone: 'border-blue-200 bg-blue-50 text-blue-700' } : run.currentState === 'Completed' ? { label: '已完成', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' } : { label: '需检查', tone: 'border-red-200 bg-red-50 text-red-700' };
const isRunning = (run: ThetaRunSummary): boolean => ['StartTraining', 'MonitorTraining'].includes(run.currentState ?? '') || run.status === 'waiting_timer';
const workflowStateLabels: Record<string, string> = {
  Intake: '接收研究任务',
  ResearchClarification: '完善研究设置',
  InspectDataset: '检查数据集',
  ColumnConfirmation: '确认数据列',
  RecommendModel: '生成模型建议',
  ValidatePlan: '校验训练方案',
  AwaitPlanCreationApproval: '等待方案审批',
  CreatePlan: '固化训练方案',
  DryRun: '训练前检查',
  AwaitTrainingStartApproval: '等待启动审批',
  VerifyDatasetBeforeTraining: '训练前复核数据',
  StartTraining: '启动模型训练',
  MonitorTraining: '跟踪训练进度',
  Completed: '训练完成',
  Failed: '运行失败',
  Quarantined: '运行已隔离',
  Cancelled: '训练已取消',
};
const workflowStateLabel = (state?: string): string => workflowStateLabels[state ?? ''] ?? state ?? '处理研究任务';
const stateTitle = (state?: string): string => workflowStateLabel(state);
const researchStatusLabel = (status?: ThetaRunResults['researchStatus']): string => status === 'passed' ? '研究目标已满足' : status === 'needs_review' ? '结果需要复核' : '研究目标未评估';
const metricLabels: Record<string, string> = {
  td: '主题多样性',
  topic_diversity: '主题多样性',
  irbo: '主题区分度',
  npmi: 'NPMI 一致性',
  c_v: 'C_V 一致性',
  umass: 'UMass 一致性',
  coherence: '主题一致性',
  perplexity: '困惑度',
  ppl: '困惑度',
  exclusivity: '主题独占性',
  model_name: '训练模型',
};
const metricLabel = (key: string): string => metricLabels[key.toLowerCase()] ?? key.replaceAll('_', ' ');
const formatResultNumber = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '');
const formatResultValue = (value: unknown): string => typeof value === 'number' ? formatResultNumber(value) : typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
const runLabel = (run: ThetaRunSummary): string => run.identity?.displayName ?? (run.runId.startsWith('theta-stage-') ? `阶段验证 · ${run.runId.replace('theta-stage-', '').replaceAll('-', ' ')}` : '未命名研究任务');
const runSubtitle = (run: ThetaRunSummary): string => [
  run.recoveryOfRunId ? '恢复任务' : undefined,
  run.identity?.modelId?.toUpperCase(),
  typeof run.identity?.numTopics === 'number' ? `${run.identity.numTopics} 个主题` : undefined,
  stateTitle(run.currentState),
].filter(Boolean).join(' · ');
const planCandidate = (plan: ThetaPlan) => plan.validatedPlan ?? plan.candidatePlan;
const planModelId = (plan: ThetaPlan): string => planCandidate(plan)?.modelId?.toLowerCase() ?? '';
const planTopicCount = (plan: ThetaPlan): number | null | undefined => {
  const candidate = planCandidate(plan);
  return candidate?.numTopics ?? candidate?.parameters?.numTopics;
};
const compatibleModels = (plan: ThetaPlan, catalog: ThetaModel[]): ThetaModel[] => {
  const recommended = plan.recommendation?.recommendations ?? [];
  return recommended.map((item) =>
    catalog.find((model) => model.id.toLowerCase() === item.modelId.toLowerCase()) ?? {
      id: item.modelId.toLowerCase(),
      name: item.modelName ?? item.modelId.toUpperCase(),
      type: 'topic-model',
    },
  );
};
const planSettingsDirty = (plan: ThetaPlan, model: string, topics: string): boolean => {
  if (model.toLowerCase() !== planModelId(plan)) return true;
  const currentTopics = planTopicCount(plan);
  if (currentTopics === null) return topics.trim() !== '';
  if (currentTopics === undefined) return topics.trim() !== '';
  return Number(topics) !== currentTopics;
};
const uniquePath = (path: string[]): string[] => path.filter((state, index) => index === 0 || path[index - 1] !== state);
const validDate = (value?: string): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const validIsoTimestamp = (value?: string): string | undefined => validDate(value)?.toISOString();
const formatDate = (value?: string): string => {
  const date = validDate(value);
  return date
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
    : '时间未知';
};
const formatTime = (value?: string): string => {
  const date = validDate(value);
  return date
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
    : '刚刚';
};
const formatBytes = (value: number): string => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const trainingStepLabel = (step?: string): string => ({
  prepare_data: '准备数据',
  data_prepared: '数据准备完成',
  train_model: '训练模型',
  evaluate_model: '评估模型',
  generate_visualizations: '生成可视化',
  verify_visualizations: '校验可视化',
  bind_results: '绑定结果',
  completed: '训练完成',
} as Record<string, string>)[step ?? ''] ?? step ?? '等待训练进程';
