export type AgentActivityKind =
  | 'thinking'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'checkpoint_requested'
  | 'phase_completed';

export interface ActivityProgress {
  completedGates: number;
  totalGates: number;
  percent: number;
  label: string;
}

export interface AgentActivityEvent {
  eventId: string;
  activityId: string;
  runId: string;
  phase: string;
  kind: AgentActivityKind;
  toolId?: string;
  displayName: string;
  userMessage: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  safeInputSummary?: string;
  safeOutputSummary?: string;
  progress: ActivityProgress;
}

export interface AgentActivitySnapshot {
  runId: string;
  phase?: string;
  current?: AgentActivityEvent;
  recent: AgentActivityEvent[];
  progress: ActivityProgress;
}
