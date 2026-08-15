import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Cpu,
  FileOutput,
  FlaskConical,
  Lightbulb,
  MemoryStick,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { PlanCandidateView } from '@/lib/api/v3';

export function PlanDetails({ plan }: { plan: PlanCandidateView }) {
  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 xl:grid-cols-2">
        <ModelDecision title="主要模型" model={plan.primaryModel} primary />
        <ModelDecision title="对照模型" model={plan.baselineModel} />
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-600">参数与来源</p>
        <div className="mt-2 overflow-x-auto rounded-md border border-slate-200">
          <div className="grid min-w-[640px] grid-cols-[minmax(110px,0.7fr)_minmax(90px,0.5fr)_minmax(90px,0.5fr)_minmax(180px,1.4fr)] bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
            <span>参数</span><span>值</span><span>来源</span><span>依据</span>
          </div>
          {plan.parameters.map((parameter) => (
            <div key={parameter.field} className="grid min-w-[640px] grid-cols-[minmax(110px,0.7fr)_minmax(90px,0.5fr)_minmax(90px,0.5fr)_minmax(180px,1.4fr)] border-t border-slate-100 px-3 py-2.5 text-xs">
              <span className="truncate font-medium text-slate-900">{parameterLabel(parameter.field)}</span>
              <span className="truncate font-mono text-slate-700">{String(parameter.value)}</span>
              <span><Badge variant="outline" className={sourcePresentation[parameter.source].className}>{sourcePresentation[parameter.source].label}</Badge></span>
              <span className="leading-5 text-slate-500">{parameter.rationale}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {plan.experiment ? (
          <Metric icon={FlaskConical} label="实验设计" value={`${plan.experiment.runCount} 次运行`} detail={`${plan.experiment.mode} · seeds ${plan.experiment.seeds.join(', ')}`} />
        ) : null}
        {plan.resources?.estimatedMinutes !== undefined ? (
          <Metric icon={Clock3} label="预计耗时" value={`${plan.resources.estimatedMinutes} 分钟`} detail={plan.resources.notes[0]} />
        ) : null}
        {plan.resources?.cpuCores !== undefined ? (
          <Metric icon={Cpu} label="计算资源" value={`${plan.resources.cpuCores} CPU`} detail={plan.resources.accelerator ?? '无需加速器'} />
        ) : null}
        {plan.resources?.memoryGb !== undefined ? (
          <Metric icon={MemoryStick} label="内存" value={`${plan.resources.memoryGb} GB`} />
        ) : null}
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <DetailList title="预处理" items={plan.preprocessing} />
        <DetailList title="评价方式" items={plan.evaluation} icon={Scale} />
        <DetailList title="预期产出" items={plan.expectedOutputs} icon={FileOutput} />
      </div>

      {plan.alternatives?.length ? (
        <div>
          <p className="text-xs font-semibold text-slate-600">替代方案</p>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {plan.alternatives.map((alternative) => (
              <div key={alternative.modelId} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                <p className="text-sm font-medium text-slate-900">{alternative.displayName ?? alternative.modelId}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{alternative.tradeoff}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {plan.evidence?.length ? (
        <div>
          <p className="text-xs font-semibold text-slate-600">方案依据</p>
          <div className="mt-2 space-y-2">
            {plan.evidence.map((item) => (
              <div key={item.refId} className="flex items-start gap-2 rounded-md border border-slate-200 px-3 py-2.5">
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                <div>
                  <p className="text-xs font-medium text-slate-900">{item.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500">{item.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ValidationStatus plan={plan} />
    </div>
  );
}

function ModelDecision({
  title,
  model,
  primary = false,
}: {
  title: string;
  model?: PlanCandidateView['primaryModel'];
  primary?: boolean;
}) {
  return (
    <div className={`rounded-md border px-4 py-3 ${primary ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
      <p className={`text-xs font-medium ${primary ? 'text-blue-700' : 'text-slate-500'}`}>{title}</p>
      {model ? <>
        <p className="mt-1 text-sm font-semibold text-slate-950">{model.displayName ?? model.modelId}</p>
        <p className="mt-1 text-xs leading-5 text-slate-600">{model.rationale}</p>
      </> : <p className="mt-1 text-sm text-slate-400">未设置</p>}
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><Icon className="h-3.5 w-3.5" />{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
      {detail ? <p className="mt-1 truncate text-[11px] text-slate-400">{detail}</p> : null}
    </div>
  );
}

function DetailList({ title, items, icon: Icon = CheckCircle2 }: { title: string; items?: string[]; icon?: typeof CheckCircle2 }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
      <p className="text-xs font-semibold text-slate-600">{title}</p>
      {items?.length ? (
        <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-700">
          {items.map((item) => <li key={item} className="flex items-start gap-1.5"><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />{item}</li>)}
        </ul>
      ) : <p className="mt-2 text-xs text-slate-400">暂无</p>}
    </div>
  );
}

function ValidationStatus({ plan }: { plan: PlanCandidateView }) {
  const validation = plan.validation;
  if (!validation || plan.status === 'validating') {
    return <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-800">Validator 正在检查模型、参数、资源与运行条件。</div>;
  }
  return (
    <div className={`rounded-md border px-3 py-3 ${validation.valid ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
      <p className={`flex items-center gap-1.5 text-xs font-semibold ${validation.valid ? 'text-emerald-800' : 'text-red-800'}`}>
        {validation.valid ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {validation.valid ? 'Validator 已通过' : 'Validator 未通过'}
      </p>
      {validation.issues.length ? (
        <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-700">
          {validation.issues.map((issue) => <li key={issue.code}>· {issue.message}</li>)}
        </ul>
      ) : <p className="mt-1 text-xs text-emerald-700">当前方案满足执行约束。</p>}
    </div>
  );
}

const sourcePresentation: Record<PlanCandidateView['parameters'][number]['source'], { label: string; className: string }> = {
  agent: { label: 'Agent', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  user: { label: '用户', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  validator_default: { label: 'Validator', className: 'border-amber-200 bg-amber-50 text-amber-700' },
};

const parameterLabel = (field: string): string => ({
  num_topics: '主题数量',
  iterations: '迭代次数',
  min_document_frequency: '最小文档频率',
}[field] ?? field);
