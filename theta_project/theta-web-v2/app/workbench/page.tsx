'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Database,
  Home,
  Play,
  Plus,
  RefreshCw,
  Settings2,
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
} from '@/lib/api/theta-agent-v2';

const actionableStates = new Set([
  'ResearchClarification',
  'ColumnConfirmation',
  'AwaitPlanCreationApproval',
  'AwaitTrainingStartApproval',
]);

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
            onRefresh={() => void openRun(activeRunId)}
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
        <h2 className="mt-3 text-base font-semibold text-slate-900">{presentation?.title ?? stateTitle(run.currentState)}</h2>
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
      <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{runLabel(run)}</p><p className="mt-1 truncate text-xs text-slate-400">{run.presentation?.title ?? stateTitle(run.currentState)}</p></div>
      <Badge variant="outline" className={state.tone}>{state.label}</Badge>
      <span className="hidden text-xs text-slate-400 sm:block">{formatDate(run.lastEventAt ?? run.updatedAt)}</span>
      <ChevronRight className="h-4 w-4 text-slate-300" />
    </button>
  );
}

function RunWorkspace({ runId, status, loading, onBack, onRefresh, onStatusChange }: {
  runId: string;
  status?: ThetaRunStatus;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStatusChange: (status: ThetaRunStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [plan, setPlan] = useState<ThetaPlan>();
  const [models, setModels] = useState<ThetaModel[]>([]);
  const actionInFlight = useRef(false);

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

  if (loading || !status) return <LoadingBlock />;
  const presentation = status.presentation;
  const progress = presentation.progress
    ? Math.round((presentation.progress.current / presentation.progress.total) * 100)
    : 0;
  return (
    <div>
      <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-8 text-slate-500"><ArrowLeft className="mr-1.5 h-4 w-4" />返回任务列表</Button>
      <section className="mt-4 rounded-md border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0"><p className="text-xs font-medium text-blue-600">{runLabel({ runId } as ThetaRunSummary)}</p><h1 className="mt-1 text-xl font-semibold sm:text-2xl">{presentation.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{presentation.summary}</p></div>
          <Button type="button" variant="outline" size="icon" onClick={onRefresh} title="刷新状态" className="h-8 w-8 rounded-md"><RefreshCw className="h-4 w-4" /></Button>
        </div>
        <div className="mt-5 flex items-center gap-3"><Progress value={progress} className="h-2" /><span className="whitespace-nowrap text-xs text-slate-400">步骤 {presentation.progress?.current ?? '-'} / {presentation.progress?.total ?? 7}</span></div>
      </section>

      {actionError ? <ErrorNotice message={actionError} /> : null}
      {actionNotice ? <ActionNotice message={actionNotice} /> : null}
      <ActionPanel status={status} plan={plan} models={models} busy={busy} onAction={act} />

      <details className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:px-5"><span className="flex items-center gap-2"><Settings2 className="h-4 w-4" />技术执行记录</span><span className="text-xs font-normal text-slate-400">{status.eventCount} 个事件</span></summary>
        <ol className="border-t border-slate-100 px-4 py-3 sm:px-5">
          {uniquePath(status.statePath).map((state, index, states) => <li key={`${state}-${index}`} className="flex items-center gap-3 py-2 text-xs text-slate-500"><span className={`grid h-6 w-6 place-items-center rounded-full ${index === states.length - 1 ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>{index === states.length - 1 ? <CircleDot className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}</span><span>{state}</span></li>)}
        </ol>
      </details>
    </div>
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

  if (state === 'MonitorTraining' || state === 'StartTraining') return <ActionShell title="训练正在后台运行" description="无需重复启动。稍后点击页面右上角刷新即可查看进度。"><div className="flex items-center gap-2 text-sm text-blue-700"><RefreshCw className="h-4 w-4 animate-spin" />正在等待训练进程返回新事件</div></ActionShell>;
  if (state === 'Failed') return <ActionShell title="运行未完成" description={status.presentation.summary}><p className="mb-3 text-sm text-slate-600">原任务会保持不变。系统将复用已确认的研究设置和数据列，创建一个新的恢复任务。</p><Button type="button" disabled={busy} onClick={() => void onAction({ action: 'retry' })} className="bg-blue-600 hover:bg-blue-700">{busy ? '正在创建恢复任务...' : '创建恢复任务'}</Button></ActionShell>;
  if (state === 'Quarantined') return <ActionShell title="该记录已隔离" description="该次运行的产物或状态不完整，系统不会擅自重启。请保留此记录并新建研究；技术原因可在下方记录中核对。"><p className="text-sm text-amber-700">这不是等待审批，因此不需要点击“开始训练”。</p></ActionShell>;
  if (state === 'Completed') return <ActionShell title="训练已完成" description="训练和产物校验已经结束。"><div className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />可以继续查看结果产物和研究结论。</div></ActionShell>;
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

const SectionHeading = ({ title, subtitle }: { title: string; subtitle: string }) => <div className="mb-3 flex items-end justify-between gap-4"><div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-xs text-slate-400">{subtitle}</p></div></div>;
const EmptyPanel = ({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) => <div className={`rounded-md border border-dashed border-slate-200 bg-white text-center ${compact ? 'px-4 py-8' : 'px-4 py-12'}`}><Database className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-2 text-sm font-medium text-slate-600">{title}</p><p className="mt-1 text-xs text-slate-400">{description}</p></div>;
const LoadingBlock = () => <div className="grid min-h-44 place-items-center rounded-md border border-slate-200 bg-white"><div className="text-center"><RefreshCw className="mx-auto h-5 w-5 animate-spin text-blue-600" /><p className="mt-2 text-sm text-slate-500">正在读取事件状态...</p></div></div>;
const ErrorNotice = ({ message }: { message: string }) => <div className="my-5 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /><span>{message}</span></div>;
const ActionNotice = ({ message }: { message: string }) => <div className="my-5 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"><CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" /><span>{message}</span></div>;
function HealthBadge({ status }: { status?: ThetaHealth['status'] }) { const label = status === 'ready' ? '环境正常' : status === 'degraded' ? '有提醒' : status === 'blocked' ? '环境阻塞' : '检查中'; const tone = status === 'ready' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status === 'degraded' ? 'border-amber-200 bg-amber-50 text-amber-700' : status === 'blocked' ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-500'; return <Badge variant="outline" className={tone}>{label}</Badge>; }

const statusKind = (run: ThetaRunSummary): { label: string; tone: string } => actionableStates.has(run.currentState ?? '') ? { label: '待确认', tone: 'border-amber-200 bg-amber-50 text-amber-700' } : isRunning(run) ? { label: '运行中', tone: 'border-blue-200 bg-blue-50 text-blue-700' } : run.currentState === 'Completed' ? { label: '已完成', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' } : { label: '需检查', tone: 'border-red-200 bg-red-50 text-red-700' };
const isRunning = (run: ThetaRunSummary): boolean => ['StartTraining', 'MonitorTraining'].includes(run.currentState ?? '') || run.status === 'waiting_timer';
const stateTitle = (state?: string): string => ({ ResearchClarification: '完善研究设置', ColumnConfirmation: '确认数据列', AwaitPlanCreationApproval: '确认训练方案', AwaitTrainingStartApproval: '启动真实训练', MonitorTraining: '模型训练中', Completed: '训练完成', Failed: '运行失败', Quarantined: '运行已隔离' } as Record<string, string>)[state ?? ''] ?? '处理研究任务';
const runLabel = (run: ThetaRunSummary): string => run.runId.startsWith('theta-dataset-analysis') ? `数据集主题分析${run.runId.match(/-(dtm\d*|btm\d*|hdp\d*)$/iu)?.[1] ? ` · ${run.runId.match(/-(dtm\d*|btm\d*|hdp\d*)$/iu)?.[1]?.toUpperCase()}` : ''}` : run.runId.startsWith('theta-stage-') ? `阶段验证 · ${run.runId.replace('theta-stage-', '').replaceAll('-', ' ')}` : `研究任务 · ${run.runId.replace('theta-run-', '').slice(0, 8)}`;
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
const formatBytes = (value: number): string => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
