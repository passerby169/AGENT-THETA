'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  FileCheck2,
  FileCog,
  ImageIcon,
  Play,
  Settings2,
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type {
  ThetaPlan,
  ThetaRunResults,
  ThetaRunStatus,
  ThetaRunSummary,
  ThetaRunTimeline,
} from '@/lib/api/theta-agent-v2';

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
  if (state === 'ResearchClarification') return 'data';
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
}: {
  run?: ThetaRunSummary;
  status: ThetaRunStatus;
  timeline?: ThetaRunTimeline;
  plan?: ThetaPlan;
  results?: ThetaRunResults;
  resultsLoading: boolean;
  assistant: ReactNode;
  assistantExpanded: boolean;
}) {
  const currentStage = stateStage(status.currentState);
  const [activeStage, setActiveStage] = useState<ClassicStage>(currentStage);

  useEffect(() => {
    setActiveStage(currentStage);
  }, [currentStage, status.runId]);

  const currentIndex = stages.findIndex((stage) => stage.id === currentStage);
  const trainingProgress = Math.round(timeline?.training?.progress ?? status.trainingReceipt?.progress ?? 0);
  const modelId = run?.identity?.modelId ?? plan?.validatedPlan?.modelId ?? plan?.candidatePlan?.modelId;
  const topicCount = run?.identity?.numTopics
    ?? plan?.validatedPlan?.numTopics
    ?? plan?.validatedPlan?.parameters?.numTopics
    ?? plan?.candidatePlan?.numTopics
    ?? plan?.candidatePlan?.parameters?.numTopics;
  const metrics = useMemo(() => Object.entries(results?.metrics ?? {}).slice(0, 8), [results?.metrics]);

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

      <div className={`grid grid-cols-1 items-start transition-[grid-template-columns,gap,margin] duration-500 ease-in-out lg:grid-cols-[minmax(0,1fr)_minmax(340px,390px)] ${assistantExpanded ? 'mt-0 gap-0 lg:grid-cols-[0fr_minmax(0,1fr)]' : 'mt-4 gap-4'}`}>
        <div className={`min-w-0 overflow-hidden transition-[opacity,transform] duration-500 ease-in-out ${assistantExpanded ? 'pointer-events-none -translate-x-6 opacity-0' : 'translate-x-0 space-y-4 opacity-100'}`} aria-hidden={assistantExpanded}>
          <div className="rounded-md border border-slate-200 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600">THETA 一代工作台视图</p>
                <h2 className="mt-1 text-xl font-semibold text-slate-900">{stages.find((stage) => stage.id === activeStage)?.label}</h2>
                <p className="mt-2 text-sm text-slate-500">界面可以自由查看；实际进度、审批和训练仍由当前 Hypha Run 统一管理。</p>
              </div>
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">同一任务 · 实时同步</span>
            </div>

            {activeStage === 'data' ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <ClassicInfo label="数据集" value={run?.identity?.datasetName ?? '当前本地数据集'} />
                <ClassicInfo label="记录事件" value={Number.isFinite(status.eventCount) ? `${status.eventCount} 个` : '正在同步'} />
                <div className="rounded-md border border-slate-200 p-4 sm:col-span-2">
                  <p className="text-xs font-medium text-slate-500">研究目标</p>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{cleanResearchQuestion(run?.identity?.researchQuestion) ?? status.researchBrief?.researchQuestion ?? status.presentation.summary}</p>
                </div>
              </div>
            ) : null}

            {activeStage === 'cleaning' ? (
              <div className="mt-5 space-y-4">
                <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-4">
                  <p className="text-sm font-semibold text-blue-900">数据检查与列角色</p>
                  <p className="mt-1 text-xs leading-5 text-blue-800">正文、时间、ID 和元数据列的确认结果记录在当前 Run 中。需要补充时，请在右侧助手完成当前操作。</p>
                </div>
                <ClassicInfo label="当前 FSM 状态" value={status.currentState ?? status.status} />
              </div>
            ) : null}

            {activeStage === 'parameters' ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <ClassicInfo label="模型" value={modelId?.toUpperCase() ?? '等待推荐'} />
                <ClassicInfo label="主题数量" value={topicCount === undefined || topicCount === null ? '等待确认' : `${topicCount} 个`} />
                <div className="rounded-md bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600 sm:col-span-2">{plan?.presentation.summary ?? '模型建议生成后会在这里同步展示。方案审批仍在右侧完成。'}</div>
              </div>
            ) : null}

            {activeStage === 'training' ? (
              <div className="mt-5 space-y-4">
                <div className="flex items-end justify-between gap-4"><div><p className="text-xs font-medium text-slate-500">真实训练进度</p><p className="mt-1 text-3xl font-semibold text-slate-900">{trainingProgress}%</p></div><p className="text-xs text-slate-500">{status.trainingReceipt?.currentStep ?? '等待进入训练阶段'}</p></div>
                <Progress value={trainingProgress} className="h-2" />
                <div className="grid gap-4 sm:grid-cols-2"><ClassicInfo label="训练 ID" value={status.trainingReceipt?.trainingRunId ?? '尚未分配'} /><ClassicInfo label="运行状态" value={status.trainingReceipt?.status ?? status.status} /></div>
                <div className="max-h-40 overflow-y-auto rounded-md bg-slate-950 px-4 py-3 font-mono text-[11px] leading-5 text-slate-300">{timeline?.logs.length ? timeline.logs.slice(-12).map((line, index) => <p key={`${index}-${line}`} className="break-all">{line}</p>) : <p>训练日志将在任务启动后显示。</p>}</div>
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

        <aside className={`min-w-0 transition-[transform,width] duration-500 ease-in-out ${assistantExpanded ? 'translate-x-0' : 'lg:sticky lg:top-20'}`}>
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
