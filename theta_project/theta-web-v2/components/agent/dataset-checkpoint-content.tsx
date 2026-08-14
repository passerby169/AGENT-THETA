import { AlertTriangle, CheckCircle2, Database, Languages, Rows3 } from 'lucide-react';
import type {
  CheckpointSection,
  DatasetWorkspaceSummary,
} from '@/lib/api/v3';

export function DatasetCheckpointContent({
  dataset,
  sections,
}: {
  dataset?: DatasetWorkspaceSummary;
  sections: CheckpointSection[];
}) {
  return (
    <div className="mt-4 space-y-3">
      {dataset ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Metric icon={Rows3} label="数据行数" value={formatNumber(dataset.rowCount)} />
          <Metric icon={Database} label="字段数量" value={formatNumber(dataset.columnCount)} />
          <Metric icon={Languages} label="主要语言" value={dataset.languageSummary ?? '待识别'} />
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        {sections.map((section) => (
          <section key={section.id} className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-600">{section.title}</p>
              <span className="text-[10px] text-slate-400">{sectionKindLabel(section.kind)}</span>
            </div>
            <DatasetSectionValue value={section.content} />
            {section.provenance?.length ? (
              <p className="mt-2 text-[11px] text-slate-400">
                来源：{section.provenance.map((item) => item.label).join('、')}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

export function DatasetUnderstandingComplete({ dataset }: { dataset: DatasetWorkspaceSummary }) {
  return (
    <section className="border-b border-slate-200 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-950">数据理解已完成，无需额外确认</p>
          <p className="mt-1 text-xs leading-5 text-emerald-800">
            {dataset.fileName} · {formatNumber(dataset.rowCount)} 行 · {formatNumber(dataset.columnCount)} 个字段
            {dataset.languageSummary ? ` · ${dataset.languageSummary}` : ''}
          </p>
          {dataset.qualityWarnings.length ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {dataset.qualityWarnings.join('；')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Database;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <Icon className="h-3.5 w-3.5" />{label}
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function DatasetSectionValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return <p className="mt-1.5 text-sm leading-6 text-slate-800">{value}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="mt-2 space-y-1 text-sm leading-5 text-slate-700">
        {value.map((item, index) => <li key={index}>· {String(item)}</li>)}
      </ul>
    );
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

const formatNumber = (value: number): string => new Intl.NumberFormat('zh-CN').format(value);

const sectionKindLabel = (kind: CheckpointSection['kind']): string => ({
  text: '说明',
  facts: '事实',
  list: '列表',
  table: '表格',
  decision: '判断',
  warning: '提醒',
})[kind];

const factLabel = (key: string): string => ({
  rows: '数据行数',
  columns: '字段数量',
  primaryTextColumn: '主要文本列',
  analysisUnit: '分析单位',
  direction: '分析方向',
}[key] ?? key);
