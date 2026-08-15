import { randomUUID } from 'node:crypto';
import { createFrameworkEvent, type EventStore, type FrameworkEvent } from '@hypha/core';
import { planCompletionProgress } from '../planner-v3/completion-gates.js';
import { projectPlanner } from '../planner-v3/event-store.js';
import { projectWorkspace } from '../workspaces/event-store.js';
import { projectExecution } from '../execution/event-store.js';
import type { AgentActivityEvent, AgentActivityKind, AgentActivitySnapshot, ActivityProgress } from './contracts.js';
import { THETA_ACTIVITY_EVENT_TYPE } from './event-schemas.js';

export interface RecordActivityRequest {
  runId: string;
  sessionId: string;
  userId: string;
  activityId: string;
  phase: string;
  kind: AgentActivityKind;
  toolId?: string;
  displayName: string;
  userMessage: string;
  status: AgentActivityEvent['status'];
  startedAt?: string;
  completedAt?: string;
  safeInputSummary?: string;
  safeOutputSummary?: string;
}

export class ThetaActivityEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(request: RecordActivityRequest): Promise<AgentActivityEvent> {
    const all = await this.events.list({ runId: request.runId });
    const progress = progressFromEvents(all, request.phase);
    const timestamp = this.now();
    const prior = projectActivities(all).filter((item) => item.activityId === request.activityId).at(-1);
    const activity: AgentActivityEvent = {
      eventId: `activity-event:${randomUUID()}`,
      activityId: request.activityId,
      runId: request.runId,
      phase: request.phase,
      kind: request.kind,
      ...(request.toolId === undefined ? {} : { toolId: request.toolId }),
      displayName: request.displayName,
      userMessage: request.userMessage,
      status: request.status,
      startedAt: request.startedAt ?? prior?.startedAt ?? timestamp,
      ...(request.completedAt === undefined ? {} : { completedAt: request.completedAt }),
      ...(request.safeInputSummary === undefined ? {} : { safeInputSummary: request.safeInputSummary }),
      ...(request.safeOutputSummary === undefined ? {} : { safeOutputSummary: request.safeOutputSummary }),
      progress,
    };
    await this.events.append(createFrameworkEvent({
      id: activity.eventId,
      type: THETA_ACTIVITY_EVENT_TYPE,
      version: '1.0.0',
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      timestamp,
      payload: { kind: 'theta.agent.activity.recorded', activity },
      metadata: { phase: request.phase, activityKind: request.kind, toolId: request.toolId ?? '' },
    }));
    return activity;
  }

  async list(runId: string, limit = 100): Promise<AgentActivityEvent[]> {
    const values = projectActivities(await this.events.list({ runId }));
    return values.slice(-Math.max(1, limit));
  }

  async snapshot(runId: string, limit = 30): Promise<AgentActivitySnapshot> {
    const events = await this.events.list({ runId });
    const activities = projectActivities(events);
    const phase = activities.at(-1)?.phase;
    const recent = activities.slice(-Math.max(1, limit));
    // Activity transitions are append-only. Collapse them by activityId before
    // selecting the current item so a historical `started` event cannot keep a
    // completed tool looking active forever.
    const latestByActivity = new Map<string, AgentActivityEvent>();
    for (const activity of activities) latestByActivity.set(activity.activityId, activity);
    const current = [...latestByActivity.values()].reverse().find((item) => item.status === 'running')
      ?? recent.at(-1);
    return {
      runId,
      ...(phase === undefined ? {} : { phase }),
      ...(current === undefined ? {} : { current }),
      recent,
      progress: progressFromEvents(events, phase ?? 'Intake'),
    };
  }
}

export const projectActivities = (events: readonly FrameworkEvent[]): AgentActivityEvent[] => events
  .filter((event) => event.type === THETA_ACTIVITY_EVENT_TYPE)
  .map((event) => record(event.payload).activity)
  .filter(isActivity)
  .map((activity) => structuredClone(activity));

