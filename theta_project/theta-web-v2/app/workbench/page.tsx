'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Database,
  Home,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ThetaAgentV2API,
  type ThetaHealth,
  type ThetaRunStatus,
  type ThetaRunSummary,
} from '@/lib/api/theta-agent-v2';

type RunFilter = 'all' | 'attention' | 'active' | 'completed';

export default function WorkbenchPage() {
  const router = useRouter();
  const [health, setHealth] = useState<ThetaHealth>();
  const [runs, setRuns] = useState<ThetaRunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeStatus, setActiveStatus] = useState<ThetaRunStatus>();
  const [filter, setFilter] = useState<RunFilter>('all');
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showCreateNotice, setShowCreateNotice] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextHealth, runData] = await Promise.all([
        ThetaAgentV2API.health(),
        ThetaAgentV2API.runs(),
      ]);
      setHealth(nextHealth);
      setRuns(runData.runs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const counts = useMemo(() => ({
    all: runs.length,
    attention: runs.filter(needsAttention).length,
    active: runs.filter(isActive).length,
    completed: runs.filter(isCompleted).length,
  }), [runs]);

  const filteredRuns = useMemo(() => {
    const search = query.trim().toLowerCase();
    return runs.filter((run) => {
      const filterMatch = filter === 'all'
        || (filter === 'attention' && needsAttention(run))
        || (filter === 'active' && isActive(run))
        || (filter === 'completed' && isCompleted(run));
      const searchMatch = !search
        || run.runId.toLowerCase().includes(search)
        || runLabel(run).toLowerCase().includes(search)
        || (run.currentState ?? '').toLowerCase().includes(search);
      return filterMatch && searchMatch;
    });
  }, [filter, query, runs]);

  const visibleRuns = showAll ? filteredRuns : filteredRuns.slice(0, 7);

  return (
    <div className="min-h-screen w-full max-w-[100vw] bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/theta-logo.png" alt="THETA" className="h-9 w-auto flex-shrink-0" />
            <span className="hidden h-5 w-px bg-slate-200 sm:block" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-800">研究训练工作台</p>
              <p className="hidden text-[11px] text-slate-400 sm:block">Hypha Event-first Runtime</p>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => router.push('/')} title="返回首页" className="h-8 w-8 rounded-lg sm:hidden">
              <Home className="h-4 w-4" />
            </Button>
          </div>
          <div className="hidden flex-shrink-0 items-center gap-2 sm:flex">
            <HealthBadge status={health?.status} />
            <Button type="button" variant="ghost" size="icon" onClick={() => router.push('/')} title="返回首页" className="h-8 w-8 rounded-lg">
              <Home className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {error ? <ErrorNotice message={error} /> : null}
        {activeRunId ? (
          <RunWorkspace
            runId={activeRunId}
            status={activeStatus}
            loading={detailLoading}
            onBack={() => {
              setActiveRunId(undefined);
              setActiveStatus(undefined);
            }}
            onRefresh={() => void openRun(activeRunId)}
          />
        ) : (
          <>
            <section className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-medium text-blue-600">THETA 2.0</p>
                <h1 className="mt-1 text-2xl font-semibold text-slate-900">研究任务</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                  从事件记录查看任务进度；需要审批、恢复或确认的任务会优先显示。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} title="刷新运行数据" className="h-9 w-9 rounded-lg bg-white">
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
                <Button type="button" onClick={() => setShowCreateNotice(true)} className="h-9 gap-2 rounded-lg bg-blue-600 px-4 hover:bg-blue-700">
                  <Plus className="h-4 w-4" />开始新研究
                </Button>
              </div>
            </section>

            {counts.attention > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setFilter('attention');
                  setShowAll(true);
                }}
                className="mb-6 flex w-full items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100/70"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <AlertCircle className="h-5 w-5 flex-shrink-0 text-amber-600" />
                  <span>
                    <strong className="block text-sm text-amber-900">{counts.attention} 个任务需要处理</strong>
                    <span className="mt-0.5 block text-xs text-amber-700">查看隔离原因、失败信息或待确认步骤。</span>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 flex-shrink-0 text-amber-600" />
              </button>
            ) : null}

            <RunMetrics counts={counts} loading={loading} />

            <section className="mt-8">
              <div className="mb-4 flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                <div>
                  <h2 className="text-base font-semibold text-slate-800">运行记录</h2>
                  <p className="mt-1 text-xs text-slate-400">按最后事件时间排序</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex items-center overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
                    <FilterButton active={filter === 'all'} onClick={() => setFilter('all')} label="全部" count={counts.all} />
                    <FilterButton active={filter === 'attention'} onClick={() => setFilter('attention')} label="待处理" count={counts.attention} />
                    <FilterButton active={filter === 'active'} onClick={() => setFilter('active')} label="进行中" count={counts.active} />
                    <FilterButton active={filter === 'completed'} onClick={() => setFilter('completed')} label="已完成" count={counts.completed} />
                  </div>
                  <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 sm:w-64">
                    <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或状态" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400" />
                  </label>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                {loading ? <LoadingRows /> : null}
                {!loading && visibleRuns.length === 0 ? <EmptyRuns filtered={runs.length > 0} /> : null}
                {!loading ? visibleRuns.map((run) => <RunRow key={run.runId} run={run} onOpen={() => void openRun(run.runId)} />) : null}
              </div>

              {!loading && filteredRuns.length > 7 ? (
                <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-3 w-full py-2 text-sm font-medium text-blue-600 hover:text-blue-700">
                  {showAll ? '收起历史任务' : `展开其余 ${filteredRuns.length - 7} 个任务`}
                </button>
              ) : null}
            </section>

            <EnvironmentPanel health={health} />
          </>
        )}
      </main>

      <Dialog open={showCreateNotice} onOpenChange={setShowCreateNotice}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新研究入口正在接入</DialogTitle>
            <DialogDescription>当前工作台已读取真实 Run 与 FSM 状态。下一阶段会在此接入数据选择、研究设置、列确认和两阶段审批。</DialogDescription>
          </DialogHeader>
          <Button type="button" onClick={() => setShowCreateNotice(false)} className="w-full bg-blue-600 hover:bg-blue-700">知道了</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunMetrics({ counts, loading }: { counts: Record<RunFilter, number>; loading: boolean }) {
  const metrics = [
    { label: '全部任务', value: counts.all, tone: 'text-slate-900' },
    { label: '需要处理', value: counts.attention, tone: 'text-amber-700' },
    { label: '进行中', value: counts.active, tone: 'text-blue-700' },
    { label: '已完成', value: counts.completed, tone: 'text-emerald-700' },
  ];
  return (
    <section className="grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="border-b border-r border-slate-100 px-4 py-4 last:border-r-0 sm:border-b-0 sm:px-5">
          <p className="text-xs text-slate-400">{metric.label}</p>
          <p className={`mt-2 text-2xl font-semibold ${metric.tone}`}>{loading ? '-' : metric.value}</p>
        </div>
      ))}
    </section>
  );
}

