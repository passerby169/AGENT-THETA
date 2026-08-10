'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Database,
  FileCheck2,
  FileCog,
  ImageIcon,
  MessageSquareText,
  Play,
  RefreshCw,
  Settings2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import type {
  ThetaModel,
  ThetaPlan,
  ThetaRunAction,
  ThetaRunResults,
  ThetaRunStatus,
  ThetaRunSummary,
  ThetaRunTimeline,
} from '@/lib/api/theta-agent-v2';

interface ClassicActionOutcome {
  requestSucceeded: boolean;
  advanced: boolean;
}

type ClassicStage = 'data' | 'cleaning' | 'parameters' | 'training' | 'evaluation' | 'visualization';

interface StageDefinition {
  id: ClassicStage;
  label: string;
  description: string;
  icon: typeof Database;
}

const stages: StageDefinition[] = [
  { id: 'data', label: '数据管理', description: '数据集与研究目标', icon: Database },
  { id: 'cleaning', label: '数据清洗', description: '列角色与数据检查', icon: FileCog },
  { id: 'parameters', label: '参数选择', description: '模型建议与训练方案', icon: Settings2 },
  { id: 'training', label: '模型训练', description: '审批与后台进度', icon: Play },
  { id: 'evaluation', label: '评估结果', description: '质量指标与研究核对', icon: FileCheck2 },
  { id: 'visualization', label: '可视化', description: '图表与结果文件', icon: BarChart3 },
];

const stateStage = (state?: string): ClassicStage => {
  if (
    state === 'ResearchClarification' ||
    state === 'ResearchIntentInterview' ||
    state === 'AwaitDatasetUnderstandingConfirmation'
  ) return 'data';
  if (state === 'InspectDataset' || state === 'ColumnConfirmation') return 'cleaning';
  if (state === 'RecommendModel' || state === 'ValidatePlan' || state === 'AwaitPlanCreationApproval' || state === 'CreatePlan' || state === 'DryRun') return 'parameters';
  if (state === 'AwaitTrainingStartApproval' || state === 'VerifyDatasetBeforeTraining' || state === 'StartTraining' || state === 'MonitorTraining') return 'training';
  if (state === 'Completed') return 'evaluation';
  return 'data';
};

const displayValue = (value: unknown): string => {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '是' : '否';
  return '未生成';
};

