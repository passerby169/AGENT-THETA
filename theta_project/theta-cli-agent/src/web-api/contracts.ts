import { z } from 'zod';

export const thetaWebCreateRunSchema = z.object({
  datasetRef: z.string().trim().min(1).optional(),
  filePath: z.string().trim().min(1).optional(),
  researchGoal: z.string().trim().min(1).max(4000).optional(),
  allowRemoteSamples: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.datasetRef && value.filePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide at most one dataset source: datasetRef or filePath. Omit both for Agent-led Intake.',
      path: ['datasetRef'],
    });
  }
});

export type ThetaWebCreateRun = z.infer<typeof thetaWebCreateRunSchema>;

export const thetaWebMessageSchema = z.object({
  content: z.string().trim().min(1).max(12000),
  messageId: z.string().trim().min(1).max(256).optional(),
}).strict();

export const thetaWebCheckpointDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    checkpointId: z.string().trim().min(1).max(512),
    expectedContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict(),
  z.object({
    action: z.literal('revise'),
    checkpointId: z.string().trim().min(1).max(512),
    expectedContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    feedback: z.string().trim().min(1).max(12000),
  }).strict(),
]);

export const thetaWebApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export type ThetaWebApiEnvelope = z.infer<typeof thetaWebApiEnvelopeSchema>;

export interface ThetaWebApiHealth {
  service: 'theta-agent-api';
  version: 'v3';
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: Array<{
    id: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    remediation?: string;
  }>;
}
