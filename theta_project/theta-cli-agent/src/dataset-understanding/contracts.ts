import { z } from 'zod';

export const datasetColumnFactSchema = z.object({
  name: z.string().min(1),
  inferredType: z.enum(['empty', 'number', 'datetime', 'text', 'string']),
  missingRatio: z.number().min(0).max(1),
  uniqueCount: z.number().int().nonnegative(),
  averageLength: z.number().nonnegative(),
});

export const datasetFactsSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1),
  format: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(datasetColumnFactSchema),
  languageDistribution: z.array(
    z.object({
      language: z.string().min(1),
      ratio: z.number().min(0).max(1),
    }),
  ),
  duplicateRatio: z.number().min(0).max(1),
  timeCoverage: z.object({
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  generatedAt: z.string().datetime(),
});

export const datasetColumnRoleSchema = z.object({
  column: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const datasetUnderstandingDraftSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  domain: z.object({
    label: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1)).max(8),
  }),
  analysisUnit: z.string().min(1),
  textColumns: z.array(datasetColumnRoleSchema),
  timeColumns: z.array(datasetColumnRoleSchema),
  idColumns: z.array(datasetColumnRoleSchema),
  metadataColumns: z.array(datasetColumnRoleSchema),
  qualityWarnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  provenance: z.object({
    source: z.enum(['deterministic', 'minimax', 'user', 'hybrid']),
    toolIds: z.array(z.string()),
    sampleSeed: z.string().min(1),
    generatedAt: z.string().datetime(),
  }),
});

export const datasetConfirmationDraftSchema = z.object({
  status: z.enum(['confirmed', 'corrected']),
  domainLabel: z.string().min(1),
  analysisUnit: z.string().min(1),
  textColumns: z.array(z.string().min(1)).min(1),
  timeColumns: z.array(z.string().min(1)),
  idColumns: z.array(z.string().min(1)),
  metadataColumns: z.array(z.string().min(1)),
});

export const datasetConfirmationSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  datasetRef: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['confirmed', 'corrected']),
  domainLabel: z.string().min(1),
  analysisUnit: z.string().min(1),
  textColumns: z.array(z.string().min(1)).min(1),
  timeColumns: z.array(z.string().min(1)),
  idColumns: z.array(z.string().min(1)),
  metadataColumns: z.array(z.string().min(1)),
  confirmedBy: z.string().min(1),
  confirmedAt: z.string().datetime(),
});

export const researchIntentSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  researchQuestion: z.string().min(1),
  comparisonDimensions: z.array(z.string().min(1)),
  temporalAnalysis: z.boolean(),
  topicGranularity: z.enum(['coarse', 'medium', 'fine']),
  successCriteria: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
});

export type DatasetFacts = z.infer<typeof datasetFactsSchema>;
export type DatasetUnderstandingDraft = z.infer<
  typeof datasetUnderstandingDraftSchema
>;
export type DatasetConfirmationDraft = z.infer<
  typeof datasetConfirmationDraftSchema
>;
export type DatasetConfirmation = z.infer<typeof datasetConfirmationSchema>;
export type ResearchIntent = z.infer<typeof researchIntentSchema>;
