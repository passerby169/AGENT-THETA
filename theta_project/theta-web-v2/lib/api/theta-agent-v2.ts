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
  identity?: {
    datasetName: string;
    researchQuestion: string;
    displayName: string;
    modelId?: string;
    numTopics?: number;
  };
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
  trainingReceipt?: ThetaTrainingReceipt;
  datasetProfile?: ThetaDatasetProfile;
  datasetFacts?: ThetaDatasetFacts;
  datasetUnderstanding?: ThetaDatasetUnderstanding;
  datasetConfirmation?: ThetaDatasetConfirmation;
  researchIntent?: ThetaResearchIntent;
  interviewMemory?: {
    resolvedGapIds: string[];
    defaultedGapIds: string[];
  };
  decisionGap?: ThetaDecisionGap;
  researchBrief?: {
    researchQuestion?: string;
    researchDomain?: string;
    domainConfirmed?: boolean;
    analysisUnit?: string;
    textFieldIntent?: string;
    sensitiveData?: { status: 'yes' | 'no' | 'unknown'; categories: string[] };
  };
  presentation: ThetaPresentation;
}

export interface ThetaDatasetFacts {
  datasetRef: string;
  datasetHash: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  rowCount: number;
  columns: Array<{
    name: string;
    inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
    missingRatio: number;
    uniqueCount: number;
    averageLength: number;
  }>;
  languageDistribution: Array<{ language: string; ratio: number }>;
  duplicateRatio: number;
  timeCoverage: { start: string | null; end: string | null };
}

export interface ThetaDatasetUnderstanding {
  datasetRef: string;
  datasetHash: string;
  domain: { label: string; confidence: number; evidence: string[] };
  analysisUnit: string;
  textColumns: ThetaColumnRole[];
  timeColumns: ThetaColumnRole[];
  idColumns: ThetaColumnRole[];
  metadataColumns: ThetaColumnRole[];
  qualityWarnings: string[];
  assumptions: string[];
  confidence: number;
  provenance: { source: string; toolIds: string[]; sampleSeed: string; generatedAt: string };
}

export interface ThetaColumnRole {
  column: string;
  confidence: number;
  reason: string;
}

export interface ThetaDatasetConfirmation {
  datasetHash: string;
  status: 'confirmed' | 'corrected';
  domainLabel: string;
  analysisUnit: string;
  textColumns: string[];
  timeColumns: string[];
  idColumns: string[];
  metadataColumns: string[];
}

export interface ThetaResearchIntent {
  researchQuestion: string;
  comparisonDimensions: string[];
  temporalAnalysis: boolean;
  topicGranularity: 'coarse' | 'medium' | 'fine';
  successCriteria: string[];
  constraints: string[];
  unknowns: string[];
}

export interface ThetaDecisionGap {
  id: string;
  category: 'research_goal' | 'comparison' | 'temporal' | 'granularity' | 'success' | 'constraint';
  question: string;
  whyItMatters: string;
  planImpact: string;
  blocking: boolean;
  defaultResolution: string;
  evidence: string[];
}

export interface ThetaDatasetProfile {
  fileName: string;
  fileSizeBytes: number;
  format: string;
  encoding: string;
  rowCount: number;
  sampledRowCount: number;
  profileScope: 'full' | 'sample';
  columnCount: number;
  columns: string[];
  columnProfiles: Array<{
    name: string;
    inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
    nonEmptySampleCount: number;
    uniqueSampleCount: number;
    avgLength: number;
    maxLength: number;
  }>;
  missingRatio: number;
  languageDistribution: Array<{ language: string; ratio: number }>;
  timeCoverage: { start: string | null; end: string | null };
  columnCandidates: {
    text: Array<{ name: string; score: number; reason: string }>;
    time: Array<{ name: string; score: number; reason: string }>;
    metadata: Array<{ name: string; score: number; reason: string }>;
  };
  sensitiveRiskCodes: string[];
  inferredDomain?: {
    label: string;
    confidence: number;
    evidence: string[];
  };
}

export interface ThetaTrainingReceipt {
  trainingRunId?: string;
  status?: string;
  progress?: number;
  currentStep?: string;
  logPath?: string | null;
  resultArtifacts?: Array<{ kind: string; path: string; description?: string; exists: boolean }>;
  errorMessage?: string | null;
  quarantineReason?: string | null;
}

export interface ThetaRunTimeline {
  runId: string;
  timeline: Array<{
    id: string;
    source: 'workflow' | 'tool';
    type: string;
    title: string;
    detail?: string;
    timestamp: string;
  }>;
  training?: ThetaTrainingReceipt;
  logs: string[];
}

export interface ThetaConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  messageKind: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}

export interface ThetaRunResults {
  runId: string;
  trainingRunId?: string;
  status: string;
  progress: number;
  executionStatus?: string;
  qualityStatus?: string;
  researchStatus?: 'passed' | 'needs_review' | 'not_evaluated';
  currentStep?: string;
  resultRoot?: string;
  visualizations: Array<{
    id: string;
    label: string;
    relativePath: string;
    format: 'image' | 'interactive';
    scope: 'global' | 'topic';
    topicId?: string;
    sizeBytes: number;
  }>;
  metrics: Record<string, unknown>;
  topics: Array<{
    id: string;
    name: string;
    strength?: number;
    keywords: string[];
  }>;
  goalAssessment: Array<{
    criterion: string;
    status: 'satisfied' | 'not_satisfied' | 'not_evaluated';
    evidence: string;
  }>;
  comparison: string[];
  warnings: string[];
  message: string;
}

