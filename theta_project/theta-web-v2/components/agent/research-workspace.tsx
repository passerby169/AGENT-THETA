import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  GitCompareArrows,
  Lightbulb,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ResearchWorkspaceSummary } from '@/lib/api/v3';

export function ResearchWorkspace({
  research,
  checkpointMode = false,
}: {
  research: ResearchWorkspaceSummary;
  checkpointMode?: boolean;
}) {
  return (
    <section className={checkpointMode ? 'mt-4' : 'border-b border-slate-200 px-4 py-5 sm:px-5'}>
      {!checkpointMode ? (
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-sky-200 bg-sky-50 text-sky-700">
            <Lightbulb className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-medium text-sky-700">研究工作区</p>
            <h2 className="mt-0.5 text-base font-semibold text-slate-950">当前研究理解</h2>
          </div>
        </div>
      ) : null}

      <p className={`${checkpointMode ? '' : 'mt-4'} text-sm leading-6 text-slate-700`}>
        {research.narrative}
      </p>

      <div className="mt-4 space-y-2">
        {research.statements.map((statement) => {
          const presentation = statementPresentation[statement.status];
          const Icon = presentation.icon;
          return (
            <div key={statement.id} className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2.5">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${presentation.iconClass}`} />
              <p className="min-w-0 flex-1 text-sm leading-5 text-slate-800">{statement.text}</p>
              <Badge variant="outline" className={presentation.badgeClass}>{presentation.label}</Badge>
            </div>
          );
        })}
      </div>

      {research.assumptions.length || research.contradictions.length ? (
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          {research.assumptions.length ? (
            <ResearchList
              icon={CircleHelp}
              title="待验证假设"
              items={research.assumptions}
              className="border-slate-200 bg-slate-50 text-slate-700"
            />
          ) : null}
          {research.contradictions.length ? (
            <ResearchList
              icon={GitCompareArrows}
              title="当前矛盾"
              items={research.contradictions}
              className="border-amber-200 bg-amber-50 text-amber-900"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ResearchCheckpointSections({
  research,
}: {
  research?: ResearchWorkspaceSummary;
}) {
  if (!research) {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        当前检查点未包含研究工作区摘要，请刷新后重试。
      </div>
    );
  }
  return <ResearchWorkspace research={research} checkpointMode />;
}

function ResearchList({
  icon: Icon,
  title,
  items,
  className,
}: {
  icon: typeof CircleHelp;
  title: string;
  items: string[];
  className: string;
}) {
  return (
    <div className={`rounded-md border px-3 py-2.5 ${className}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold"><Icon className="h-3.5 w-3.5" />{title}</p>
      <ul className="mt-2 space-y-1 text-xs leading-5">
        {items.map((item) => <li key={item}>· {item}</li>)}
      </ul>
    </div>
  );
}

const statementPresentation: Record<
  ResearchWorkspaceSummary['statements'][number]['status'],
  { label: string; icon: typeof CheckCircle2; iconClass: string; badgeClass: string }
> = {
  confirmed: {
    label: '已确认',
    icon: CheckCircle2,
    iconClass: 'text-emerald-600',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  inferred: {
    label: '推断',
    icon: Lightbulb,
    iconClass: 'text-sky-600',
    badgeClass: 'border-sky-200 bg-sky-50 text-sky-700',
  },
  uncertain: {
    label: '不确定',
    icon: CircleHelp,
    iconClass: 'text-amber-600',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  contradicted: {
    label: '有矛盾',
    icon: GitCompareArrows,
    iconClass: 'text-red-600',
    badgeClass: 'border-red-200 bg-red-50 text-red-700',
  },
};
