import { Check, Clock3, Cpu, FlaskConical, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { RunCapabilities, TrainingView } from '@/lib/api/v3';

export function TrainingProgress({
  training,
  capabilities,
  busy,
  onApprove,
}: {
  training: TrainingView;
  capabilities: RunCapabilities;
  busy: boolean;
  onApprove: () => void;
}) {
  const progress = training.progress;
  const canApprove = capabilities.canApproveTraining && Boolean(training.dryRunHash);

  return (
    <section className="border-b border-slate-200 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-blue-200 bg-blue-50 text-blue-700">
            {training.status === 'completed' ? <Check className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}
          </div>
          <div>
            <p className="text-xs font-medium text-blue-700">训练运行时</p>
            <h2 className="mt-0.5 text-base font-semibold text-slate-950">{training.stage.label}</h2>
            {training.stage.detail ? <p className="mt-1 text-sm leading-6 text-slate-600">{training.stage.detail}</p> : null}
          </div>
        </div>
        <Badge variant="outline" className={statusPresentation[training.status].className}>
          {statusPresentation[training.status].label}
        </Badge>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-slate-700">{progress.label}</span>
          <span className="text-slate-500">{progress.indeterminate || progress.percent === null ? '进度未知' : `${progress.percent}%`}</span>
        </div>
        {progress.indeterminate || progress.percent === null ? (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-500" />
          </div>
        ) : (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
        )}
        {progress.detail ? <p className="mt-2 text-xs leading-5 text-slate-500">{progress.detail}</p> : null}
      </div>

      {canApprove ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <div>
                <p className="text-sm font-semibold text-amber-950">Dry Run 已通过，训练尚未开始</p>
                <p className="mt-1 text-xs leading-5 text-amber-800">批准操作只绑定当前 Dry Run 和 canonical Plan。</p>
                <p className="mt-1 break-all font-mono text-[10px] text-amber-700">{training.dryRunHash}</p>
              </div>
            </div>
            <Button type="button" disabled={busy} onClick={onApprove}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              批准并启动训练
            </Button>
          </div>
        </div>
      ) : null}

      {training.experiments.length ? (
        <div className="mt-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><FlaskConical className="h-3.5 w-3.5" />分实验</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {training.experiments.map((experiment) => (
              <div key={experiment.experimentId} className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-medium text-slate-900">{experiment.modelId}</p>
                  <span className="text-[10px] text-slate-400">seed {experiment.seed ?? '-'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>{experimentStatusLabel(experiment.status)}</span>
                  <span>{experiment.percent === null ? '未知' : `${experiment.percent}%`}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {training.recentNotices.length ? (
        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{training.recentNotices.at(-1)}</span>
        </div>
      ) : null}
    </section>
  );
}

const statusPresentation: Record<TrainingView['status'], { label: string; className: string }> = {
  not_started: { label: '未开始', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  queued: { label: '排队中', className: 'border-slate-200 bg-slate-50 text-slate-600' },
  running: { label: '训练中', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  evaluating: { label: '评价中', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  visualizing: { label: '生成图表', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  completed: { label: '已完成', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  failed: { label: '失败', className: 'border-red-200 bg-red-50 text-red-700' },
  cancelled: { label: '已取消', className: 'border-slate-200 bg-slate-50 text-slate-600' },
};

const experimentStatusLabel = (status: string): string => ({
  pending: '等待', running: '运行中', completed: '完成', failed: '失败',
}[status] ?? status);