export interface ThetaResultAnalysisSelection {
  topicIds: string[];
  metricKeys: string[];
  visualizationIds: string[];
  includeGoalAssessment: boolean;
  includeWarnings: boolean;
}

export interface ThetaResultAnalysisResponse {
  answer: string;
  provider: string;
  model: string;
  selected: {
    topics: number;
    metrics: number;
    visualizations: number;
    goalAssessment: boolean;
    warnings: boolean;
  };
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
  datasetRef: string;
  name: string;
  sizeBytes: number;
  suffix: string;
  createdAt: string;
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
  candidatePlan?: ThetaPlanCandidate;
  validatedPlan?: ThetaPlanCandidate;
  recommendation?: {
    recommendations?: Array<{
      modelId: string;
      modelName?: string;
    }>;
  };
  plannerPresentationV2?: ThetaPlannerPresentationV2;
  presentation: ThetaPresentation;
}

export interface ThetaPlannerPresentationV2 {
  title: string;
  summary: string;
  researchGoal: string;
  model: string;
  primaryModel: { modelId: string; rationale: string };
  baselineModel: { modelId: string; rationale: string } | null;
  dataBasis: string[];
  keyParameters: Array<{
    field: string;
    value: string | number | boolean | null;
    rationale: string;
    source: 'user_override' | 'planner_recommendation' | 'validated_default';
  }>;
  experiment: {
    mode: 'quick' | 'comparative' | 'stability';
    primarySeeds: number[];
    baselineSeeds: number[];
    rationale: string;
  } | null;
  preprocessing: Array<{ choice: string; rationale: string }>;
  evaluation: string[];
  visualizations: string[];
  outputs: string[];
  cautions: string[];
  assumptions: string[];
  openQuestions: string[];
  plannerSource: 'minimax' | 'deterministic' | 'unknown';
  approvalRequired: boolean;
}

export interface ThetaPlanCandidate {
  modelId?: string;
  numTopics?: number | null;
  parameters?: {
    numTopics?: number | null;
  };
}

export interface ThetaActionResult {
  kind?: string;
  response?: string;
  explanation?: string;
}

export type ThetaRunAction =
  | { action: 'answer'; text: string }
  | { action: 'message'; text: string; useMiniMax: boolean }
  | { action: 'columns'; text: string }
  | {
      action: 'confirmDataset';
      status: 'confirmed' | 'corrected';
      domainLabel: string;
      analysisUnit: string;
      textColumns: string[];
      timeColumns: string[];
      idColumns: string[];
      metadataColumns: string[];
    }
  | { action: 'decisionAnswer'; text: string }
  | { action: 'finishInterview' }
  | { action: 'adjustPlan'; text: string }
  | { action: 'approvePlan'; acceptDegradation: boolean }
  | { action: 'startTraining' }
  | { action: 'poll' }
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

const upload = async <T,>(path: string, file: File): Promise<T> => {
  const body = new FormData();
  body.set('file', file);
  const response = await fetch(`/api/agent/${path}`, { method: 'POST', body });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? '数据集上传失败。');
  }
  return payload.data;
};

export const ThetaAgentV2API = {
  health: (): Promise<ThetaHealth> => get<ThetaHealth>('health'),
  runs: (limit = 30): Promise<{ runs: ThetaRunSummary[] }> =>
    get<{ runs: ThetaRunSummary[] }>(`runs?limit=${limit}`),
  status: (runId: string): Promise<ThetaRunStatus> =>
    get<ThetaRunStatus>(`runs/${encodeURIComponent(runId)}/status`),
  timeline: (runId: string, limit = 40): Promise<ThetaRunTimeline> =>
    get<ThetaRunTimeline>(`runs/${encodeURIComponent(runId)}/timeline?limit=${limit}`),
  conversation: (runId: string, limit = 80): Promise<{ runId: string; messages: ThetaConversationMessage[] }> =>
    get<{ runId: string; messages: ThetaConversationMessage[] }>(
      `runs/${encodeURIComponent(runId)}/conversation?limit=${limit}`,
    ),
  results: (runId: string): Promise<ThetaRunResults> =>
    get<ThetaRunResults>(`runs/${encodeURIComponent(runId)}/results`),
  analyzeResults: (
    runId: string,
    input: {
      question: string;
      selection: ThetaResultAnalysisSelection;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ): Promise<ThetaResultAnalysisResponse> =>
    post<ThetaResultAnalysisResponse>(
      `runs/${encodeURIComponent(runId)}/results/analysis`,
      input,
    ),
  resultAssetUrl: (runId: string, relativePath: string): string =>
    `/api/agent/runs/${encodeURIComponent(runId)}/results/assets/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
  datasets: (): Promise<{ datasets: ThetaDataset[] }> =>
    get<{ datasets: ThetaDataset[] }>('datasets'),
  uploadDataset: (file: File): Promise<ThetaDataset> =>
    upload<ThetaDataset>('datasets/upload', file),
  models: (): Promise<{ models: ThetaModel[]; supportedModelIds: string[] }> =>
    get<{ models: ThetaModel[]; supportedModelIds: string[] }>('models'),
  plan: (runId: string): Promise<ThetaPlan> =>
    get<ThetaPlan>(`runs/${encodeURIComponent(runId)}/plan`),
  createRun: (input: { datasetRef: string; researchGoal?: string; useMiniMax: boolean }): Promise<ThetaRunStatus> =>
    post<ThetaRunStatus>('runs', input),
  act: (runId: string, action: ThetaRunAction): Promise<{ result: ThetaActionResult; status: ThetaRunStatus }> =>
    post<{ result: ThetaActionResult; status: ThetaRunStatus }>(`runs/${encodeURIComponent(runId)}/actions`, action),
};
