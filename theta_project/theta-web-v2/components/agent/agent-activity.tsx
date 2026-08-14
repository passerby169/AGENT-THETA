import { Activity, BrainCircuit, CircleDashed, Hammer, LoaderCircle } from 'lucide-react';
import type { RunActivity, RunProgress } from '@/lib/api/v3';

export function AgentActivity({ activity, progress }: { activity: RunActivity; progress: RunProgress }) {
  const Icon = activity.kind === 'tool_calling'
    ? Hammer
    : activity.kind === 'agent_reasoning'
      ? BrainCircuit
      : activity.kind === 'idle' || activity.kind === 'waiting_user'
        ? CircleDashed
        : LoaderCircle;
  const animated = !['idle', 'waiting_user'].includes(activity.kind);

  return (
    <section className="border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-blue-200 bg-blue-50 text-blue-700">
          <Icon className={`h-4 w-4 ${animated ? 'animate-pulse' : ''}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{activity.label}</p>
            <span className="text-xs text-slate-500">{progress.label}</span>
          </div>
          {activity.detail ? <p className="mt-1 text-xs leading-5 text-slate-600">{activity.detail}</p> : null}
          {activity.tool ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
              <Activity className="h-3.5 w-3.5" />
              {activity.tool.displayName} · {activity.tool.safePurpose}
            </p>
          ) : null}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full bg-blue-600 ${progress.indeterminate ? 'w-1/3 animate-pulse' : ''}`}
              style={progress.indeterminate ? undefined : { width: `${progress.percent ?? 0}%` }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
