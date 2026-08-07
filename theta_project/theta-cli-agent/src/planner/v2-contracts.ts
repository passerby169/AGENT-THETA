import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  datasetConfirmationSchema,
  datasetFactsSchema,
  researchIntentSchema,
} from '../dataset-understanding/contracts.js';

const hardwareSchema = z.object({
  device: z.enum(['cpu', 'gpu', 'unknown']),
  memoryGb: z.number().positive().optional(),
  offlineOnly: z.boolean(),
});

const candidateSchema = z.object({
  modelId: z.string().min(1),
  runnable: z.boolean(),
  capabilities: z.array(z.string().min(1)),
  estimatedMemoryGb: z.number().nonnegative().optional(),
});

export const plannerInputV2Schema = z.object({
  schemaVersion: z.literal('2.0.0'),
  facts: datasetFactsSchema,
  confirmation: datasetConfirmationSchema,
  intent: researchIntentSchema,
  hardware: hardwareSchema,
  catalogVersion: z.string().min(1),
  candidates: z.array(candidateSchema).min(1),
  evidenceRefs: z.array(z.string().min(1)).max(20),
  userOverrides: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const plannerDecisionV2Schema = z.object({
  schemaVersion: z.literal('2.0.0'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  modelId: z.string().min(1),
  parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  evaluation: z.array(z.string().min(1)).min(1),
  visualizations: z.array(z.string().min(1)).min(1),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export const plannerValidationResultV2Schema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type PlannerInputV2 = z.infer<typeof plannerInputV2Schema>;
export type PlannerDecisionV2 = z.infer<typeof plannerDecisionV2Schema>;
export type PlannerValidationResultV2 = z.infer<typeof plannerValidationResultV2Schema>;

export const plannerInputV2Hash = (input: PlannerInputV2): string =>
  createHash('sha256').update(stableJson(plannerInputV2Schema.parse(input))).digest('hex');

const stableJson = (value: unknown): string => JSON.stringify(sortValue(value));
const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, sortValue(nested)]));
};
