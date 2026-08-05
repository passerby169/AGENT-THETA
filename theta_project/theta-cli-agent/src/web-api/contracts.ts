import { z } from 'zod';

export const thetaWebApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type ThetaWebApiEnvelope = z.infer<typeof thetaWebApiEnvelopeSchema>;

export interface ThetaWebApiHealth {
  service: 'theta-agent-api';
  version: 'v2';
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: Array<{
    id: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    remediation?: string;
  }>;
}

export interface ThetaWebRunSummary {
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
}
