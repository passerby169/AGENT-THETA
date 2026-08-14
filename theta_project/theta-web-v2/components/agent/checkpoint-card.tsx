import { AlertTriangle, Check, Database, FileCheck2, MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type {
  ConversationalCheckpointView,
  DatasetWorkspaceSummary,
  ResearchWorkspaceSummary,
  PlanCandidateView,
  RunCapabilities,
} from '@/lib/api/v3';
import { DatasetCheckpointContent } from './dataset-checkpoint-content';
import { ResearchCheckpointSections } from './research-workspace';
import { PlanDetails } from './plan-details';

export function CheckpointCard({
  checkpoint,
  capabilities,
  busy,
  dataset,
  research,
  plan,
  onConfirm,
}: {
  checkpoint: ConversationalCheckpointView;
  capabilities: RunCapabilities;
  busy: boolean;
  dataset?: DatasetWorkspaceSummary;
  research?: ResearchWorkspaceSummary;
  plan?: PlanCandidateView;
  onConfirm: () => void;
}) {
  const Icon = checkpoint.kind === 'dataset'
    ? Database
    : checkpoint.kind === 'plan'
      ? FileCheck2
      : MessageSquareText;
  const canConfirm = (checkpoint.kind === 'plan'
    ? capabilities.canApprovePlan
    : capabilities.canConfirmCheckpoint) && checkpoint.allowedActions.includes('confirm');

  return (
    <section className="border-b border-slate-200 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-950">{checkpoint.title}</h2>
              <Badge variant="outline">版本 {checkpoint.revision}</Badge>
              {checkpoint.mandatory ? <Badge className="bg-amber-100 text-amber-800">必须确认</Badge> : null}
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">{checkpoint.summary}</p>
          </div>
        </div>
        {checkpoint.status === 'confirmed' ? (
          <Badge className="bg-emerald-100 text-emerald-800"><Check className="h-3 w-3" />已确认</Badge>
        ) : null}
      </div>

      {checkpoint.kind === 'dataset' ? (
        <DatasetCheckpointContent dataset={dataset} sections={checkpoint.sections} />
      ) : checkpoint.kind === 'research' ? (
        <ResearchCheckpointSections research={research} />
      ) : checkpoint.kind === 'plan' && plan ? (
        <PlanDetails plan={plan} />
      ) : (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {checkpoint.sections.map((section) => (
            <div key={section.id} className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-semibold text-slate-500">{section.title}</p>
              <SectionContent value={section.content} />
            </div>
          ))}
        </div>
      )}

      {checkpoint.assumptions.length || checkpoint.warnings.length ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {checkpoint.assumptions.length ? (
            <FactList title="当前假设" items={checkpoint.assumptions} />
          ) : null}
          {checkpoint.warnings.length ? (
            <FactList title="需要注意" items={checkpoint.warnings} warning />
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs leading-5 text-slate-500">有疑问或需要修改时，请在右侧直接输入自然语言。确认操作只确认当前版本。</p>
        {canConfirm ? (
          <Button type="button" disabled={busy} onClick={onConfirm} className="bg-emerald-600 hover:bg-emerald-700">
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Check className="h-4 w-4" />}
            {checkpoint.kind === 'plan' ? '批准当前方案' : '确认当前版本'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SectionContent({ value }: { value: unknown }) {
  if (typeof value === 'string') return <p className="mt-1.5 text-sm leading-6 text-slate-800">{value}</p>;
  if (Array.isArray(value)) {
    return <ul className="mt-2 space-y-1 text-sm text-slate-700">{value.map((item, index) => <li key={index}>· {String(item)}</li>)}</ul>;
  }
  if (value && typeof value === 'object') {
    return (
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
        {Object.entries(value).map(([key, item]) => (
          <div key={key} className="contents">
            <dt className="truncate text-slate-500">{factLabel(key)}</dt>
            <dd className="text-right font-medium text-slate-900">{String(item)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="mt-1.5 text-sm text-slate-500">暂无可展示内容</p>;
}

function FactList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) {
  return (
    <div className={`rounded-md border px-4 py-3 ${warning ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <p className={`flex items-center gap-1.5 text-xs font-semibold ${warning ? 'text-amber-800' : 'text-slate-600'}`}>
        {warning ? <AlertTriangle className="h-3.5 w-3.5" /> : null}{title}
      </p>
      <ul className="mt-2 space-y-1 text-sm leading-5 text-slate-700">
        {items.map((item) => <li key={item}>· {item}</li>)}
      </ul>
    </div>
  );
}

const factLabel = (key: string): string => ({
  rows: '数据行数',
  columns: '字段数量',
  primaryTextColumn: '主要文本列',
}[key] ?? key);
