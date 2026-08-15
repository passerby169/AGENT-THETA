import { randomUUID } from 'node:crypto';
import { createFrameworkEvent, type EventStore, type FrameworkEvent } from '@hypha/core';
import type {
  CandidatePlan,
  EvidenceSelectionReceipt,
  PlanValidationReceipt,
  PlanApprovalReceipt,
} from './contracts.js';
import { THETA_PLANNER_EVENT_TYPE } from './event-schemas.js';

export class ThetaPlannerEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async candidates(runId: string): Promise<CandidatePlan[]> {
    return projectPlanner(await this.events.list({ runId })).candidates;
  }

  async candidate(runId: string, candidateRef?: string): Promise<CandidatePlan | null> {
    const candidates = await this.candidates(runId);
    if (candidateRef) return candidates.find((candidate) => candidate.candidateRef === candidateRef) ?? null;
    return candidates.at(-1) ?? null;
  }

  async evidenceReceipt(runId: string, candidatePlanHash: string): Promise<EvidenceSelectionReceipt | null> {
    return projectPlanner(await this.events.list({ runId })).evidenceReceipts
      .filter((receipt) => receipt.candidatePlanHash === candidatePlanHash)
      .at(-1) ?? null;
  }

  async validationReceipt(runId: string, candidatePlanHash: string): Promise<PlanValidationReceipt | null> {
    return projectPlanner(await this.events.list({ runId })).validationReceipts
      .filter((receipt) => receipt.candidatePlanHash === candidatePlanHash)
      .at(-1) ?? null;
  }

  async approvalReceipt(runId: string, candidatePlanHash?: string): Promise<PlanApprovalReceipt | null> {
    return projectPlanner(await this.events.list({ runId })).approvalReceipts
      .filter((receipt) => candidatePlanHash === undefined || receipt.candidatePlanHash === candidatePlanHash)
      .at(-1) ?? null;
  }

  async recordCandidate(input: {
    runId: string;
    sessionId: string;
    userId: string;
    candidate: CandidatePlan;
  }): Promise<CandidatePlan> {
    await this.append(input, 'theta.plan.candidate.recorded', { candidate: input.candidate });
    return structuredClone(input.candidate);
  }

  async recordEvidence(input: {
    runId: string;
    sessionId: string;
    userId: string;
    receipt: EvidenceSelectionReceipt;
  }): Promise<EvidenceSelectionReceipt> {
    await this.append(input, 'theta.plan.evidence.selected', { receipt: input.receipt });
    return structuredClone(input.receipt);
  }

  async recordValidation(input: {
    runId: string;
    sessionId: string;
    userId: string;
    receipt: PlanValidationReceipt;
  }): Promise<PlanValidationReceipt> {
    await this.append(input, 'theta.plan.validation.completed', { receipt: input.receipt });
    return structuredClone(input.receipt);
  }

  async recordApproval(input: {
    runId: string;
    sessionId: string;
    userId: string;
    receipt: PlanApprovalReceipt;
  }): Promise<PlanApprovalReceipt> {
    const existing = await this.approvalReceipt(input.runId, input.receipt.candidatePlanHash);
    if (existing) {
      if (
        existing.checkpointId === input.receipt.checkpointId &&
        existing.checkpointContentHash === input.receipt.checkpointContentHash &&
        existing.principalId === input.receipt.principalId
      ) return structuredClone(existing);
      throw new Error('A different approval receipt already exists for the current candidate hash.');
    }
    await this.append(input, 'theta.plan.approval.bound', { receipt: input.receipt });
    return structuredClone(input.receipt);
  }

  private async append(
    identity: { runId: string; sessionId: string; userId: string },
    kind: PlannerEventKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.events.append(createFrameworkEvent({
      id: `theta-planner:${identity.runId}:${randomUUID()}`,
      type: THETA_PLANNER_EVENT_TYPE,
      version: '1.0.0',
      runId: identity.runId,
      sessionId: identity.sessionId,
      userId: identity.userId,
      timestamp: this.now(),
      payload: { kind, ...payload },
      metadata: { kind },
    }));
  }
}

type PlannerEventKind =
  | 'theta.plan.candidate.recorded'
  | 'theta.plan.evidence.selected'
  | 'theta.plan.validation.completed'
  | 'theta.plan.approval.bound';

export const projectPlanner = (events: readonly FrameworkEvent[]): {
  candidates: CandidatePlan[];
  evidenceReceipts: EvidenceSelectionReceipt[];
  validationReceipts: PlanValidationReceipt[];
  approvalReceipts: PlanApprovalReceipt[];
} => {
  const candidates: CandidatePlan[] = [];
  const evidenceReceipts: EvidenceSelectionReceipt[] = [];
  const validationReceipts: PlanValidationReceipt[] = [];
  const approvalReceipts: PlanApprovalReceipt[] = [];
  for (const event of events) {
    if (event.type !== THETA_PLANNER_EVENT_TYPE) continue;
    const payload = record(event.payload);
    if (payload.kind === 'theta.plan.candidate.recorded' && isRecord(payload.candidate)) {
      candidates.push(structuredClone(payload.candidate) as unknown as CandidatePlan);
    }
    if (payload.kind === 'theta.plan.evidence.selected' && isRecord(payload.receipt)) {
      evidenceReceipts.push(structuredClone(payload.receipt) as unknown as EvidenceSelectionReceipt);
    }
    if (payload.kind === 'theta.plan.validation.completed' && isRecord(payload.receipt)) {
      validationReceipts.push(structuredClone(payload.receipt) as unknown as PlanValidationReceipt);
    }
    if (payload.kind === 'theta.plan.approval.bound' && isRecord(payload.receipt)) {
      approvalReceipts.push(structuredClone(payload.receipt) as unknown as PlanApprovalReceipt);
    }
  }
  return { candidates, evidenceReceipts, validationReceipts, approvalReceipts };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
