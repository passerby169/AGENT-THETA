'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  FileSearch,
  FlaskConical,
  LoaderCircle,
  MessageSquareText,
  Play,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type {
  DatasetCatalogItem,
  ResultArtifactSummary,
  RunPhase,
  ThetaRunViewV3,
} from '@/lib/api/v3';
import { CheckpointCard } from './checkpoint-card';
import { DatasetUnderstandingComplete } from './dataset-checkpoint-content';
import { FailureCard } from './failure-card';
import { PlanDetails } from './plan-details';
import { ResearchWorkspace } from './research-workspace';
import { ResultsPanel } from './results-panel';
import { TrainingProgress } from './training-progress';

type ManualStage = 'dataset' | 'research' | 'plan' | 'training' | 'results';

const stages: Array<{ id: ManualStage; label: string; icon: typeof Database }> = [
  { id: 'dataset', label: '数据管理', icon: Database },
  { id: 'research', label: '研究设置', icon: FileSearch },
  { id: 'plan', label: '模型与参数', icon: Settings2 },
  { id: 'training', label: '模型训练', icon: FlaskConical },
  { id: 'results', label: '结果分析', icon: BarChart3 },
];

export function ManualWorkbench({
  view,
  datasets,
  artifacts,
  busy,
  onSendInstruction,
  onConfirmCheckpoint,
  onApproveTraining,
  onRecover,
}: {
  view: ThetaRunViewV3;
  datasets: DatasetCatalogItem[];
  artifacts: ResultArtifactSummary[];
  busy: boolean;
  onSendInstruction: (content: string) => Promise<void>;
  onConfirmCheckpoint: () => void;
  onApproveTraining: () => void;
  onRecover: (actionId: string) => void;
}) {
  const currentStage = stageForPhase(view.phase);
  const [activeStage, setActiveStage] = useState<ManualStage>(currentStage);

  useEffect(() => {
    setActiveStage(currentStage);
  }, [currentStage, view.runId]);

  const currentIndex = stages.findIndex((stage) => stage.id === currentStage);

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex min-w-[680px] items-center">
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            const completed = index < currentIndex || view.lifecycle === 'completed';
            const current = stage.id === currentStage;
            const selected = stage.id === activeStage;
            return (
              <div key={stage.id} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={() => setActiveStage(stage.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${selected ? 'bg-slate-100 text-slate-950' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${completed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : current ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-400'}`}>
                    {completed ? <Check className="h-4 w-4" /> : current ? <CircleDot className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span className="truncate text-xs font-medium">{stage.label}</span>
                </button>
                {index < stages.length - 1 ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" /> : null}
              </div>
            );
          })}
        </div>
      </div>

      {view.failure ? (
        <FailureCard failure={view.failure} busy={busy} onRecover={onRecover} />
      ) : null}

      <div className="px-4 py-5 sm:px-6">
        {activeStage === 'dataset' ? (
          <DatasetStage
            view={view}
            datasets={datasets}
            busy={busy}
            onSendInstruction={onSendInstruction}
            onConfirmCheckpoint={onConfirmCheckpoint}
          />
        ) : null}
        {activeStage === 'research' ? (
          <ResearchStage
            view={view}
            busy={busy}
            onSendInstruction={onSendInstruction}
            onConfirmCheckpoint={onConfirmCheckpoint}
          />
        ) : null}
        {activeStage === 'plan' ? (
          <PlanStage
            view={view}
            busy={busy}
            onSendInstruction={onSendInstruction}
            onConfirmCheckpoint={onConfirmCheckpoint}
          />
        ) : null}
        {activeStage === 'training' ? (
          <TrainingStage view={view} busy={busy} onApproveTraining={onApproveTraining} />
        ) : null}
        {activeStage === 'results' ? (
          <ResultsStage view={view} artifacts={artifacts} />
        ) : null}
      </div>
    </div>
  );
}

function DatasetStage({ view, datasets, busy, onSendInstruction, onConfirmCheckpoint }: {
  view: ThetaRunViewV3;
  datasets: DatasetCatalogItem[];
  busy: boolean;
  onSendInstruction: (content: string) => Promise<void>;
  onConfirmCheckpoint: () => void;
}) {
  const catalogItem = datasets.find((dataset) => dataset.datasetRef === view.dataset?.datasetRef);
  return (
    <StageShell title="数据管理" icon={Database} status={stageStatus('dataset', view)}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="数据集" value={view.dataset?.fileName ?? catalogItem?.fileName ?? '等待绑定'} />
        <Metric label="数据行数" value={view.dataset ? formatNumber(view.dataset.rowCount) : catalogItem?.rowCount ? formatNumber(catalogItem.rowCount) : '等待分析'} />
        <Metric label="字段数量" value={view.dataset ? formatNumber(view.dataset.columnCount) : catalogItem?.columnCount ? formatNumber(catalogItem.columnCount) : '等待分析'} />
        <Metric label="主要语言" value={view.dataset?.languageSummary ?? catalogItem?.languageSummary ?? '等待识别'} />
      </div>
      {view.checkpoint?.kind === 'dataset' ? (
        <CheckpointCard
          checkpoint={view.checkpoint}
          capabilities={view.capabilities}
          busy={busy}
          dataset={view.dataset}
          research={view.research}
          plan={view.plan}
          onConfirm={onConfirmCheckpoint}
        />
      ) : view.dataset ? (
        <div className="mt-4"><DatasetUnderstandingComplete dataset={view.dataset} /></div>
      ) : (
        <EmptyState label="Agent 正在读取数据集结构。" />
      )}
      <InstructionForm
        title="修订数据理解"
        placeholder="例如：正文列使用 content，时间列使用 created_at，忽略 author_id。"
        busy={busy}
        disabled={!view.capabilities.canSendMessage}
        onSubmit={onSendInstruction}
      />
    </StageShell>
  );
}

function ResearchStage({ view, busy, onSendInstruction, onConfirmCheckpoint }: {
  view: ThetaRunViewV3;
  busy: boolean;
  onSendInstruction: (content: string) => Promise<void>;
  onConfirmCheckpoint: () => void;
}) {
  return (
    <StageShell title="研究设置" icon={FileSearch} status={stageStatus('research', view)}>
      {view.checkpoint?.kind === 'research' ? (
        <CheckpointCard
          checkpoint={view.checkpoint}
          capabilities={view.capabilities}
          busy={busy}
          dataset={view.dataset}
          research={view.research}
          plan={view.plan}
          onConfirm={onConfirmCheckpoint}
        />
      ) : view.research ? (
        <ResearchWorkspace research={view.research} />
      ) : (
        <EmptyState label="研究目标和分析边界尚未形成。" />
      )}
      <InstructionForm
        title="研究目标与约束"
        placeholder="例如：比较不同年份的主题变化，并将可解释性作为主要评价标准。"
        busy={busy}
        disabled={!view.capabilities.canSendMessage}
        onSubmit={onSendInstruction}
      />
    </StageShell>
  );
}

function PlanStage({ view, busy, onSendInstruction, onConfirmCheckpoint }: {
  view: ThetaRunViewV3;
  busy: boolean;
  onSendInstruction: (content: string) => Promise<void>;
  onConfirmCheckpoint: () => void;
}) {
  const plan = view.plan;
  const modelOptions = useMemo(() => {
    const candidates = [plan?.primaryModel, plan?.baselineModel, ...(plan?.alternatives ?? [])]
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return Array.from(new Map(candidates.map((item) => [item.modelId, item])).values());
  }, [plan]);
  const currentTopics = plan?.parameters.find((parameter) => parameter.field === 'num_topics')?.value;
  const [modelId, setModelId] = useState(plan?.primaryModel?.modelId ?? '');
  const [topicCount, setTopicCount] = useState(currentTopics === undefined ? '' : String(currentTopics));
  const [extra, setExtra] = useState('');

  useEffect(() => {
    setModelId(plan?.primaryModel?.modelId ?? '');
    setTopicCount(currentTopics === undefined ? '' : String(currentTopics));
  }, [currentTopics, plan?.candidatePlanHash, plan?.primaryModel?.modelId]);

  const apply = async () => {
    const parts = [
      modelId ? `主要模型设置为 ${modelId}` : '',
      topicCount ? `主题数量设置为 ${topicCount}` : '',
      extra.trim(),
    ].filter(Boolean);
    if (!parts.length) return;
    await onSendInstruction(`请修订当前训练方案：${parts.join('；')}。`);
  };

  return (
    <StageShell title="模型与参数" icon={Settings2} status={stageStatus('plan', view)}>
      {plan ? <PlanDetails plan={plan} /> : <EmptyState label="训练方案尚未生成。" />}
      <div className="mt-5 border-t border-slate-200 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">主要模型</span>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={busy || !modelOptions.length}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            >
              {!modelOptions.length ? <option value="">等待模型推荐</option> : null}
              {modelOptions.map((model) => <option key={model.modelId} value={model.modelId}>{model.displayName ?? model.modelId}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">主题数量</span>
            <Input type="number" min={2} max={200} value={topicCount} onChange={(event) => setTopicCount(event.target.value)} disabled={busy || !plan} />
          </label>
        </div>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium text-slate-600">其他参数要求</span>
          <Textarea value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="可选：填写迭代次数、随机种子或评价方式" disabled={busy || !plan} className="min-h-20" />
        </label>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy || !view.capabilities.canSendMessage || !plan} onClick={() => {
            setModelId(plan?.primaryModel?.modelId ?? '');
            setTopicCount(currentTopics === undefined ? '' : String(currentTopics));
            setExtra('');
          }}><RotateCcw className="h-4 w-4" />重置</Button>
          <Button type="button" disabled={busy || !view.capabilities.canSendMessage || !plan} onClick={() => void apply()}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}应用参数
          </Button>
        </div>
      </div>
      {view.checkpoint?.kind === 'plan' ? (
        <div className="mt-5">
          <CheckpointCard
            checkpoint={view.checkpoint}
            capabilities={view.capabilities}
            busy={busy}
            dataset={view.dataset}
            research={view.research}
            plan={view.plan}
            onConfirm={onConfirmCheckpoint}
          />
        </div>
      ) : null}
    </StageShell>
  );
}

function TrainingStage({ view, busy, onApproveTraining }: {
  view: ThetaRunViewV3;
  busy: boolean;
  onApproveTraining: () => void;
}) {
  return (
    <StageShell title="模型训练" icon={FlaskConical} status={stageStatus('training', view)}>
      {view.training ? (
        <TrainingProgress training={view.training} capabilities={view.capabilities} busy={busy} onApprove={onApproveTraining} />
      ) : (
        <EmptyState label="完成方案确认后将进行 Dry Run 和训练审批。" />
      )}
    </StageShell>
  );
}

function ResultsStage({ view, artifacts }: { view: ThetaRunViewV3; artifacts: ResultArtifactSummary[] }) {
  return (
    <StageShell title="结果分析" icon={BarChart3} status={stageStatus('results', view)}>
      {view.results?.status === 'available' ? (
        <ResultsPanel results={view.results} artifacts={artifacts} />
      ) : (
        <EmptyState label="训练完成后将在这里展示指标、图表和产物。" />
      )}
    </StageShell>
  );
}

export function ManualProjectStart({
  datasets,
  busy,
  onCreate,
}: {
  datasets: DatasetCatalogItem[];
  busy: boolean;
  onCreate: (input: { initialMessage: string; datasetRef?: string }) => Promise<void>;
}) {
  const readyDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.availability === 'ready'),
    [datasets],
  );
  const [datasetRef, setDatasetRef] = useState(readyDatasets[0]?.datasetRef ?? '');
  const [researchGoal, setResearchGoal] = useState('');

  useEffect(() => {
    if (!readyDatasets.some((dataset) => dataset.datasetRef === datasetRef)) {
      setDatasetRef(readyDatasets[0]?.datasetRef ?? '');
    }
  }, [datasetRef, readyDatasets]);

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-140px)] w-full max-w-3xl items-center px-4 py-10 sm:px-8">
      <div className="w-full">
        <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
          <div className="grid h-10 w-10 place-items-center rounded-md border border-blue-200 bg-blue-50 text-blue-700"><Database className="h-5 w-5" /></div>
          <div><h1 className="text-xl font-normal text-slate-950">新建手动研究</h1><p className="mt-1 text-xs text-slate-500">选择数据集并设置研究目标</p></div>
        </div>
        <div className="mt-6 space-y-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">数据集</span>
            <select value={datasetRef} onChange={(event) => setDatasetRef(event.target.value)} disabled={busy || !readyDatasets.length} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100">
              {!readyDatasets.length ? <option value="">暂无可用数据集</option> : null}
              {readyDatasets.map((dataset) => <option key={dataset.datasetRef} value={dataset.datasetRef}>{dataset.fileName} · {formatBytes(dataset.sizeBytes)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">研究目标</span>
            <Textarea value={researchGoal} onChange={(event) => setResearchGoal(event.target.value)} disabled={busy} placeholder="说明分析目标、研究对象和期望结果" className="min-h-32 resize-y" />
          </label>
          <div className="flex justify-end">
            <Button type="button" disabled={busy || !datasetRef || !researchGoal.trim()} onClick={() => void onCreate({ datasetRef, initialMessage: researchGoal })}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}创建并开始
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InstructionForm({ title, placeholder, busy, disabled, onSubmit }: {
  title: string;
  placeholder: string;
  busy: boolean;
  disabled: boolean;
  onSubmit: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const submit = async () => {
    const content = value.trim();
    if (!content || busy || disabled) return;
    await onSubmit(content);
    setValue('');
  };
  return (
    <div className="mt-5 border-t border-slate-200 pt-5">
      <label><span className="mb-1.5 block text-xs font-medium text-slate-600">{title}</span><Textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} disabled={busy || disabled} className="min-h-24 resize-y" /></label>
      <div className="mt-3 flex justify-end"><Button type="button" disabled={busy || disabled || !value.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}提交设置</Button></div>
    </div>
  );
}

function StageShell({ title, icon: Icon, status, children }: { title: string; icon: typeof Database; status: string; children: ReactNode }) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 bg-slate-50 text-slate-700"><Icon className="h-4 w-4" /></div><h2 className="text-base font-medium text-slate-950">{title}</h2></div>
        <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">{status}</span>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="border-l-2 border-slate-200 px-3 py-1"><p className="text-[11px] text-slate-500">{label}</p><p className="mt-1 truncate text-sm font-medium text-slate-900">{value}</p></div>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="grid min-h-32 place-items-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 text-center text-sm text-slate-500">{label}</div>;
}

const stageForPhase = (phase: RunPhase): ManualStage => ({
  intake: 'dataset',
  dataset_understanding: 'dataset',
  research_dialogue: 'research',
  plan_design: 'plan',
  plan_confirmation: 'plan',
  dry_run: 'training',
  training_confirmation: 'training',
  training: 'training',
  result_analysis: 'results',
  completed: 'results',
  recovery: 'training',
})[phase] as ManualStage;

const stageStatus = (stage: ManualStage, view: ThetaRunViewV3): string => {
  const active = stageForPhase(view.phase);
  const stageIndex = stages.findIndex((item) => item.id === stage);
  const activeIndex = stages.findIndex((item) => item.id === active);
  if (view.lifecycle === 'completed' || stageIndex < activeIndex) return '已完成';
  if (stage === active) return view.interaction.expectsUserInput ? '等待操作' : '进行中';
  return '未开始';
};

const formatNumber = (value: number): string => new Intl.NumberFormat('zh-CN').format(value);
const formatBytes = (value: number): string => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
