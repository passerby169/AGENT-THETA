import { z } from "zod";

export const KNOWLEDGE_SCHEMA_VERSION = "1.0.0";

export const authoritySchema = z.enum(["L1", "L2", "L3", "L4"]);

export const knowledgeSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(["code", "config", "documentation"]),
    authority: authoritySchema,
    parser: z.enum(["text", "yaml", "markdown"]),
    sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  })
  .strict();

export const knowledgeManifestSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    sources: z.array(knowledgeSourceSchema).min(1),
  })
  .strict();

export const evidenceRefSchema = z
  .object({
    evidenceId: z.string().min(1),
    sourceId: z.string().min(1),
    authority: authoritySchema,
    relativePath: z.string().min(1),
    symbol: z.string().nullable(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    excerpt: z.string().min(1).max(1200),
    finalScore: z.number().min(0).max(100),
  })
  .strict();

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