const progressFromEvents = (events: readonly FrameworkEvent[], phase: string): ActivityProgress => {
  if (phase === 'PlanDesign' || phase === 'PlanConfirmation' || phase === 'CreatePlan') {
    const planner = projectPlanner(events);
    const candidate = planner.candidates.at(-1) ?? null;
    const evidenceReceipt = candidate
      ? planner.evidenceReceipts.filter((item) => item.candidatePlanHash === candidate.candidatePlanHash).at(-1) ?? null
      : null;
    const validationReceipt = candidate
      ? planner.validationReceipts.filter((item) => item.candidatePlanHash === candidate.candidatePlanHash).at(-1) ?? null
      : null;
    const progress = planCompletionProgress({ candidate, evidenceReceipt, validationReceipt });
    if (phase === 'CreatePlan') {
      const execution = projectExecution(events);
      const approved = candidate && planner.approvalReceipts.some((item) => item.candidatePlanHash === candidate.candidatePlanHash);
      const created = Boolean(execution.canonicalPlans.at(-1));
      return gateProgress([Boolean(approved), created], created ? '可执行计划已生成' : '生成可执行计划');
    }
    if (phase === 'PlanConfirmation') {
      const approved = candidate && planner.approvalReceipts.some((item) => item.candidatePlanHash === candidate.candidatePlanHash);
      const completedGates = approved ? 2 : 1;
      return { completedGates, totalGates: 2, percent: completedGates * 50, label: approved ? '计划已确认' : '等待确认计划' };
    }
    return { completedGates: progress.completedGates, totalGates: progress.totalGates, percent: progress.percent, label: '制定并校验计划' };
  }
  if (phase === 'DryRun' || phase === 'TrainingConfirmation') {
    const execution = projectExecution(events);
    const canonical = execution.canonicalPlans.at(-1);
    const dryRun = canonical === undefined
      ? undefined
      : execution.dryRuns.filter((item) => item.planHash === canonical.canonicalPlanRecord.planHash).at(-1);
    return gateProgress(
      [Boolean(canonical), dryRun?.passed === true],
      phase === 'TrainingConfirmation' ? '等待确认开始训练' : '执行训练前检查',
    );
  }
  if (phase === 'VerifyDataset' || phase === 'StartTraining' || phase === 'MonitorTraining' || phase === 'EvaluateResults' || phase === 'Completed') {
    const execution = projectExecution(events);
    const verification = execution.datasetVerifications.at(-1);
    const trainingRun = execution.trainingRuns.at(-1);
    const trainingProgress = execution.trainingProgress.at(-1);
    const manifest = execution.artifactManifests.at(-1);
    if (phase === 'VerifyDataset') return gateProgress([verification?.verified === true], '重新核验数据');
    if (phase === 'StartTraining') return gateProgress([Boolean(trainingRun)], '启动已批准训练');
    if (phase === 'MonitorTraining') {
      const percent = trainingProgress?.overallPercent ?? 0;
      const totalGates = Math.max(1, trainingProgress?.totalRuns ?? 1);
      return {
        completedGates: Math.min(totalGates, trainingProgress?.completedRuns ?? 0),
        totalGates,
        percent,
        label: trainingProgress?.phaseLabel ?? '等待训练状态',
      };
    }
    if (phase === 'EvaluateResults') return gateProgress([Boolean(manifest)], '验证并读取结果');
    return gateProgress([Boolean(trainingRun), trainingProgress?.status === 'completed', Boolean(manifest)], '训练闭环已完成');
  }
  const activities = projectActivities(events).filter((item) => item.phase === phase && item.status === 'completed');
  const tools = new Set(activities.map((item) => item.toolId).filter((value): value is string => Boolean(value)));
  if (phase === 'DatasetDiscovery') {
    const dataset = projectWorkspace(events, 'dataset');
    const gates = [tools.has('theta.dataset.overview'), [...tools].some((id) => id.includes('profile') || id.endsWith('sample')), dataset?.workspaceType === 'dataset'];
    return gateProgress(gates, '理解数据集');
  }
  if (phase === 'ResearchDialogue') {
    const current = projectWorkspace(events, 'research');
    const research = current?.workspaceType === 'research' ? current : null;
    const gates = [tools.has('theta.research.read_workspace'), Boolean(research?.statements.length || research?.decisions.length), Boolean(research && !research.questions.some((item) => item.status === 'open' && item.blocking))];
    return gateProgress(gates, '明确研究意图');
  }
  return { completedGates: 0, totalGates: 1, percent: 0, label: phase };
};

const gateProgress = (gates: boolean[], label: string): ActivityProgress => {
  const completedGates = gates.filter(Boolean).length;
  return { completedGates, totalGates: gates.length, percent: Math.round(completedGates / gates.length * 100), label };
};

const isActivity = (value: unknown): value is AgentActivityEvent => {
  const item = record(value);
  return typeof item.eventId === 'string' && typeof item.activityId === 'string' && typeof item.runId === 'string' && typeof item.phase === 'string' && typeof item.userMessage === 'string';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
