'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Database,
  FileSearch,
  FlaskConical,
  FolderOpen,
  Home,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { ProjectHub, type Project } from '@/components/dashboard/project-hub';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

interface RunProject extends Project {
  summary: ThetaRunSummary;
  runStatus?: ThetaRunStatus;
}

export default function WorkbenchPage() {
  const router = useRouter();
  const [health, setHealth] = useState<ThetaHealth>();
  const [runs, setRuns] = useState<ThetaRunSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ThetaRunStatus>>({});
  const [activeRunId, setActiveRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
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
      const resolvedStatuses = await Promise.allSettled(
        runData.runs.map((run) => ThetaAgentV2API.status(run.runId)),
      );
      setHealth(nextHealth);
      setRuns(runData.runs);
      setStatuses(Object.fromEntries(
        resolvedStatuses.flatMap((result, index) =>
          result.status === 'fulfilled'
            ? [[runData.runs[index].runId, result.value] as const]
            : [],
        ),
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const projects = useMemo<RunProject[]>(() => runs.map((run) => {
    const runStatus = statuses[run.runId];
    return {
      id: run.runId,
      name: run.runId,
      rows: run.eventCount,
      createdAt: formatDate(run.updatedAt),
      status: projectStatus(runStatus),
      pipelineStatus: pipelineStatus(runStatus),
      hasResults: runStatus?.currentState === 'Completed',
      datasetName: run.runId,
      description: `${run.eventCount} 个事件`,
      summary: run,
      runStatus,
    };
  }), [runs, statuses]);

  const activeStatus = activeRunId ? statuses[activeRunId] : undefined;
  const checks = health?.checks ?? [];
  const warningCount = checks.filter((check) => check.status === 'WARN').length;
  const failureCount = checks.filter((check) => check.status === 'FAIL').length;

  return (
    <div className="h-screen w-full max-w-[100vw] min-w-0 flex flex-col bg-gradient-to-br from-slate-50 via-slate-50 to-blue-50/30 overflow-hidden">
      <header className="h-14 min-w-0 flex-shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-200/60 flex items-center justify-between gap-2 px-4 sm:px-6 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
        <div className="flex flex-1 items-center gap-3 sm:gap-4 min-w-0 overflow-hidden">
          <img src="/theta-logo.png" alt="THETA" className="h-9 sm:h-10 w-auto flex-shrink-0" />
          <div className="h-5 w-px bg-slate-200 hidden sm:block" />
          <span className="text-xs font-medium text-slate-400 hidden sm:block">二代研究训练 Agent</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/')} className="h-8 gap-1.5 rounded-lg text-slate-600 hover:text-blue-700 hover:bg-blue-50">
            <Home className="h-4 w-4" />
            <span className="hidden sm:inline">返回首页</span>
          </Button>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Badge variant="outline" className={healthBadgeClass(health?.status)}>
            <span className="relative flex h-2 w-2 mr-1.5"><span className="relative inline-flex rounded-full h-2 w-2 bg-current" /></span>
            <span className="hidden sm:inline">{healthLabel(health?.status)}</span>
            <span className="sm:hidden">{healthShortLabel(health?.status)}</span>
          </Badge>
          <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} title="刷新工作台" className="h-8 w-8 rounded-lg">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <div className="h-11 flex-shrink-0 bg-white/80 border-b border-slate-200 flex items-center px-3 sm:px-5 gap-1 overflow-x-auto">
        <button type="button" onClick={() => setActiveRunId(undefined)} className={`flex items-center gap-2 px-4 h-8 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${activeRunId ? 'text-slate-500 hover:bg-slate-50' : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/80'}`}>
          <FolderOpen className="h-3.5 w-3.5" />项目中心
        </button>
        {activeRunId ? (
          <button type="button" className="flex items-center gap-2 px-4 h-8 rounded-lg bg-slate-100 text-slate-800 ring-1 ring-slate-200 text-sm font-medium whitespace-nowrap">
            <Activity className="h-3.5 w-3.5" />{activeRunId}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mx-4 sm:mx-6 mt-4 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div><p className="font-medium">Agent API 暂不可用</p><p className="mt-1 text-red-600">{error}</p></div>
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 max-w-full">
          {!activeRunId ? (
            <ProjectHub
              projects={projects}
              isLoading={loading}
              onProjectSelect={setActiveRunId}
              onNewProject={() => setShowCreateNotice(true)}
              onRefresh={() => void refresh()}
            />
          ) : (
            <RunWorkspace status={activeStatus} onBack={() => setActiveRunId(undefined)} />
          )}
        </main>

        <aside className="hidden xl:flex w-[340px] flex-shrink-0 border-l border-slate-200 bg-white flex-col overflow-hidden">
          <div className="h-12 px-4 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="h-4 w-4 text-blue-600" />运行保障</div>
            <span className="text-[11px] text-slate-400">Hypha</span>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-5">
            <section>
              <p className="text-xs font-semibold text-slate-500 mb-3">环境检查</p>
              <div className="grid grid-cols-3 border border-slate-200 rounded-lg overflow-hidden">
                <Metric label="通过" value={checks.filter((check) => check.status === 'PASS').length} tone="emerald" />
                <Metric label="提醒" value={warningCount} tone="amber" />
                <Metric label="阻塞" value={failureCount} tone="red" />
              </div>
            </section>
            <section>
              <p className="text-xs font-semibold text-slate-500 mb-3">执行原则</p>
              <ul className="space-y-2.5 text-xs text-slate-600">
                <Boundary icon={Database} text="Run 状态从 Event Store 投影" />
                <Boundary icon={ShieldCheck} text="训练启动必须经过两阶段审批" />
                <Boundary icon={RotateCcw} text="失败恢复保留完整事件谱系" />
                <Boundary icon={FileSearch} text="模型证据与结果均可追溯" />
              </ul>
            </section>
            {activeStatus?.pendingReason ? (
              <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold text-amber-800">当前需要处理</p>
                <p className="mt-1.5 text-xs leading-5 text-amber-700">{activeStatus.pendingReason}</p>
              </section>
            ) : null}
          </div>
        </aside>
      </div>

      <Dialog open={showCreateNotice} onOpenChange={setShowCreateNotice}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>数据集接入正在迁移</DialogTitle>
            <DialogDescription>
              当前页面已经接入真实 Run 和事件状态。下一步会把一代的数据上传交互接入二代的研究访谈、列确认和计划审批流程。
            </DialogDescription>
          </DialogHeader>
          <Button type="button" onClick={() => setShowCreateNotice(false)} className="w-full bg-blue-600 hover:bg-blue-700">知道了</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunWorkspace({ status, onBack }: { status?: ThetaRunStatus; onBack: () => void }) {
  if (!status) {
    return <div className="h-full grid place-items-center text-sm text-slate-500">正在读取事件投影...</div>;
  }
  const uniquePath = status.statePath.filter((state, index, path) => index === 0 || path[index - 1] !== state);
  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2 h-8 text-slate-500"><ArrowLeft className="h-4 w-4 mr-1.5" />项目中心</Button>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 break-all">{status.runId}</h1>
          <p className="mt-2 text-sm text-slate-500">最后事件：{status.lastEventType} · {formatDate(status.lastEventAt)}</p>
        </div>
        <Badge variant="outline" className={runBadgeClass(status.currentState)}>{runStateLabel(status.currentState)}</Badge>
      </div>

      <section className="grid grid-cols-2 lg:grid-cols-4 border border-slate-200 rounded-lg bg-white overflow-hidden mb-6">
        <RunMetric label="运行投影" value={status.status} />
        <RunMetric label="当前 FSM 状态" value={status.currentState ?? '无'} />
        <RunMetric label="事件数量" value={String(status.eventCount)} />
        <RunMetric label="处理要求" value={status.pendingReason ? '需要操作' : '无需操作'} />
      </section>

      {status.pendingReason ? (
        <div className="mb-6 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 flex gap-3 text-sm text-amber-800">
          <Clock3 className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>{status.pendingReason}</span>
        </div>
      ) : null}

      <section className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div><p className="text-xs font-medium text-slate-400">EVENT-FIRST WORKFLOW</p><h2 className="mt-1 text-base font-semibold text-slate-800">运行路径</h2></div>
          <span className="text-xs text-slate-400">{uniquePath.length} 个阶段</span>
        </div>
        <ol className="divide-y divide-slate-100">
          {uniquePath.map((state, index) => (
            <li key={`${state}-${index}`} className="px-5 py-3 flex items-center gap-3">
              <span className="h-7 w-7 rounded-full bg-emerald-50 text-emerald-600 grid place-items-center flex-shrink-0"><CheckCircle2 className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-700 break-all">{state}</p><p className="text-xs text-slate-400 mt-0.5">阶段 {index + 1}</p></div>
              {index === uniquePath.length - 1 ? <Badge variant="secondary">当前</Badge> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'amber' | 'red' }) {
  const color = tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-red-600';
  return <div className="p-3 text-center border-r last:border-r-0 border-slate-200"><strong className={`block text-lg ${color}`}>{value}</strong><span className="text-[11px] text-slate-400">{label}</span></div>;
}

function Boundary({ icon: Icon, text }: { icon: typeof Database; text: string }) {
  return <li className="flex items-start gap-2.5"><span className="h-7 w-7 rounded-md bg-blue-50 text-blue-600 grid place-items-center flex-shrink-0"><Icon className="h-3.5 w-3.5" /></span><span className="pt-1 leading-5">{text}</span></li>;
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 px-4 py-4 border-r border-b lg:border-b-0 last:border-r-0 border-slate-200"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-sm font-semibold text-slate-800 break-all">{value}</p></div>;
}

const pipelineStatus = (status?: ThetaRunStatus): Project['pipelineStatus'] => {
  if (!status) return undefined;
  if (status.currentState === 'Quarantined' || status.status === 'failed') return 'error';
  if (status.currentState === 'Completed') return 'completed';
  return 'running';
};

const projectStatus = (status?: ThetaRunStatus): Project['status'] => {
  const pipeline = pipelineStatus(status);
  if (pipeline === 'completed') return 'completed';
  if (pipeline === 'error') return 'no_result';
  if (pipeline === 'running') return 'vectorizing';
  return 'draft';
};

const healthLabel = (status?: ThetaHealth['status']): string => status === 'ready' ? '环境正常' : status === 'degraded' ? '可运行，有提醒' : status === 'blocked' ? '环境阻塞' : '检查中';
const healthShortLabel = (status?: ThetaHealth['status']): string => status === 'ready' ? '正常' : status === 'degraded' ? '提醒' : status === 'blocked' ? '阻塞' : '检查';
const healthBadgeClass = (status?: ThetaHealth['status']): string => status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status === 'degraded' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700';
const runStateLabel = (state?: string): string => state === 'Quarantined' ? '需要人工处理' : state === 'Completed' ? '已完成' : state ?? '读取中';
const runBadgeClass = (state?: string): string => state === 'Quarantined' ? 'border-red-200 bg-red-50 text-red-700' : state === 'Completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-blue-200 bg-blue-50 text-blue-700';
const formatDate = (value: string): string => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