function RunRow({ run, onOpen }: { run: ThetaRunSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-100 px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-slate-50 sm:grid-cols-[minmax(0,1.6fr)_minmax(130px,0.7fr)_100px_90px_20px] sm:px-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><StatusDot run={run} /><p className="truncate text-sm font-semibold text-slate-800">{runLabel(run)}</p></div>
        <p className="mt-1 truncate pl-5 text-xs text-slate-400" title={run.runId}>{run.runId}</p>
      </div>
      <div className="hidden min-w-0 sm:block"><RunStatusBadge run={run} /><p className="mt-1 truncate text-xs text-slate-400">{run.currentState ?? '等待状态'}</p></div>
      <div className="hidden sm:block"><p className="text-sm text-slate-600">{run.eventCount}</p><p className="mt-1 text-xs text-slate-400">事件</p></div>
      <div className="hidden sm:block"><p className="text-xs text-slate-600">{formatDate(run.lastEventAt ?? run.updatedAt)}</p><p className="mt-1 text-xs text-slate-400">最后更新</p></div>
      <div className="flex items-center gap-2 sm:block"><span className="sm:hidden"><RunStatusBadge run={run} /></span><ChevronRight className="h-4 w-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-500" /></div>
    </button>
  );
}

function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" onClick={onClick} className={`h-7 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors ${active ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>{label}<span className="ml-1 text-[10px] opacity-70">{count}</span></button>;
}

