import { z } from 'zod';

export const thetaWebRunActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('columns'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('finishInterview') }).strict(),
  z.object({ action: z.literal('adjustPlan'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('approvePlan'), acceptDegradation: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('startTraining') }).strict(),
  z.object({ action: z.literal('retry') }).strict(),
]);

export const thetaWebCreateRunSchema = z.object({
  filePath: z.string().trim().min(1),
  researchGoal: z.string().trim().min(8).max(2000),
  useMiniMax: z.boolean().default(true),
}).strict();

export type ThetaWebRunAction = z.infer<typeof thetaWebRunActionSchema>;
export type ThetaWebCreateRun = z.infer<typeof thetaWebCreateRunSchema>;

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
  presentation?: {
    title: string;
    summary: string;
    progress?: { current: number; total: number; label: string; percent?: number };
    nextActions: Array<{
      id: string;
      label: string;
      description: string;
      recommended?: boolean;
      destructive?: boolean;
    }>;
  };
}
