'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  CircleDashed,
  Compass,
  Database,
  FolderOpen,
  Home,
  Network,
  Plus,
  RefreshCw,
  MessageSquareText,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useThetaV3Workbench } from '@/hooks/use-theta-v3-workbench';
import type { RunLifecycle, RunPhase, ThetaRunSummaryV3 } from '@/lib/api/v3';
import { AgentActivity } from './agent-activity';
import { CheckpointCard } from './checkpoint-card';
import { ConversationPanel } from './conversation-panel';
import { DatasetUnderstandingComplete } from './dataset-checkpoint-content';
import { FailureCard } from './failure-card';
import { ManualProjectStart, ManualWorkbench } from './manual-workbench';
import { ResultsPanel } from './results-panel';
import { ResearchWorkspace } from './research-workspace';
import { TrainingProgress } from './training-progress';

type WorkspaceMode = 'conversation' | 'manual';

export function AgentWorkbench() {
  const router = useRouter();
  const controller = useThetaV3Workbench();
  const [initialMessage, setInitialMessage] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('conversation');
  const view = controller.state.view;

  useEffect(() => {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get('mode');
    const stored = window.localStorage.getItem('theta-workbench-mode');
    const mode = requested === 'manual' || requested === 'conversation'
      ? requested
      : stored === 'manual' || stored === 'conversation'
        ? stored
        : 'conversation';
    setWorkspaceMode(mode);
    window.localStorage.setItem('theta-workbench-mode', mode);
    if (requested !== mode) {
      url.searchParams.set('mode', mode);
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }, []);

  const changeWorkspaceMode = (mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    window.localStorage.setItem('theta-workbench-mode', mode);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', mode);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const createRun = async () => {
    const created = await controller.createRun({ initialMessage });
    if (!created) return;
    setInitialMessage('');
  };

  const startNewProject = () => {
    setInitialMessage('');
    controller.startNewProject();
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky left-0 top-0 z-30 h-14 w-[100dvw] overflow-hidden border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto grid h-full w-full max-w-[1720px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/theta-logo.png" alt="THETA" className="h-9 w-auto" />
            <span className="h-5 w-px bg-slate-200" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Agent 研究工作台</p>
              <p className="hidden text-[11px] text-slate-400 sm:block">V3 · RunView 驱动</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:block"><WorkspaceModeSwitch mode={workspaceMode} onChange={changeWorkspaceMode} /></div>
            <HealthStatus status={controller.health?.status} />
            <EventStatus status={controller.eventStatus} />
            <Button type="button" variant="ghost" size="icon" title="刷新" disabled={controller.refreshing} onClick={() => void controller.refresh()} className="hidden sm:inline-flex">
              <RefreshCw className={`h-4 w-4 ${controller.refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button type="button" variant="ghost" size="icon" title="返回首页" onClick={() => router.push('/')} className="hidden sm:inline-flex">
              <Home className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <div className="fixed right-3 top-2 z-40 sm:hidden">
        <WorkspaceModeSwitch mode={workspaceMode} onChange={changeWorkspaceMode} />
      </div>

      <main className="mx-auto w-full max-w-[1720px] px-3 py-3 sm:px-5">
        {controller.error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{controller.error}</span>
          </div>
        ) : null}

        <div className="grid min-w-0 gap-3 lg:grid-cols-[248px_minmax(0,1fr)]">
          <RunSidebar
            runs={controller.runs}
            activeRunId={controller.activeRunId}
            loading={controller.loading}
            deletingRunId={controller.deletingRunId}
            onOpen={controller.openRun}
            onCreate={startNewProject}
            onDelete={controller.deleteRun}
          />

          <section className="min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white">
            {controller.loading && !view ? (
              <LoadingWorkspace />
            ) : view ? (
              workspaceMode === 'conversation' ? (
                <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
                  <div className="min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r">
                    <RunHeader view={view} />
                    <AgentActivity activity={view.activity} progress={view.progress} />
                    {view.failure ? (
                      <FailureCard
                        failure={view.failure}
                        busy={controller.commandBusy}
                        onRecover={(actionId) => void controller.executeRecovery(actionId)}
                      />
                    ) : view.checkpoint ? (
                      <CheckpointCard
                        checkpoint={view.checkpoint}
                        dataset={view.dataset}
                        research={view.research}
                        plan={view.plan}
                        capabilities={view.capabilities}
                        busy={controller.commandBusy}
                        onConfirm={() => void controller.confirmCheckpoint()}
                      />
                    ) : <>
                      {view.training ? (
                        <TrainingProgress
                          training={view.training}
                          capabilities={view.capabilities}
                          busy={controller.commandBusy}
                          onApprove={() => void controller.approveTraining()}
                        />
                      ) : null}
                      {view.results?.status === 'available' ? (
                        <ResultsPanel results={view.results} artifacts={controller.resultArtifacts} />
                      ) : null}
                      {view.dataset && view.phase === 'research_dialogue' ? (
                        <DatasetUnderstandingComplete dataset={view.dataset} />
                      ) : null}
                      {view.research && view.phase === 'research_dialogue' ? (
                        <ResearchWorkspace research={view.research} />
                      ) : null}
                      {!view.training && view.results?.status !== 'available' ? <RunOverview view={view} /> : null}
                    </>}
                  </div>
                  <ConversationPanel
                    messages={controller.state.messages}
                    pendingMessages={controller.pendingMessages}
                    canSend={view.capabilities.canSendMessage}
                    busy={controller.commandBusy}
                    prompt={view.interaction.prompt}
                    onSend={controller.sendMessage}
                  />
                </div>
              ) : (
                <div className="min-w-0">
                  <RunHeader view={view} />
                  <AgentActivity activity={view.activity} progress={view.progress} />
                  <ManualWorkbench
                    view={view}
                    datasets={controller.datasets}
                    artifacts={controller.resultArtifacts}
                    busy={controller.commandBusy}
                    onSendInstruction={controller.sendMessage}
                    onConfirmCheckpoint={() => void controller.confirmCheckpoint()}
                    onApproveTraining={() => void controller.approveTraining()}
                    onRecover={(actionId) => void controller.executeRecovery(actionId)}
                  />
                </div>
              )
            ) : (
              workspaceMode === 'conversation' ? (
                <EmptyWorkspace
                  draft={initialMessage}
                  busy={controller.commandBusy}
                  canStart={controller.datasets.some((dataset) => dataset.availability === 'ready')}
                  onDraftChange={setInitialMessage}
                  onCreate={createRun}
                />
              ) : (
                <ManualProjectStart
                  datasets={controller.datasets}
                  busy={controller.commandBusy}
                  onCreate={async (input) => { await controller.createRun(input); }}
                />
              )
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function WorkspaceModeSwitch({ mode, onChange }: { mode: WorkspaceMode; onChange: (mode: WorkspaceMode) => void }) {
  return (
    <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-100 p-1" aria-label="工作台模式">
      <button type="button" aria-pressed={mode === 'conversation'} title="对话模式" onClick={() => onChange('conversation')} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors ${mode === 'conversation' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
        <MessageSquareText className="h-3.5 w-3.5" /><span className="hidden md:inline">对话</span>
      </button>
      <button type="button" aria-pressed={mode === 'manual'} title="手动模式" onClick={() => onChange('manual')} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors ${mode === 'manual' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
        <SlidersHorizontal className="h-3.5 w-3.5" /><span className="hidden md:inline">手动</span>
      </button>
    </div>
  );
}

function RunSidebar({ runs, activeRunId, loading, deletingRunId, onOpen, onCreate, onDelete }: {
  runs: ThetaRunSummaryV3[];
  activeRunId?: string;
  loading: boolean;
  deletingRunId?: string;
  onOpen: (runId: string) => Promise<void>;
  onCreate: () => void;
  onDelete: (runId: string) => Promise<void>;
}) {
  const attention = runs.filter((run) => run.interaction.expectsUserInput);
  const active = runs.filter((run) => !run.interaction.expectsUserInput && ['active', 'waiting_runtime'].includes(run.lifecycle));
  const finished = runs.filter((run) => !attention.includes(run) && !active.includes(run));

  return (
    <aside className="overflow-hidden rounded-md border border-slate-200 bg-white lg:sticky lg:top-[68px] lg:h-[calc(100dvh-80px)]">
      <div className="border-b border-slate-200 p-3">
        <div className="mb-3 flex items-center gap-2 px-1">
          <FolderOpen className="h-4 w-4 text-blue-700" />
          <div>
            <p className="text-sm font-semibold">研究项目</p>
            <p className="text-[11px] text-slate-400">按用户交互状态分类</p>
          </div>
        </div>
        <Button type="button" className="w-full justify-start" onClick={onCreate}>
          <Plus className="h-4 w-4" />新建研究
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto p-2 lg:max-h-[calc(100dvh-170px)]">
        {loading && !runs.length ? (
          <p className="px-3 py-5 text-xs text-slate-400">正在读取项目…</p>
        ) : runs.length ? (
          <div className="space-y-4">
            <RunGroup title="需要处理" runs={attention} activeRunId={activeRunId} deletingRunId={deletingRunId} onOpen={onOpen} onDelete={onDelete} />
            <RunGroup title="Agent 工作中" runs={active} activeRunId={activeRunId} deletingRunId={deletingRunId} onOpen={onOpen} onDelete={onDelete} />
            <RunGroup title="最近项目" runs={finished} activeRunId={activeRunId} deletingRunId={deletingRunId} onOpen={onOpen} onDelete={onDelete} />
          </div>
        ) : (
          <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">暂无研究项目</p>
        )}
      </div>
    </aside>
  );
}

function RunGroup({ title, runs, activeRunId, deletingRunId, onOpen, onDelete }: {
  title: string;
  runs: ThetaRunSummaryV3[];
  activeRunId?: string;
  deletingRunId?: string;
  onOpen: (runId: string) => Promise<void>;
  onDelete: (runId: string) => Promise<void>;
}) {
  if (!runs.length) return null;
  return (
    <section>
      <p className="px-2 pb-1 text-[10px] font-semibold text-slate-400">{title} · {runs.length}</p>
      <div className="space-y-1">
        {runs.map((run) => {
          const selected = run.runId === activeRunId;
          return (
            <div
              key={run.runId}
              className={`group flex min-w-0 items-stretch rounded-md border transition-colors ${selected ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}
            >
              <button
                type="button"
                onClick={() => void onOpen(run.runId)}
                className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
              >
                <p className="truncate text-sm font-medium text-slate-900">{run.title ?? run.runId}</p>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span className="truncate">{phaseLabel(run.phase)}</span>
                  <span className={run.interaction.expectsUserInput ? 'text-amber-700' : ''}>{run.interaction.expectsUserInput ? '等待你' : lifecycleLabel(run.lifecycle)}</span>
                </div>
              </button>
              <button
                type="button"
                title="删除项目"
                aria-label={`删除项目 ${run.title ?? run.runId}`}
                disabled={Boolean(deletingRunId)}
                onClick={() => {
                  if (window.confirm(`确定删除项目“${run.title ?? run.runId}”吗？`)) void onDelete(run.runId);
                }}
                className="m-1.5 grid w-8 shrink-0 place-items-center rounded-md text-slate-400 opacity-70 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40 lg:opacity-0 lg:group-hover:opacity-100"
              >
                {deletingRunId === run.runId ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RunHeader({ view }: { view: NonNullable<ReturnType<typeof useThetaV3Workbench>['state']['view']> }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium text-blue-700">{phaseLabel(view.phase)}</p>
          <h1 className="mt-1 truncate text-lg font-semibold text-slate-950">{view.dataset?.fileName ?? 'THETA 研究项目'}</h1>
          <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{view.runId}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-md border border-slate-200 px-2 py-1 text-slate-500">Revision {view.revision}</span>
          <span className={`rounded-md px-2 py-1 font-medium ${view.interaction.expectsUserInput ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {view.interaction.expectsUserInput ? '需要你的操作' : lifecycleLabel(view.lifecycle)}
          </span>
        </div>
      </div>
      <PhaseRail current={view.phase} />
    </div>
  );
}

function PhaseRail({ current }: { current: RunPhase }) {
  const phases: Array<{ id: RunPhase; label: string }> = [
    { id: 'dataset_understanding', label: '数据' },
    { id: 'research_dialogue', label: '研究' },
    { id: 'plan_design', label: '方案' },
    { id: 'training', label: '训练' },
    { id: 'completed', label: '结果' },
  ];
  const currentIndex = Math.max(0, phases.findIndex((phase) => phase.id === normalizedRailPhase(current)));
  return (
    <div className="mt-4 grid grid-cols-5 gap-1" aria-label="研究阶段">
      {phases.map((phase, index) => (
        <div key={phase.id} className="min-w-0">
          <div className={`h-1.5 rounded-full ${index <= currentIndex ? 'bg-blue-600' : 'bg-slate-200'}`} />
          <p className={`mt-1 text-center text-[10px] ${index === currentIndex ? 'font-semibold text-blue-700' : 'text-slate-400'}`}>{phase.label}</p>
        </div>
      ))}
    </div>
  );
}

function RunOverview({ view }: { view: NonNullable<ReturnType<typeof useThetaV3Workbench>['state']['view']> }) {
  return (
    <div className="px-5 py-8">
      <div className="mx-auto max-w-lg text-center">
        {view.lifecycle === 'completed' ? <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" /> : <CircleDashed className="mx-auto h-8 w-8 text-slate-300" />}
        <h2 className="mt-3 text-base font-semibold">{view.progress.label}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{view.progress.detail ?? 'Agent 将通过事件流持续更新当前阶段。'}</p>
      </div>
    </div>
  );
}

const workspaceStarters = [
  { label: '探索并理解 THETA', icon: Compass, accent: 'text-sky-600' },
  { label: '导入数据集进行分析探索', icon: Database, accent: 'text-violet-600' },
  { label: '梳理框架以了解数据', icon: Network, accent: 'text-emerald-600' },
  { label: '修复问题和失败', icon: Wrench, accent: 'text-orange-600' },
] as const;

function EmptyWorkspace({ draft, busy, canStart, onDraftChange, onCreate }: {
  draft: string;
  busy: boolean;
  canStart: boolean;
  onDraftChange: (value: string) => void;
  onCreate: () => Promise<void>;
}) {
  const submit = () => {
    if (draft.trim() && canStart && !busy) void onCreate();
  };

  return (
    <div className="flex min-h-[calc(100dvh-80px)] flex-col px-4 py-8 sm:px-8 lg:min-h-[calc(100dvh-80px)]">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center">
        <div className="relative mx-auto flex h-52 w-full max-w-2xl flex-col items-center justify-end overflow-hidden sm:h-60">
          <img
            src="/theta-logo.png"
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-0 h-36 w-full select-none object-contain opacity-50 sm:h-44"
          />
          <h1 className="relative z-10 text-center text-2xl font-normal text-slate-950 sm:text-3xl">
            要在 THETA 内做什么？
          </h1>
        </div>

        <div className="mt-7 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {workspaceStarters.map(({ label, icon: Icon, accent }) => (
            <button
              key={label}
              type="button"
              onClick={() => onDraftChange('暂定')}
              className="group flex min-h-32 min-w-0 flex-col justify-between rounded-md border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
            >
              <Icon className={`h-5 w-5 ${accent}`} />
              <span className="mt-7 break-words text-sm font-semibold leading-6 text-slate-800">{label}</span>
            </button>
          ))}
        </div>

        <div className="mx-auto mt-12 w-full max-w-5xl rounded-md border border-slate-300 bg-white p-3 shadow-sm focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100">
          <Textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="输入你想在 THETA 中完成的任务"
            aria-label="THETA 任务输入"
            className="min-h-24 resize-none border-0 bg-transparent px-3 py-3 text-base shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-end px-2 pb-1">
            <Button
              type="button"
              size="icon"
              title="继续选择数据集"
              disabled={!draft.trim() || !canStart || busy}
              onClick={submit}
              className="h-8 w-8 rounded-full"
            >
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingWorkspace() {
  return <div className="grid min-h-[520px] place-items-center"><RefreshCw className="h-6 w-6 animate-spin text-blue-600" /></div>;
}

function HealthStatus({ status }: { status?: 'ready' | 'degraded' | 'blocked' }) {
  return (
    <span className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs sm:flex ${status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status === 'blocked' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />{status === 'ready' ? 'Mock Ready' : status === 'blocked' ? 'Blocked' : 'Checking'}
    </span>
  );
}

function EventStatus({ status }: { status: ReturnType<typeof useThetaV3Workbench>['eventStatus'] }) {
  const connected = status === 'connected';
  return (
    <span className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs md:flex ${connected ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === 'connecting' || status === 'reconnecting' ? 'animate-pulse' : ''}`} />
      {connected ? '事件已连接' : status === 'offline' ? '事件离线' : status === 'reconnecting' ? '事件重连中' : '事件连接中'}
    </span>
  );
}

const phaseLabel = (phase: RunPhase): string => ({
  intake: '接收任务',
  dataset_understanding: '理解数据',
  research_dialogue: '研究对话',
  plan_design: '设计方案',
  plan_confirmation: '确认方案',
  dry_run: '训练前检查',
  training_confirmation: '确认训练',
  training: '模型训练',
  result_analysis: '结果分析',
  completed: '研究完成',
  recovery: '恢复处理',
})[phase];

const lifecycleLabel = (lifecycle: RunLifecycle): string => ({
  active: '进行中',
  waiting_user: '等待用户',
  waiting_runtime: '等待运行时',
  completed: '已完成',
  failed: '失败',
  quarantined: '已隔离',
  cancelled: '已取消',
})[lifecycle];

const railPhaseAliases: Partial<Record<RunPhase, RunPhase>> = {
  intake: 'dataset_understanding',
  plan_confirmation: 'plan_design',
  dry_run: 'training',
  training_confirmation: 'training',
  result_analysis: 'completed',
  recovery: 'training',
};

const normalizedRailPhase = (phase: RunPhase): RunPhase => railPhaseAliases[phase] ?? phase;
