import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_CONTRACT_VERSION,
  type ColumnConfirmation,
  type ResearchBrief,
} from "./agent/research-contracts.js";
import { recommendModels, type CatalogModel } from "./recommendation/engine.js";
import { FtsEvidenceIndex } from "./rag/fts-index.js";
import { loadKnowledgeManifest } from "./rag/manifest.js";
import { runThetaRagSearch } from "./tools/hypha-runner.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = await loadKnowledgeManifest(
  path.join(packageRoot, "knowledge", "manifest.yaml"),
  packageRoot,
);
const root = await mkdtemp(path.join(os.tmpdir(), "theta-rag-golden-"));
const databasePath = path.join(root, "knowledge.sqlite");
const index = await FtsEvidenceIndex.open(databasePath, packageRoot);

try {
  const firstBuild = await index.build(manifest);
  assert.equal(firstBuild.indexedSources, manifest.sources.length);
  assert.ok(firstBuild.indexedChunks > 0);
  const secondBuild = await index.build(manifest);
  assert.equal(secondBuild.unchangedSources, manifest.sources.length);

  const evidence = index.search("dtm time topic evolution requirements", 8);
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every((item) => !path.isAbsolute(item.relativePath)));
  assert.ok(evidence.every((item) => item.sourceCommit.length >= 7));

  process.env.THETA_KNOWLEDGE_INDEX = databasePath;
  const governedSearch = await runThetaRagSearch({
    query: "dtm time topic evolution requirements",
    limit: 5,
  });
  assert.equal(governedSearch.status, "completed");
  assert.ok((governedSearch.output?.evidence.length ?? 0) > 0);

  const brief: ResearchBrief = {
    schemaVersion: RESEARCH_CONTRACT_VERSION,
    researchQuestion: "How do topics evolve over time?",
    dataSources: ["local-csv"],
    analysisUnit: "document",
    language: "en",
    comparisonGroups: [],
    topicGranularity: "medium",
    knownBiases: [],
    sensitiveData: { status: "no", categories: [] },
    successCriteria: ["coherent temporal topics"],
    hardwareLimit: { device: "gpu", memoryGb: 16 },
    textFieldIntent: "document body",
    trendAnalysis: true,
    offlineOnly: true,
    requestedEmbedding: "local",
    candidateTimeColumns: ["created_at"],
    candidateGroupColumns: [],
    unknownFields: [],
  };
  const columns: ColumnConfirmation = {
    schemaVersion: RESEARCH_CONTRACT_VERSION,
    datasetSha256: "a".repeat(64),
    textColumns: ["text"],
    timeColumn: "created_at",
    idColumn: "id",
    metadataColumns: ["group"],
    confirmedBy: "golden",
    confirmedAt: "2026-07-28T00:00:00.000Z",
  };
  const models: CatalogModel[] = [
    model("lda", "LDA", "traditional", ["bow"]),
    model("dtm", "Dynamic Topic Model", "neural", ["bow", "sbert", "time"]),
    model("stm", "Structural Topic Model", "traditional", [
      "bow",
      "covariates",
    ]),
    model("theta", "THETA", "neural", ["bow", "qwen"]),
  ];
  const base = {
    catalogSource: "theta-model-catalog",
    models,
    dataProfile: {
      rowCount: 400,
      columnCandidates: {
        text: [{ name: "text" }],
        time: [{ name: "created_at" }],
        metadata: [{ name: "group" }],
      },
      textLengthDistribution: { average: 120, maximum: 1000 },
    },
    researchBrief: brief,
    columnConfirmation: columns,
    evidence,
  };

  const result = recommendModels(base);
  const replay = recommendModels(base);
  assert.deepEqual(result, replay);
  assert.equal(result.recommendations[0]?.modelId, "dtm");
  assert.equal(result.recommendations[0]?.topicRecommendation.firstRun, 10);
  assert.ok((result.recommendations[0]?.evidenceRefs.length ?? 0) > 0);
  assert.ok(
    result.recommendations[0]?.parameters.every(
      (parameter) => parameter.reasonCodes.length > 0,
    ),
  );

  const withoutTime = recommendModels({
    ...base,
    columnConfirmation: { ...columns, timeColumn: null },
    dataProfile: {
      ...base.dataProfile,
      columnCandidates: {
        text: [{ name: "text" }],
        time: [],
        metadata: [{ name: "group" }],
      },
    },
  });
  assert.ok(
    withoutTime.skipped.some(
      (item) =>
        item.modelId === "dtm" &&
        item.reasonCodes.includes("TIME_COLUMN_REQUIRED"),
    ),
  );

  const unavailable = recommendModels({
    ...base,
    constraints: { unavailableRequirements: ["sbert"] },
  });
  assert.ok(
    unavailable.skipped.some(
      (item) =>
        item.modelId === "dtm" &&
        item.reasonCodes.includes("DEPENDENCY_UNAVAILABLE"),
    ),
  );

  console.log(
    JSON.stringify({
      status: "ok",
      indexedSources: firstBuild.indexedSources,
      indexedChunks: firstBuild.indexedChunks,
      evidenceCount: evidence.length,
      topModelId: result.recommendations[0]?.modelId,
      hardConstraintCases: 2,
      deterministic: true,
    }),
  );
} finally {
  index.close();
  delete process.env.THETA_KNOWLEDGE_INDEX;
  await rm(root, { recursive: true, force: true });
}

function model(
  id: string,
  name: string,
  type: string,
  requires: string[],
): CatalogModel {
  return {
    id,
    name,
    type,
    requires,
    params: {
      num_topics: { default: 20 },
      batch_size: { default: 64 },
      epochs: { default: 100 },
    },
    runnable: true,
  };
}
