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
  status: string;
  currentState?: string;
  pendingReason?: string;
  lastEventType?: string;
  lastEventAt?: string;
  recoveryOfRunId?: string;
  successorRunId?: string;
  presentation?: ThetaPresentation;
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
  presentation: ThetaPresentation;
}

export interface ThetaPresentation {
  title: string;
  summary: string;
  progress?: { current: number; total: number; label: string; percent?: number };
  sections?: Array<{ title?: string; lines: string[] }>;
  warnings?: string[];
  nextActions: Array<{
    id: string;
    label: string;
    description: string;
    recommended?: boolean;
    destructive?: boolean;
  }>;
}

export interface ThetaDataset {
  name: string;
  filePath: string;
  sizeBytes: number;
}

export interface ThetaModel {
  id: string;
  name: string;
  type: string;
  runnable?: boolean;
  experimental?: boolean;
}

export interface ThetaPlan {
  currentState?: string;
  presentation: ThetaPresentation;
}

export type ThetaRunAction =
  | { action: 'answer'; text: string }
  | { action: 'columns'; text: string }
  | { action: 'finishInterview' }
  | { action: 'adjustPlan'; text: string }
  | { action: 'approvePlan'; acceptDegradation: boolean }
  | { action: 'startTraining' }
  | { action: 'retry' };

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`/api/agent/${path}`, { cache: 'no-store' });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? 'THETA Agent API 请求失败。');
  }
  return payload.data;
};

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`/api/agent/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? 'THETA Agent 操作失败。');
  }
  return payload.data;
};

export const ThetaAgentV2API = {
  health: (): Promise<ThetaHealth> => get<ThetaHealth>('health'),
  runs: (limit = 30): Promise<{ runs: ThetaRunSummary[] }> =>
    get<{ runs: ThetaRunSummary[] }>(`runs?limit=${limit}`),
  status: (runId: string): Promise<ThetaRunStatus> =>
    get<ThetaRunStatus>(`runs/${encodeURIComponent(runId)}/status`),
  datasets: (): Promise<{ datasets: ThetaDataset[] }> =>
    get<{ datasets: ThetaDataset[] }>('datasets'),
  models: (): Promise<{ models: ThetaModel[]; supportedModelIds: string[] }> =>
    get<{ models: ThetaModel[]; supportedModelIds: string[] }>('models'),
  plan: (runId: string): Promise<ThetaPlan> =>
    get<ThetaPlan>(`runs/${encodeURIComponent(runId)}/plan`),
  createRun: (input: { filePath: string; researchGoal: string; useMiniMax: boolean }): Promise<ThetaRunStatus> =>
    post<ThetaRunStatus>('runs', input),
  act: (runId: string, action: ThetaRunAction): Promise<{ result: unknown; status: ThetaRunStatus }> =>
    post<{ result: unknown; status: ThetaRunStatus }>(`runs/${encodeURIComponent(runId)}/actions`, action),
};
