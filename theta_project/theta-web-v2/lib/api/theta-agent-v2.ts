export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface ThetaHealth {
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: Array<{
    id: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    remediation?: string;
  }>;
}

export interface ThetaRunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
  recoveryOfRunId?: string;
  successorRunId?: string;
}

export interface ThetaRunStatus {
  runId: string;
  status: string;
  currentState?: string;
  pendingReason?: string;
  eventCount: number;
  lastEventType: string;
  lastEventAt: string;
  statePath: string[];
}

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`/api/agent/${path}`, { cache: 'no-store' });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? 'THETA Agent API 请求失败。');
  }
  return payload.data;
};

export const ThetaAgentV2API = {
  health: (): Promise<ThetaHealth> => get<ThetaHealth>('health'),
  runs: (limit = 30): Promise<{ runs: ThetaRunSummary[] }> =>
    get<{ runs: ThetaRunSummary[] }>(`runs?limit=${limit}`),
  status: (runId: string): Promise<ThetaRunStatus> =>
    get<ThetaRunStatus>(`runs/${encodeURIComponent(runId)}/status`),
};