export function ThetaOneWorkbench({
  run,
  status,
  timeline,
  plan,
  results,
  resultsLoading,
  assistant,
  assistantExpanded,
  models,
  busy,
  notice,
  onAction,
}: {
  run?: ThetaRunSummary;
  status: ThetaRunStatus;
  timeline?: ThetaRunTimeline;
  plan?: ThetaPlan;
  results?: ThetaRunResults;
  resultsLoading: boolean;
  assistant: ReactNode;
  assistantExpanded: boolean;
  models: ThetaModel[];
  busy: boolean;
  notice?: string;
  onAction: (action: ThetaRunAction) => Promise<ClassicActionOutcome>;
}) {
  const currentStage = stateStage(status.currentState);
  const [activeStage, setActiveStage] = useState<ClassicStage>(currentStage);
  const [showAssistant, setShowAssistant] = useState(false);

  useEffect(() => {
    setActiveStage(currentStage);
  }, [currentStage, status.runId]);

  useEffect(() => {
    setShowAssistant(assistantExpanded);
  }, [assistantExpanded, status.runId]);

  const currentIndex = stages.findIndex((stage) => stage.id === currentStage);
  const trainingProgress = Math.round(timeline?.training?.progress ?? status.trainingReceipt?.progress ?? 0);
  const modelId = run?.identity?.modelId ?? plan?.validatedPlan?.modelId ?? plan?.candidatePlan?.modelId;
  const topicCount = run?.identity?.numTopics
    ?? plan?.validatedPlan?.numTopics
    ?? plan?.validatedPlan?.parameters?.numTopics
    ?? plan?.candidatePlan?.numTopics
    ?? plan?.candidatePlan?.parameters?.numTopics;
  const metrics = useMemo(() => Object.entries(results?.metrics ?? {}).slice(0, 8), [results?.metrics]);
  const assistantVisible = assistantExpanded || showAssistant;

  return (
    <section className="mt-4">
      <div className={`overflow-hidden transition-all duration-500 ease-in-out ${assistantExpanded ? 'max-h-0 border-transparent opacity-0' : 'max-h-24 border-y border-slate-200 bg-white px-2 py-3 opacity-100'}`}>
        <div className="flex min-w-[820px] items-center justify-between">
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            const completed = index < currentIndex || status.currentState === 'Completed';
            const current = stage.id === currentStage;
            const active = stage.id === activeStage;
            return (
              <div key={stage.id} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={() => setActiveStage(stage.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${active ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${completed ? 'bg-emerald-50 text-emerald-600' : current ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                    {completed ? <Check className="h-4 w-4" /> : current ? <CircleDot className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">{stage.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-slate-400">{stage.description}</span>
                  </span>
                </button>
                {index < stages.length - 1 ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" /> : null}
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={`grid grid-cols-1 items-start transition-[grid-template-columns,gap,margin] duration-500 ease-in-out ${assistantExpanded ? 'mt-0 gap-0 lg:grid-cols-[0fr_minmax(0,1fr)]' : assistantVisible ? 'mt-4 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,390px)]' : 'mt-4 gap-0 lg:grid-cols-1'}`}
      >
        <div className={`min-w-0 overflow-hidden transition-[max-height,opacity,transform] duration-500 ease-in-out ${assistantExpanded ? 'pointer-events-none max-h-0 -translate-x-6 opacity-0' : 'max-h-[5000px] translate-x-0 space-y-4 opacity-100'}`} aria-hidden={assistantExpanded}>
          <div className="rounded-md border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600">THETA 一代工作台视图</p>
                <h2 className="mt-1 text-xl font-semibold text-slate-900">{stages.find((stage) => stage.id === activeStage)?.label}</h2>
                <p className="mt-2 text-sm text-slate-500">界面可以自由查看；实际进度、审批和训练仍由当前 Hypha Run 统一管理。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">同一任务 · 实时同步</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAssistant((visible) => !visible)} className="gap-1.5">
                  {showAssistant ? <X className="h-3.5 w-3.5" /> : <MessageSquareText className="h-3.5 w-3.5" />}
                  {showAssistant ? '关闭辅助说明' : '打开辅助说明'}
                </Button>
              </div>
            </div>

            {activeStage === 'data' ? (
              <div className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <ClassicInfo label="数据集" value={run?.identity?.datasetName ?? status.datasetProfile?.fileName ?? '当前本地数据集'} />
                  <ClassicInfo label="研究方向" value={status.researchBrief?.researchDomain ?? status.datasetProfile?.inferredDomain?.label ?? '等待确认'} />
                  <div className="rounded-md border border-slate-200 p-4 sm:col-span-2">
                    <p className="text-xs font-medium text-slate-500">研究目标</p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{cleanResearchQuestion(run?.identity?.researchQuestion) ?? status.researchBrief?.researchQuestion ?? status.presentation.summary}</p>
                  </div>
                </div>
                <ClassicManualControl activeStage={activeStage} status={status} plan={plan} models={models} busy={busy} notice={notice} onAction={onAction} />
              </div>
            ) : null}

            {activeStage === 'cleaning' ? (
              <div className="mt-5 space-y-4">
                <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-4">
                  <p className="text-sm font-semibold text-blue-900">数据检查与列角色</p>
                  <p className="mt-1 text-xs leading-5 text-blue-800">正文、时间、ID 和元数据列的确认结果记录在当前 Run 中。需要补充时，可直接在本页完成当前操作。</p>
                </div>
                <ClassicInfo label="当前 FSM 状态" value={status.currentState ?? status.status} />
                <ClassicManualControl activeStage={activeStage} status={status} plan={plan} models={models} busy={busy} notice={notice} onAction={onAction} />
              </div>
            ) : null}

            {activeStage === 'parameters' ? (
              <div className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <ClassicInfo label="模型" value={modelId?.toUpperCase() ?? '等待推荐'} />
                  <ClassicInfo label="主题数量" value={topicCount === undefined || topicCount === null ? '等待确认' : `${topicCount} 个`} />
                  <div className="rounded-md bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600 sm:col-span-2">{plan?.presentation.summary ?? '模型建议生成后会在这里同步展示。进入方案审批后可在本页手动修改模型和参数。'}</div>
                </div>
                <ClassicManualControl activeStage={activeStage} status={status} plan={plan} models={models} busy={busy} notice={notice} onAction={onAction} />
              </div>
            ) : null}

            {activeStage === 'training' ? (
              <div className="mt-5 space-y-4">
                <div className="flex items-end justify-between gap-4"><div><p className="text-xs font-medium text-slate-500">真实训练进度</p><p className="mt-1 text-3xl font-semibold text-slate-900">{trainingProgress}%</p></div><p className="text-xs text-slate-500">{status.trainingReceipt?.currentStep ?? '等待进入训练阶段'}</p></div>
                <Progress value={trainingProgress} className="h-2" />
                <div className="grid gap-4 sm:grid-cols-2"><ClassicInfo label="训练 ID" value={status.trainingReceipt?.trainingRunId ?? '尚未分配'} /><ClassicInfo label="运行状态" value={status.trainingReceipt?.status ?? status.status} /></div>
                <div className="max-h-40 overflow-y-auto rounded-md bg-slate-950 px-4 py-3 font-mono text-[11px] leading-5 text-slate-300">{timeline?.logs.length ? timeline.logs.slice(-12).map((line, index) => <p key={`${index}-${line}`} className="break-all">{line}</p>) : <p>训练日志将在任务启动后显示。</p>}</div>
                <ClassicManualControl activeStage={activeStage} status={status} plan={plan} models={models} busy={busy} notice={notice} onAction={onAction} />
              </div>
            ) : null}

            {activeStage === 'evaluation' ? (
              <div className="mt-5">
                {resultsLoading ? <p className="text-sm text-slate-500">正在读取评估结果...</p> : metrics.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{metrics.map(([key, value]) => <ClassicInfo key={key} label={key} value={displayValue(value)} />)}</div> : <p className="rounded-md bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">训练完成后显示质量指标与研究目标核对。</p>}
              </div>
            ) : null}

            {activeStage === 'visualization' ? (
              <div className="mt-5">
                {results?.visualizations.length ? <div className="grid gap-3 sm:grid-cols-2">{results.visualizations.slice(0, 6).map((item) => <div key={item.id} className="flex items-center gap-3 rounded-md border border-slate-200 px-4 py-3"><ImageIcon className="h-4 w-4 text-blue-600" /><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-700">{item.label}</p><p className="mt-0.5 text-[11px] text-slate-400">{item.format === 'image' ? '图像结果' : '交互式结果'}</p></div></div>)}</div> : <p className="rounded-md bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">训练产物绑定完成后显示图表与结果文件。</p>}
              </div>
            ) : null}
          </div>
        </div>

        <aside className={`min-w-0 overflow-hidden transition-[max-width,opacity,transform] duration-500 ease-in-out ${assistantVisible ? 'max-w-none translate-x-0 opacity-100' : 'pointer-events-none max-h-0 max-w-0 translate-x-8 opacity-0'} ${!assistantExpanded && assistantVisible ? 'lg:sticky lg:top-20' : ''}`} aria-hidden={!assistantVisible}>
          <div className={`flex items-center justify-between px-1 transition-all duration-200 ${assistantExpanded ? 'max-h-0 overflow-hidden opacity-0' : 'mb-2 max-h-14 opacity-100'}`}>
            <div><p className="text-xs font-semibold text-slate-700">THETA AI 助手</p><p className="mt-0.5 text-[11px] text-slate-400">当前任务操作与对话</p></div>
            <span className="rounded-sm bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700">动态同步</span>
          </div>
          {assistant}
        </aside>
      </div>
    </section>
  );
}

function ClassicManualControl({ activeStage, status, plan, models, busy, notice, onAction }: {
  activeStage: ClassicStage;
  status: ThetaRunStatus;
  plan?: ThetaPlan;
  models: ThetaModel[];
  busy: boolean;
  notice?: string;
  onAction: (action: ThetaRunAction) => Promise<ClassicActionOutcome>;
}) {
  const [answer, setAnswer] = useState('');
  const [columns, setColumns] = useState('');
  const [model, setModel] = useState('');
  const [topics, setTopics] = useState('');
  const [acceptDegradation, setAcceptDegradation] = useState(false);
  const state = status.currentState;

  useEffect(() => {
    if (!plan) return;
    const options = classicCompatibleModels(plan, models);
    const currentModel = classicPlanModelId(plan);
    setModel(options.some((item) => item.id === currentModel) ? currentModel : (options[0]?.id ?? currentModel));
    const count = classicPlanTopicCount(plan);
    setTopics(count === undefined || count === null ? '' : String(count));
  }, [models, plan]);

  useEffect(() => {
    if (state !== 'ColumnConfirmation' || columns) return;
    const textColumn = status.datasetProfile?.columnCandidates.text[0]?.name ?? 'text';
    const timeColumn = status.datasetProfile?.columnCandidates.time[0]?.name ?? '无';
    const metadataColumn = status.datasetProfile?.columnCandidates.metadata[0]?.name ?? '无';
    setColumns(`正文列：${textColumn}\n时间列：${timeColumn}\nID 列：无\n元数据列：${metadataColumn}`);
  }, [columns, state, status.datasetProfile]);

  const submitResearchSetting = async () => {
    const text = answer.trim();
    if (!text) return;
    const outcome = state === 'ResearchIntentInterview'
      ? await onAction({ action: 'decisionAnswer', text })
      : await onAction({ action: 'message', text, useMiniMax: false });
    if (outcome.requestSucceeded) setAnswer('');
  };

  const submitColumns = async () => {
    const text = columns.trim();
    if (!text) return;
    await onAction({ action: 'columns', text });
  };

  if (activeStage === 'data' && (state === 'ResearchClarification' || state === 'ResearchIntentInterview')) {
    const decisionInterview = state === 'ResearchIntentInterview';
    return (
      <ClassicControlShell
        title={decisionInterview ? '手动确认研究决策' : '手动设置研究方向'}
        description={decisionInterview
          ? '系统已完成可确定的检查；这里只确认会影响模型或评估方案的关键决策。'
          : '一代模式使用确定性流程保存研究边界，不依赖 AI 助手代替你作出业务判断。'}
      >
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-xs font-semibold text-blue-700">当前需要确认</p>
          <p className="mt-1 text-sm leading-6 text-blue-950">{status.decisionGap?.question ?? status.pendingReason ?? '请说明研究方向、分析对象或成功标准。'}</p>
          {status.decisionGap?.whyItMatters ? <p className="mt-2 text-xs leading-5 text-blue-700">为什么需要：{status.decisionGap.whyItMatters}</p> : null}
        </div>
        <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} placeholder="例如：这是社会科学短文本数据，我希望比较不同时间段的主题变化。" className="mt-3 min-h-28" />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" disabled={busy || !answer.trim()} onClick={() => void submitResearchSetting()} className="bg-blue-600 hover:bg-blue-700">{busy ? '正在保存...' : '保存本项设置并继续'}</Button>
          {!decisionInterview ? <Button type="button" variant="outline" disabled={busy} onClick={() => void onAction({ action: 'finishInterview' })}>检查必要信息完整度</Button> : null}
        </div>
        {notice ? <ClassicNotice message={notice} /> : null}
      </ClassicControlShell>
    );
  }

  if (activeStage === 'data' && state === 'AwaitDatasetUnderstandingConfirmation') {
    return <ClassicDatasetUnderstanding status={status} busy={busy} notice={notice} onAction={onAction} />;
  }

  if (activeStage === 'cleaning' && state === 'ColumnConfirmation') {
    return (
      <ClassicControlShell title="手动确认数据列" description="请使用数据集中的真实列名；正文列必填，其他角色不使用时写“无”。">
        <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
          <p className="rounded-md bg-slate-50 px-3 py-2"><strong>正文列：</strong>参与模型训练的完整文本。</p>
          <p className="rounded-md bg-slate-50 px-3 py-2"><strong>时间列：</strong>仅在分析时间趋势时使用。</p>
          <p className="rounded-md bg-slate-50 px-3 py-2"><strong>ID 列：</strong>每条记录的唯一标识。</p>
          <p className="rounded-md bg-slate-50 px-3 py-2"><strong>元数据列：</strong>用于来源或群体分组。</p>
        </div>
        <Textarea value={columns} onChange={(event) => setColumns(event.target.value)} disabled={busy} className="mt-3 min-h-32 font-mono text-sm" />
        <Button type="button" disabled={busy || !columns.trim()} onClick={() => void submitColumns()} className="mt-3 bg-blue-600 hover:bg-blue-700">{busy ? '正在校验...' : '确认数据列并生成方案'}</Button>
        {notice ? <ClassicNotice message={notice} /> : null}
      </ClassicControlShell>
    );
  }

  if (activeStage === 'parameters' && state === 'AwaitPlanCreationApproval') {
    const options = plan ? classicCompatibleModels(plan, models) : models;
    const dirty = plan ? classicPlanSettingsDirty(plan, model, topics) : true;
    return (
      <ClassicControlShell title="手动选择模型与参数" description="审批 1/2：先应用参数，再批准并固化方案；此处不会启动训练。">
        <div className="grid gap-4 sm:grid-cols-2">
          <label><span className="mb-1.5 block text-xs font-medium text-slate-600">训练模型</span><select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500">{options.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id.toUpperCase()})</option>)}</select></label>
          <label><span className="mb-1.5 block text-xs font-medium text-slate-600">主题数量</span><Input type="number" min={2} max={200} value={topics} disabled={busy} onChange={(event) => setTopics(event.target.value)} /></label>
        </div>
        {plan?.presentation.warnings?.length ? <div className="mt-3 flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{plan.presentation.warnings[0]}</div> : null}
        <label className="mt-3 flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={acceptDegradation} onChange={(event) => setAcceptDegradation(event.target.checked)} className="mt-0.5" />我已阅读能力缺口，并在仍有警告时接受该降级方案。</label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy || !model || !topics || !dirty} onClick={() => void onAction({ action: 'adjustPlan', text: `将模型改为 ${model.toUpperCase()}，主题数改为 ${topics}` })}>{dirty ? '应用模型与参数' : '设置已应用'}</Button>
          <Button type="button" disabled={busy || !model || dirty} onClick={() => void onAction({ action: 'approvePlan', acceptDegradation })} className="bg-blue-600 hover:bg-blue-700">批准并固化训练方案</Button>
        </div>
      </ClassicControlShell>
    );
  }

  if (activeStage === 'training' && state === 'AwaitTrainingStartApproval') {
    return (
      <ClassicControlShell title="启动真实训练" description="审批 2/2：数据校验和 dry-run 已通过，点击后才会启动本地 Python 训练。">
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />训练方案已固化，可以安全启动。</div>
        <Button type="button" disabled={busy} onClick={() => void onAction({ action: 'startTraining' })} className="mt-3 gap-2 bg-blue-600 hover:bg-blue-700"><Play className="h-4 w-4" />{busy ? '正在启动...' : '批准并开始训练'}</Button>
      </ClassicControlShell>
    );
  }

  if (activeStage === 'training' && (state === 'StartTraining' || state === 'MonitorTraining')) {
    return <ClassicControlShell title="训练正在运行" description="训练由后台 Runner 执行并通过事件同步，请勿重复启动。"><div className="flex items-center gap-2 text-sm text-blue-700"><RefreshCw className="h-4 w-4 animate-spin" />等待下一条训练进度事件</div></ClassicControlShell>;
  }

  return (
    <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
      当前 Run 位于“{classicStateLabel(state)}”。请切换到对应功能页完成操作；一代不会跳过 FSM 的必要步骤。
    </div>
  );
}

function ClassicDatasetUnderstanding({ status, busy, notice, onAction }: {
  status: ThetaRunStatus;
  busy: boolean;
  notice?: string;
  onAction: (action: ThetaRunAction) => Promise<ClassicActionOutcome>;
}) {
  const facts = status.datasetFacts;
  const understanding = status.datasetUnderstanding;
  const [domainLabel, setDomainLabel] = useState('');
  const [analysisUnit, setAnalysisUnit] = useState('');
  const [textColumns, setTextColumns] = useState('');
  const [timeColumns, setTimeColumns] = useState('');
  const [idColumns, setIdColumns] = useState('');
  const [metadataColumns, setMetadataColumns] = useState('');

  useEffect(() => {
    if (!understanding) return;
    setDomainLabel(understanding.domain.label);
    setAnalysisUnit(understanding.analysisUnit);
    setTextColumns(understanding.textColumns.map((item) => item.column).join('、'));
    setTimeColumns(understanding.timeColumns.map((item) => item.column).join('、'));
    setIdColumns(understanding.idColumns.map((item) => item.column).join('、'));
    setMetadataColumns(understanding.metadataColumns.map((item) => item.column).join('、'));
  }, [understanding]);

  if (!facts || !understanding) {
    return <ClassicControlShell title="正在读取数据结构" description="系统正在通过受治理工具建立本地数据概况。"><RefreshCw className="h-5 w-5 animate-spin text-blue-600" /></ClassicControlShell>;
  }

  const original = {
    domainLabel: understanding.domain.label,
    analysisUnit: understanding.analysisUnit,
    textColumns: understanding.textColumns.map((item) => item.column),
    timeColumns: understanding.timeColumns.map((item) => item.column),
    idColumns: understanding.idColumns.map((item) => item.column),
    metadataColumns: understanding.metadataColumns.map((item) => item.column),
  };
  const draft = {
    domainLabel: domainLabel.trim(),
    analysisUnit: analysisUnit.trim(),
    textColumns: splitClassicColumnNames(textColumns),
    timeColumns: splitClassicColumnNames(timeColumns),
    idColumns: splitClassicColumnNames(idColumns),
    metadataColumns: splitClassicColumnNames(metadataColumns),
  };
  const corrected = JSON.stringify(draft) !== JSON.stringify(original);
  const valid = Boolean(draft.domainLabel && draft.analysisUnit && draft.textColumns.length);

  return (
    <ClassicControlShell title="手动确认数据与研究方向" description="系统只负责预填结构事实；领域、分析单位和正文列由你确认后才进入模型推荐。">
      <div className="grid gap-3 sm:grid-cols-3">
        <ClassicInfo label="数据规模" value={`${facts.rowCount} 行 · ${facts.columns.length} 列`} />
        <ClassicInfo label="文件格式" value={facts.format.toUpperCase()} />
        <ClassicInfo label="自动理解置信度" value={`${Math.round(understanding.confidence * 100)}%`} />
      </div>
      <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        检测到的真实列：{facts.columns.map((column) => column.name).join('、')}。修改列角色不会改写原始数据，只会更新本次 Run 的训练输入契约。
      </div>
      {understanding.qualityWarnings.length ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{understanding.qualityWarnings.join('；')}</div> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ClassicLabeledInput label="研究领域/方向" value={domainLabel} onChange={setDomainLabel} />
        <ClassicLabeledInput label="每一行代表什么" value={analysisUnit} onChange={setAnalysisUnit} />
        <ClassicLabeledInput label="正文列（必填，可多列）" value={textColumns} onChange={setTextColumns} />
        <ClassicLabeledInput label="时间列（可选）" value={timeColumns} onChange={setTimeColumns} />
        <ClassicLabeledInput label="ID 列（可选）" value={idColumns} onChange={setIdColumns} />
        <ClassicLabeledInput label="分组元数据列（可选）" value={metadataColumns} onChange={setMetadataColumns} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={busy || !valid}
          onClick={() => void onAction({ action: 'confirmDataset', status: corrected ? 'corrected' : 'confirmed', ...draft })}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {busy ? '正在校验并保存...' : corrected ? '保存手动修正并继续' : '确认数据理解并继续'}
        </Button>
        <p className="text-xs text-slate-500">列名可用逗号、顿号或换行分隔；可选项留空表示不使用。</p>
      </div>
      {notice ? <ClassicNotice message={notice} /> : null}
    </ClassicControlShell>
  );
}

function ClassicLabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="mb-1.5 block text-xs font-medium text-slate-600">{label}</span><Input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ClassicControlShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="rounded-md border border-blue-200 bg-white p-4"><p className="text-sm font-semibold text-slate-900">{title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{description}</p><div className="mt-4">{children}</div></div>;
}

function ClassicNotice({ message }: { message: string }) {
  return <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{message}</div>;
}

function ClassicInfo({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-slate-200 bg-white px-4 py-3"><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold text-slate-800">{value}</p></div>;
}

const cleanResearchQuestion = (value?: string): string | undefined => {
  if (!value) return undefined;
  const normalized = value
    .replace(/[，,、；;\s]+(?=[，,、；;])/gu, '')
    .replace(/([，,、；;])\1+/gu, '$1')
    .replace(/^[，,、；;\s]+|[，,、；;\s]+$/gu, '')
    .trim();
  return normalized || undefined;
};

const classicPlanCandidate = (plan: ThetaPlan) => plan.validatedPlan ?? plan.candidatePlan;
const classicPlanModelId = (plan: ThetaPlan): string => classicPlanCandidate(plan)?.modelId?.toLowerCase() ?? '';
const classicPlanTopicCount = (plan: ThetaPlan): number | null | undefined => {
  const candidate = classicPlanCandidate(plan);
  return candidate?.numTopics ?? candidate?.parameters?.numTopics;
};
const classicCompatibleModels = (plan: ThetaPlan, catalog: ThetaModel[]): ThetaModel[] => {
  const recommended = plan.recommendation?.recommendations ?? [];
  const recommendedIds = new Set(recommended.map((item) => item.modelId.toLowerCase()));
  return [
    ...catalog.filter((model) => recommendedIds.has(model.id.toLowerCase())),
    ...catalog.filter((model) => !recommendedIds.has(model.id.toLowerCase())),
  ];
};
const classicPlanSettingsDirty = (plan: ThetaPlan, model: string, topics: string): boolean => {
  if (model.toLowerCase() !== classicPlanModelId(plan)) return true;
  const currentTopics = classicPlanTopicCount(plan);
  if (currentTopics === null || currentTopics === undefined) return topics.trim() !== '';
  return Number(topics) !== currentTopics;
};
const splitClassicColumnNames = (value: string): string[] => value
  .split(/[，,、；;\n\r\t]+/u)
  .map((item) => item.trim())
  .filter(Boolean);
const classicStateLabel = (state?: string): string => ({
  ResearchClarification: '研究方向确认',
  AwaitDatasetUnderstandingConfirmation: '数据理解确认',
  ResearchIntentInterview: '研究决策确认',
  InspectDataset: '数据预检',
  ColumnConfirmation: '数据列确认',
  RecommendModel: '模型推荐',
  ValidatePlan: '方案校验',
  AwaitPlanCreationApproval: '训练方案审批',
  CreatePlan: '创建正式方案',
  DryRun: '训练预演',
  AwaitTrainingStartApproval: '启动训练审批',
  VerifyDatasetBeforeTraining: '训练前数据校验',
  StartTraining: '启动训练',
  MonitorTraining: '模型训练',
  Completed: '训练完成',
  Failed: '运行失败',
  Quarantined: '运行隔离',
}[state ?? ''] ?? state ?? '等待同步');
