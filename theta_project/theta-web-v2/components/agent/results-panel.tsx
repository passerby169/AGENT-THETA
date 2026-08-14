import { BarChart3, Download, FileJson, FileText, ImageIcon, Table2 } from 'lucide-react';
import type { ResultArtifactSummary, ResultAvailabilitySummary } from '@/lib/api/v3';

export function ResultsPanel({ results, artifacts }: {
  results: ResultAvailabilitySummary;
  artifacts: ResultArtifactSummary[];
}) {
  return (
    <section className="border-b border-slate-200 px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700">
          <BarChart3 className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs font-medium text-emerald-700">结果可用</p>
          <h2 className="mt-0.5 text-base font-semibold text-slate-950">研究 Artifact</h2>
          <p className="mt-1 text-sm text-slate-600">共 {results.artifactCount} 个受控结果文件，可在右侧继续询问结果。</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {artifacts.map((artifact) => {
          const Icon = artifactIcon(artifact.kind);
          return (
            <a
              key={artifact.artifactId}
              href={artifact.contentUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-start gap-3 rounded-md border border-slate-200 bg-white px-3 py-3 transition-colors hover:bg-slate-50"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{artifact.name}</p>
                <p className="mt-1 text-[11px] text-slate-400">{artifact.mimeType} · {formatBytes(artifact.sizeBytes)}</p>
              </div>
              <Download className="h-4 w-4 shrink-0 text-slate-400" />
            </a>
          );
        })}
      </div>
    </section>
  );
}

const artifactIcon = (kind: ResultArtifactSummary['kind']) => ({
  report: FileText,
  table: Table2,
  image: ImageIcon,
  interactive: BarChart3,
  model: FileJson,
  log: FileText,
})[kind];

const formatBytes = (value: number): string => value >= 1024 ** 2
  ? `${(value / 1024 ** 2).toFixed(1)} MB`
  : `${(value / 1024).toFixed(1)} KB`;
