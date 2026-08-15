import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchema } from "@hypha/core";
import type { ToolHandler, ToolSpec } from "@hypha/tools";
import { evidenceRefSchema, type EvidenceRef } from "../rag/contracts.js";
import { FtsEvidenceIndex } from "../rag/fts-index.js";
import type { RetrievalTrace } from "../rag/fts-index.js";
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from "./tool-ids.js";

export interface ThetaRagSearchInput {
  query: string;
  limit?: number;
  modelIds?: string[];
  evidenceTypes?: string[];
  authorityLevels?: Array<'L1' | 'L2' | 'L3' | 'L4'>;
  purposes?: string[];
}

export interface ThetaRagSearchOutput {
  schemaVersion: "1.1.0";
  query: string;
  evidence: EvidenceRef[];
  noEvidence: boolean;
  retrievalTrace: RetrievalTrace;
}

const inputSchema: JsonSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 1000 },
    limit: { type: "integer", minimum: 1, maximum: 30 },
    modelIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    evidenceTypes: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    authorityLevels: { type: 'array', uniqueItems: true, items: { enum: ['L1', 'L2', 'L3', 'L4'] } },
    purposes: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
  additionalProperties: false,
};

const evidenceSchema: JsonSchema = {
  type: "object",
  required: [
    "evidenceId",
    "sourceId",
    "authority",
    "relativePath",
    "symbol",
    "startLine",
    "endLine",
    "sourceCommit",
    "contentHash",
    "excerpt",
    "finalScore",
  ],
  properties: {
    evidenceId: { type: "string" },
    sourceId: { type: "string" },
    authority: { enum: ["L1", "L2", "L3", "L4"] },
    relativePath: { type: "string" },
    symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    sourceCommit: { type: "string" },
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    excerpt: { type: "string", maxLength: 1200 },
    finalScore: { type: "number", minimum: 0, maximum: 100 },
    objectId: { type: "string" },
    objectType: { type: "string" },
    title: { type: "string" },
    modelIds: { type: "array", items: { type: "string" } },
    parameterIds: { type: "array", items: { type: "string" } },
    scenarioTags: { type: "array", items: { type: "string" } },
    sourceYear: { anyOf: [{ type: "integer" }, { type: "null" }] },
    sourceLocator: { type: "string" },
    claimScope: { type: "string" },
    implementationName: { anyOf: [{ type: "string" }, { type: "null" }] },
    implementationVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
    thetaSupportStatus: { enum: ["supported", "conditional", "unsupported", "unknown"] },
    confidence: { enum: ["low", "medium", "high"] },
    conflictGroupId: { anyOf: [{ type: "string" }, { type: "null" }] },
    retrievalRoutes: { type: "array", items: { type: "object", additionalProperties: true } },
    matchedQueries: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: "object",
  required: ["schemaVersion", "query", "evidence", "noEvidence", "retrievalTrace"],
  properties: {
    schemaVersion: { const: "1.1.0" },
    query: { type: "string" },
    evidence: { type: "array", items: evidenceSchema },
    noEvidence: { type: "boolean" },
    retrievalTrace: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
};

export const thetaRagSearchToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.ragSearch,
  version: "1.1.0",
  displayName: "Search THETA Evidence",
  description: "Search the operator-built local FTS5 knowledge index.",
  tags: ["theta", "rag", "evidence"],
  inputSchema,
  outputSchema,
  sideEffectLevel: "read",
  permissionScope: [THETA_PERMISSION_SCOPES.ragRead],
  timeoutPolicy: { timeoutMs: 5000, onTimeout: "fail" },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: {
    enabled: true,
    includeInput: true,
    includeOutput: true,
  },
  source: "local",
};

export const thetaRagSearchHandler: ToolHandler<
  unknown,
  ThetaRagSearchOutput
> = async (input) => {
  if (!input || typeof input !== "object") {
    throw new Error("rag.search input must be an object.");
  }
  const normalized = input as ThetaRagSearchInput;
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const databasePath =
    process.env.THETA_KNOWLEDGE_INDEX ??
    path.join(packageRoot, ".theta_agent", "knowledge.sqlite");
  if (!existsSync(databasePath)) {
    return {
      schemaVersion: "1.1.0",
      query: normalized.query,
      evidence: [],
      noEvidence: true,
      retrievalTrace: {
        schemaVersion: "1.0.0",
        subqueries: [], routesUsed: [], candidateCount: 0, selectedCount: 0,
        sourceCap: 3, coverage: [], noEvidence: true,
      },
    };
  }

  const index = await FtsEvidenceIndex.open(databasePath, packageRoot);
  try {
    const expandedQuery = [normalized.query, ...(normalized.purposes ?? [])].join(' ');
    const result = index.searchMulti(expandedQuery, Math.min(30, Math.max(normalized.limit ?? 12, 24)));
    let evidence = result.evidence
      .filter((item) => !normalized.modelIds?.length || normalized.modelIds.some((modelId) => item.modelIds?.includes(modelId)))
      .filter((item) => !normalized.evidenceTypes?.length || (item.objectType !== undefined && normalized.evidenceTypes.includes(item.objectType)))
      .filter((item) => !normalized.authorityLevels?.length || normalized.authorityLevels.includes(item.authority))
      .slice(0, normalized.limit ?? 12);
    // A natural-language query can rank globally relevant objects above every
    // object for a requested model and then lose them during post-filtering.
    // Fall back to exact model aliases so a populated local knowledge base is
    // never reported as empty merely because filtering happened after ranking.
    if (evidence.length === 0 && normalized.modelIds?.length) {
      const fallback = normalized.modelIds.flatMap((modelId) => index.searchMulti(modelId, 30).evidence);
      evidence = [...new Map(fallback
        .filter((item) => normalized.modelIds?.some((modelId) => item.modelIds?.includes(modelId)))
        .filter((item) => !normalized.evidenceTypes?.length || (item.objectType !== undefined && normalized.evidenceTypes.includes(item.objectType)))
        .filter((item) => !normalized.authorityLevels?.length || normalized.authorityLevels.includes(item.authority))
        .map((item) => [item.evidenceId, item] as const)).values()]
        .slice(0, normalized.limit ?? 12);
    }
    const parsedEvidence = evidence.map((item) => evidenceRefSchema.parse(item));
    return {
      schemaVersion: "1.1.0",
      query: normalized.query,
      evidence: parsedEvidence,
      noEvidence: parsedEvidence.length === 0,
      retrievalTrace: {
        ...result.trace,
        selectedCount: parsedEvidence.length,
        noEvidence: parsedEvidence.length === 0,
      },
    };
  } finally {
    index.close();
  }
};
