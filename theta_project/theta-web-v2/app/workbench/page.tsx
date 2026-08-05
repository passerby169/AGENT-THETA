'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ResultAnalysisAssistant } from './result-analysis-assistant';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import {
  ThetaAgentV2API,
  type ThetaDataset,
  type ThetaHealth,
  type ThetaModel,
  type ThetaPlan,
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

export default function WorkbenchPage() {
  const router = useRouter();
  const [health, setHealth] = useState<ThetaHealth>();
  const [runs, setRuns] = useState<ThetaRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeStatus, setActiveStatus] = useState<ThetaRunStatus>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);

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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4 sm:px-6">
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

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
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
                <p className="mt-2 text-sm text-slate-500">先完成最上方的下一步，再进入模型训练。</p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} title="刷新" className="h-9 w-9 rounded-md bg-white">
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
                <Button type="button" onClick={() => setShowCreate(true)} className="h-9 gap-2 rounded-md bg-blue-600 px-4 hover:bg-blue-700">
                  <Plus className="h-4 w-4" />新建研究
                </Button>
              </div>
            </section>

            <section className="mt-7">
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

      <CreateResearchDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={(status) => {
          setShowCreate(false);
          setActiveRunId(status.runId);
          setActiveStatus(status);
        }}
      />
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
  const [timeline, setTimeline] = useState<ThetaRunTimeline>();
  const [results, setResults] = useState<ThetaRunResults>();
  const [resultsLoading, setResultsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const actionInFlight = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const loadTimeline = useCallback(async (targetRunId: string) => {
    setTimeline(await ThetaAgentV2API.timeline(targetRunId));
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
    setResults(undefined);
    void loadTimeline(runId).catch((cause) => setActionError(errorMessage(cause)));
  }, [loadTimeline, runId]);

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

  const act = async (action: ThetaRunAction) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const result = await ThetaAgentV2API.act(runId, action);
      onStatusChange(result.status);
      setActionNotice(result.result.response ?? result.result.explanation);
      await loadTimeline(result.status.runId);
      if (
        action.action === 'adjustPlan' &&
        result.status.currentState === 'AwaitPlanCreationApproval'
      ) {
        await loadPlan(result.status.runId);
      }
    } catch (cause) {
      setActionError(errorMessage(cause));
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
        status?.currentState === 'Completed' ? loadResults(runId) : Promise.resolve(),
      ]);
    } catch (cause) {
      setActionError(`刷新运行状态失败：${errorMessage(cause)}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading || !status) return <LoadingBlock />;
  const presentation = status.presentation;
  const workflowProgress = presentation.progress
    ? Math.round((presentation.progress.current / presentation.progress.total) * 100)
    : 0;
  const trainingProgress = timeline?.training?.progress ?? status.trainingReceipt?.progress;
  const progress = monitoring && typeof trainingProgress === 'number'
    ? trainingProgress
    : workflowProgress;
  return (
    <div>
      <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-8 text-slate-500"><ArrowLeft className="mr-1.5 h-4 w-4" />返回任务列表</Button>
      <section className="mt-4 rounded-md border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0"><p className="text-xs font-medium text-blue-600">{run ? runSubtitle(run) : '研究任务'}</p><h1 className="mt-1 text-xl font-semibold sm:text-2xl">{run ? runLabel(run) : presentation.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{presentation.summary}</p></div>
          <Button type="button" variant="outline" size="icon" disabled={syncing} onClick={() => void refreshRun()} title="刷新状态" className="h-8 w-8 rounded-md"><RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /></Button>
        </div>
        <div className="mt-5 flex items-center gap-3"><Progress value={progress} className="h-2" /><span className="whitespace-nowrap text-xs text-slate-400">{monitoring ? `训练 ${Math.round(progress)}%` : `步骤 ${presentation.progress?.current ?? '-'} / ${presentation.progress?.total ?? 7}`}</span></div>
      </section>

      {actionError ? <ErrorNotice message={actionError} /> : null}
      {actionNotice ? <ActionNotice message={actionNotice} /> : null}
      <ActionPanel status={status} plan={plan} models={models} busy={busy} onAction={act} />

      {status.currentState === 'Completed' ? <RunResults runId={runId} results={results} loading={resultsLoading} /> : null}

      <RunActivity timeline={timeline} monitoring={monitoring} syncing={syncing} />

      <details className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:px-5"><span className="flex items-center gap-2"><Settings2 className="h-4 w-4" />技术执行记录</span><span className="text-xs font-normal text-slate-400">{status.eventCount} 个事件</span></summary>
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
  const selectionCount = selection.topicIds.length
    + selection.metricKeys.length
    + selection.visualizationIds.length
    + Number(selection.includeGoalAssessment)
    + Number(selection.includeWarnings);
  const selectAll = () => setSelection({
    topicIds: results.topics.slice(0, 12).map((topic) => topic.id),
    metricKeys: metricEntries.slice(0, 12).map(([key]) => key),
    visualizationIds: results.visualizations.slice(0, 12).map((item) => item.id),
    includeGoalAssessment: results.goalAssessment.length > 0,
    includeWarnings: results.warnings.length > 0,
  });
  return (
    <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
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
              <table className="w-full min-w-[650px] text-left">
                <thead><tr className="text-xs text-slate-400"><th className="w-10 py-3 font-medium">选择</th><th className="w-14 py-3 font-medium">编号</th><th className="w-40 py-3 font-medium">主题</th><th className="py-3 font-medium">核心关键词</th><th className="w-20 py-3 text-right font-medium">强度</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{results.topics.map((topic, index) => (
                  <tr key={topic.id} className={selection.topicIds.includes(topic.id) ? 'bg-blue-50/50 align-top' : 'align-top'}>
                    <td className="py-3"><Checkbox checked={selection.topicIds.includes(topic.id)} onCheckedChange={(checked) => setSelection((current) => ({ ...current, topicIds: updateSelection(current.topicIds, topic.id, checked === true, 12) }))} aria-label={`选择主题 ${topic.name}`} /></td>
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
    <ResultAnalysisAssistant runId={runId} selection={selection} selectionCount={selectionCount} />
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
  const [zoom, setZoom] = useState(100);
  useEffect(() => setZoom(100), [preview?.id]);
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
          {preview ? preview.format === 'interactive' ? <iframe title={preview.label} src={ThetaAgentV2API.resultAssetUrl(runId, preview.relativePath)} sandbox="allow-scripts" className="h-[72vh] w-full rounded-md border border-slate-200 bg-white" /> : <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50"><div className="flex h-10 items-center justify-center gap-1 border-b border-slate-200 bg-white"><Button type="button" variant="ghost" size="icon" title="缩小" disabled={zoom <= 50} onClick={() => setZoom((value) => Math.max(50, value - 25))} className="h-8 w-8"><ZoomOut className="h-4 w-4" /></Button><span className="w-14 text-center text-xs font-medium text-slate-600">{zoom}%</span><Button type="button" variant="ghost" size="icon" title="放大" disabled={zoom >= 300} onClick={() => setZoom((value) => Math.min(300, value + 25))} className="h-8 w-8"><ZoomIn className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" title="恢复原始视图" disabled={zoom === 100} onClick={() => setZoom(100)} className="ml-1 h-8 w-8"><RotateCcw className="h-4 w-4" /></Button></div><div className="grid h-[70vh] place-items-center overflow-auto p-3" onDoubleClick={() => setZoom((value) => value === 100 ? 200 : 100)}><img src={ThetaAgentV2API.resultAssetUrl(runId, preview.relativePath)} alt={preview.label} style={zoom === 100 ? undefined : { width: `${zoom}%`, maxWidth: 'none', maxHeight: 'none' }} className={zoom === 100 ? 'max-h-[66vh] max-w-full object-contain' : 'h-auto object-contain'} /></div></div> : null}
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

function ActionPanel({ status, plan, models, busy, onAction }: { status: ThetaRunStatus; plan?: ThetaPlan; models: ThetaModel[]; busy: boolean; onAction: (action: ThetaRunAction) => Promise<void> }) {
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
    await onAction({ action, text: text.trim() });
    setText('');
  };

  if (state === 'ResearchClarification') return (
    <ActionShell title="回答一个问题" description="THETA 只会继续询问仍缺少的必要信息。">
      <div className="rounded-md bg-blue-50 px-4 py-3 text-sm font-medium leading-6 text-blue-900">{status.pendingReason ?? '请补充当前研究设置。'}</div>
      <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="直接用自然语言回答" className="mt-3 min-h-24" />
      <div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={busy || !text.trim()} onClick={() => void submitText('answer')} className="bg-blue-600 hover:bg-blue-700">{busy ? '正在处理...' : '提交回答并继续'}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void onAction({ action: 'finishInterview' })}>信息已足够，开始分析</Button></div>
    </ActionShell>
  );

  if (state === 'ColumnConfirmation') return (
    <ActionShell title="确认数据列" description="说明正文、时间和 ID 列；不使用的角色可以写“无”。">
      <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：text 是正文列，timestamp 是时间列，id 是 ID 列，source 作为分组元数据" className="min-h-28" />
      <Button type="button" disabled={busy || !text.trim()} onClick={() => void submitText('columns')} className="mt-3 bg-blue-600 hover:bg-blue-700">{busy ? '正在校验...' : '确认列并生成模型建议'}</Button>
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

function CreateResearchDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (status: ThetaRunStatus) => void }) {
  const [datasets, setDatasets] = useState<ThetaDataset[]>([]);
  const [filePath, setFilePath] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    void ThetaAgentV2API.datasets().then(({ datasets: values }) => {
      setDatasets(values);
      setFilePath((current) => current || values[0]?.filePath || '');
    }).catch((cause) => setError(errorMessage(cause)));
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await ThetaAgentV2API.createRun({ filePath, researchGoal: goal.trim(), useMiniMax: true }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>新建研究</DialogTitle><DialogDescription>选择本地数据集并说明目标。THETA 会先确认研究信息和数据列，再推荐模型。</DialogDescription></DialogHeader>{error ? <ErrorNotice message={error} /> : null}<div className="space-y-4"><div><Label htmlFor="dataset">本地数据集</Label><select id="dataset" value={filePath} onChange={(event) => setFilePath(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm"><option value="">请选择数据集</option>{datasets.map((dataset) => <option key={dataset.filePath} value={dataset.filePath}>{dataset.name} · {formatBytes(dataset.sizeBytes)}</option>)}</select>{!datasets.length ? <p className="mt-1.5 text-xs text-amber-700">允许的数据目录中没有可用 CSV、TSV、JSON、JSONL 或 TXT 文件。</p> : null}</div><div><Label htmlFor="goal">研究目标</Label><Textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：识别主要主题，提取关键词和代表文本，并分析主题随时间的变化。" className="mt-1.5 min-h-28" /></div><Button type="button" onClick={() => void create()} disabled={busy || !filePath || goal.trim().length < 8} className="w-full bg-blue-600 hover:bg-blue-700">{busy ? '正在创建...' : '创建研究并进入设置'}</Button></div></DialogContent></Dialog>;
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
const formatDate = (value: string): string => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const formatTime = (value: string): string => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
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