function EnvironmentPanel({ health }: { health?: ThetaHealth }) {
  const checks = health?.checks ?? [];
  const passing = checks.filter((check) => check.status === 'PASS').length;
  const warnings = checks.filter((check) => check.status === 'WARN').length;
  const failures = checks.filter((check) => check.status === 'FAIL').length;
  return (
    <details className="mt-8 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50 sm:px-5">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><ShieldCheck className="h-4 w-4 text-blue-600" />运行保障</span>
        <span className="text-xs text-slate-400">{passing} 通过 · {warnings} 提醒 · {failures} 阻塞</span>
      </summary>
      <div className="grid gap-2 border-t border-slate-100 px-4 py-4 sm:px-5 md:grid-cols-2">
        {checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2.5">
            {check.status === 'PASS' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" /> : <AlertCircle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${check.status === 'FAIL' ? 'text-red-600' : 'text-amber-600'}`} />}
            <div className="min-w-0"><p className="text-xs font-medium text-slate-700">{check.id}</p><p className="mt-0.5 text-xs leading-5 text-slate-500">{check.message}</p></div>
          </div>
        ))}
      </div>
    </details>
  );
}

function RunWorkspace({ runId, status, loading, onBack, onRefresh }: { runId: string; status?: ThetaRunStatus; loading: boolean; onBack: () => void; onRefresh: () => void }) {
  if (loading || !status) {
    return <div className="min-h-[60vh] grid place-items-center"><div className="text-center"><RefreshCw className="mx-auto h-5 w-5 animate-spin text-blue-600" /><p className="mt-3 text-sm text-slate-500">正在从事件记录恢复运行状态...</p></div></div>;
  }
  const path = status.statePath.filter((state, index, states) => index === 0 || states[index - 1] !== state);
  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2 h-8 text-slate-500"><ArrowLeft className="mr-1.5 h-4 w-4" />全部任务</Button>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{runLabel({ runId } as ThetaRunSummary)}</h1>
          <p className="mt-2 break-all text-xs text-slate-400">{runId}</p>
        </div>
        <div className="flex items-center gap-2"><Badge variant="outline" className={runBadgeClass(status.currentState, status.pendingReason)}>{runStateLabel(status.currentState, status.pendingReason)}</Badge><Button type="button" variant="outline" size="icon" onClick={onRefresh} title="刷新任务状态" className="h-8 w-8 rounded-lg"><RefreshCw className="h-4 w-4" /></Button></div>
      </div>
      {status.pendingReason ? <div className="mb-6 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /><span>{status.pendingReason}</span></div> : null}
      <section className="mb-7 grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-4">
        <DetailMetric label="运行状态" value={status.status} /><DetailMetric label="当前 FSM" value={status.currentState ?? '无'} /><DetailMetric label="事件数量" value={String(status.eventCount)} /><DetailMetric label="最后事件" value={status.lastEventType} />
      </section>
      <section>
        <div className="mb-3 flex items-center justify-between"><div><h2 className="text-base font-semibold text-slate-800">执行路径</h2><p className="mt-1 text-xs text-slate-400">状态由 Event Store 重放得到</p></div><span className="text-xs text-slate-400">{path.length} 个阶段</span></div>
        <ol className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          {path.map((state, index) => {
            const current = index === path.length - 1;
            return <li key={`${state}-${index}`} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 sm:px-5"><span className={`grid h-7 w-7 flex-shrink-0 place-items-center rounded-full ${current ? 'bg-blue-600 text-white' : 'bg-emerald-50 text-emerald-600'}`}>{current ? <CircleDot className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><p className="break-all text-sm font-medium text-slate-700">{state}</p><p className="mt-0.5 text-xs text-slate-400">阶段 {index + 1}</p></div>{current ? <Badge variant="secondary">当前</Badge> : null}</li>;
          })}
        </ol>
      </section>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-r border-slate-100 px-4 py-4 last:border-r-0 sm:border-b-0"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 break-all text-sm font-semibold text-slate-800">{value}</p></div>;
}

function HealthBadge({ status }: { status?: ThetaHealth['status'] }) {
  const label = status === 'ready' ? '环境正常' : status === 'degraded' ? '有提醒' : status === 'blocked' ? '环境阻塞' : '检查中';
  const tone = status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status === 'degraded' ? 'border-amber-200 bg-amber-50 text-amber-700' : status === 'blocked' ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-500';
  return <Badge variant="outline" className={tone}><span className="mr-1.5 h-2 w-2 rounded-full bg-current" />{label}</Badge>;
}

function RunStatusBadge({ run }: { run: ThetaRunSummary }) {
  const label = needsAttention(run) ? '待处理' : isCompleted(run) ? '已完成' : '进行中';
  const tone = needsAttention(run) ? 'border-amber-200 bg-amber-50 text-amber-700' : isCompleted(run) ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-blue-200 bg-blue-50 text-blue-700';
  return <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${tone}`}>{label}</Badge>;
}

function StatusDot({ run }: { run: ThetaRunSummary }) {
  const tone = needsAttention(run) ? 'bg-amber-500' : isCompleted(run) ? 'bg-emerald-500' : 'bg-blue-500';
  return <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${tone}`} />;
}

