'use client';

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  FlaskConical,
  History,
  RefreshCw,
  ServerCog,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type HealthStatus = 'ready' | 'degraded' | 'blocked';

interface DoctorCheck {
  id: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  remediation?: string;
}

interface Health {
  status: HealthStatus;
  checkedAt: string;
  checks: DoctorCheck[];
}

interface RunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
  recoveryOfRunId?: string;
  successorRunId?: string;
}

interface RunStatus {
  runId: string;
  status: string;
  currentState?: string;
  pendingReason?: string;
  eventCount: number;
  lastEventType: string;
  lastEventAt: string;
  statePath: string[];
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const apiGet = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`/api/agent/${path}`, { cache: 'no-store' });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? 'THETA Agent API 请求失败。');
  }
  return payload.data;
};

export default function ThetaWorkbench() {
  const [health, setHealth] = useState<Health>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedStatus, setSelectedStatus] = useState<RunStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextHealth, runData] = await Promise.all([
        apiGet<Health>('health'),
        apiGet<{ runs: RunSummary[] }>('runs?limit=30'),
      ]);
      setHealth(nextHealth);
      setRuns(runData.runs);
      setSelectedRunId((current) => current ?? runData.runs[0]?.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedStatus(undefined);
      return;
    }
    void apiGet<RunStatus>(`runs/${encodeURIComponent(selectedRunId)}/status`)
      .then(setSelectedStatus)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [selectedRunId]);

  const healthCounts = useMemo(() => ({
    pass: health?.checks.filter((check) => check.status === 'PASS').length ?? 0,
    warn: health?.checks.filter((check) => check.status === 'WARN').length ?? 0,
    fail: health?.checks.filter((check) => check.status === 'FAIL').length ?? 0,
  }), [health]);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">Θ</span>
          <span><strong>THETA 2.0</strong><small>研究训练 Agent</small></span>
        </div>
        <nav aria-label="主导航">
          <button className="navItem active" type="button"><Activity size={18} />运行总览</button>
          <button className="navItem" type="button" disabled><Database size={18} />数据集</button>
          <button className="navItem" type="button" disabled><FlaskConical size={18} />训练计划</button>
          <button className="navItem" type="button" disabled><FileText size={18} />分析结果</button>
        </nav>
        <div className="sidebarFoot">
          <span className={`statusDot ${health?.status ?? 'blocked'}`} />
          <span>Hypha Runtime<br /><small>{statusLabel(health?.status)}</small></span>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL RESEARCH WORKSPACE</p>
            <h1>运行总览</h1>
            <p>所有状态均来自 Hypha 事件投影，网页不保存独立运行状态。</p>
          </div>
          <button className="iconButton" type="button" onClick={() => void refresh()} disabled={loading} title="刷新运行状态">
            <RefreshCw size={19} className={loading ? 'spinning' : undefined} />
          </button>
        </header>

        {error ? (
          <div className="errorBanner" role="alert">
            <AlertTriangle size={18} />
            <span><strong>连接失败</strong>{error}</span>
          </div>
        ) : null}

        <section className="metrics" aria-label="系统摘要">
          <article><span>Agent 状态</span><strong>{statusLabel(health?.status)}</strong><small>{health?.checkedAt ? formatDate(health.checkedAt) : '等待检查'}</small></article>
          <article><span>环境检查</span><strong>{healthCounts.pass} 项通过</strong><small>{healthCounts.warn} 项提醒 · {healthCounts.fail} 项阻塞</small></article>
          <article><span>本地任务</span><strong>{runs.length} 个 Run</strong><small>由 Event Store 读取</small></article>
          <article><span>当前阶段</span><strong>{selectedStatus?.currentState ?? '未选择'}</strong><small>{selectedStatus?.status ?? '选择任务查看'}</small></article>
        </section>

        <div className="workspaceGrid">
          <section className="runPanel">
            <div className="sectionHeading">
              <div><p className="eyebrow">PERSISTED RUNS</p><h2>研究任务</h2></div>
              <span>{runs.length}</span>
            </div>
            <div className="runList">
              {runs.length === 0 && !loading ? <p className="empty">暂无持久化任务。请先通过 CLI 创建 Run。</p> : null}
              {runs.map((run) => (
                <button
                  className={`runRow ${selectedRunId === run.runId ? 'selected' : ''}`}
                  key={run.runId}
                  onClick={() => setSelectedRunId(run.runId)}
                  type="button"
                >
                  <span className="runIcon"><History size={18} /></span>
                  <span className="runText"><strong>{run.runId}</strong><small>{formatDate(run.updatedAt)} · {run.eventCount} 个事件</small></span>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
          </section>

          <section className="detailPanel">
            <div className="sectionHeading">
              <div><p className="eyebrow">EVENT-DERIVED STATUS</p><h2>任务状态</h2></div>
              <span className="readOnly">只读预览</span>
            </div>
            {selectedStatus ? (
              <div className="detailBody">
                <div className="runTitle"><span className="runIcon large"><ServerCog size={22} /></span><div><strong>{selectedStatus.runId}</strong><small>{selectedStatus.lastEventType}</small></div></div>
                <dl className="statusGrid">
                  <div><dt>运行状态</dt><dd>{selectedStatus.status}</dd></div>
                  <div><dt>当前 FSM 状态</dt><dd>{selectedStatus.currentState ?? '无'}</dd></div>
                  <div><dt>事件数量</dt><dd>{selectedStatus.eventCount}</dd></div>
                  <div><dt>最后更新</dt><dd>{formatDate(selectedStatus.lastEventAt)}</dd></div>
                </dl>
                {selectedStatus.pendingReason ? <div className="notice"><Clock3 size={18} /><span><strong>等待处理</strong>{selectedStatus.pendingReason}</span></div> : null}
                <div className="statePath"><h3>FSM 路径</h3><ol>{selectedStatus.statePath.map((state, index) => <li key={`${state}-${index}`}><CheckCircle2 size={16} /><span>{state}</span></li>)}</ol></div>
              </div>
            ) : <p className="empty">从左侧选择一个任务查看事件派生状态。</p>}
          </section>
        </div>
      </section>
    </main>
  );
}

const statusLabel = (status?: HealthStatus): string => {
  if (status === 'ready') return '正常';
  if (status === 'degraded') return '可运行，有提醒';
  if (status === 'blocked') return '需要处理';
  return '检查中';
};

const formatDate = (value: string): string => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(value));