const ErrorNotice = ({ message }: { message: string }) => <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /><div><p className="font-medium">Agent API 暂不可用</p><p className="mt-1 text-red-600">{message}</p></div></div>;
const LoadingRows = () => <div className="divide-y divide-slate-100">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-[76px] animate-pulse bg-gradient-to-r from-white via-slate-50 to-white" />)}</div>;
const EmptyRuns = ({ filtered }: { filtered: boolean }) => <div className="px-4 py-14 text-center"><Database className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-3 text-sm font-medium text-slate-600">{filtered ? '没有匹配的任务' : '还没有研究任务'}</p><p className="mt-1 text-xs text-slate-400">{filtered ? '请调整筛选条件或搜索词。' : '创建任务后，Run 会显示在这里。'}</p></div>;

const needsAttention = (run: ThetaRunSummary): boolean => Boolean(run.pendingReason) || run.currentState === 'Quarantined' || run.status === 'failed' || run.status === 'needs_attention';
const isCompleted = (run: ThetaRunSummary): boolean => run.currentState
  ? run.currentState === 'Completed'
  : run.status === 'completed';
const isActive = (run: ThetaRunSummary): boolean => !needsAttention(run) && !isCompleted(run);
const runLabel = (run: ThetaRunSummary): string => {
  if (run.runId.startsWith('theta-dataset-analysis')) {
    const suffix = run.runId.match(/-(dtm\d*|btm\d*|hdp\d*)$/i)?.[1];
    return suffix ? `数据集主题分析 · ${suffix.toUpperCase()}` : '数据集主题分析';
  }
  if (run.runId.startsWith('theta-stage-')) return `阶段验证 · ${run.runId.replace('theta-stage-', '').replaceAll('-', ' ')}`;
  return `研究任务 · ${run.runId.replace('theta-run-', '').slice(0, 8)}`;
};
const runStateLabel = (state?: string, pending?: string): string => pending || state === 'Quarantined' ? '需要处理' : state === 'Completed' ? '已完成' : '进行中';
const runBadgeClass = (state?: string, pending?: string): string => pending || state === 'Quarantined' ? 'border-amber-200 bg-amber-50 text-amber-700' : state === 'Completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-blue-200 bg-blue-50 text-blue-700';
const formatDate = (value: string): string => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
