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
    model("btm", "Biterm Topic Model", "traditional", ["bow"]),
    model("hdp", "Hierarchical Dirichlet Process", "traditional", ["bow"]),
    model("dtm", "Dynamic Topic Model", "neural", ["bow", "sbert", "time"]),
    model("stm", "Structural Topic Model", "traditional", [
      "bow",
      "covariates",
    ]),
    model("bertopic", "BERTopic", "neural", ["sbert", "text"]),
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

  const staticBrief = {
    ...brief,
    trendAnalysis: false,
    requestedEmbedding: "none" as const,
    comparisonGroups: [],
  };
  const confirmedWithoutCovariates: ColumnConfirmation = {
    ...columns,
    covariateColumns: [],
    metadataColumns: ["industry"],
    groupingColumns: ["industry"],
  };
  const staticBase = {
    ...base,
    evidence: [],
    researchBrief: staticBrief,
    columnConfirmation: confirmedWithoutCovariates,
    dataProfile: {
      ...base.dataProfile,
      textLengthDistribution: { average: 120, maximum: 1000 },
      columnCandidates: {
        text: [{ name: "text" }],
        time: [{ name: "created_at" }],
        metadata: [{ name: "industry" }],
      },
    },
  };

  const classicalBaseline = recommendModels({
    ...staticBase,
    researchGoal: "我要经典词袋基线",
  });
  assert.equal(classicalBaseline.recommendations[0]?.modelId, "lda");
  assert.ok(
    classicalBaseline.recommendations[0]?.reasonCodes.includes(
      "BASELINE_CLASSICAL_LDA",
    ),
  );
  assert.ok(
    classicalBaseline.skipped.some(
      (item) =>
        item.modelId === "bertopic" &&
        item.reasonCodes.includes("SEMANTIC_CLUSTERING_GOAL_REQUIRED") &&
        item.reasonCodes.includes("LOCAL_EMBEDDING_REQUIRED"),
    ),
  );

  const shortText = recommendModels({
    ...staticBase,
    researchGoal: "分析每条约 20 字的短评论",
    dataProfile: {
      ...staticBase.dataProfile,
      textLengthDistribution: { average: 20, maximum: 60 },
    },
  });
  assert.equal(shortText.recommendations[0]?.modelId, "btm");
  assert.ok(
    shortText.recommendations[0]?.reasonCodes.includes("SHORT_TEXT_BTM"),
  );

  const unknownTopicCount = recommendModels({
    ...staticBase,
    researchGoal: "不知道主题数量，希望自动探索主题数",
  });
  assert.equal(unknownTopicCount.recommendations[0]?.modelId, "hdp");
  assert.ok(
    unknownTopicCount.recommendations[0]?.reasonCodes.includes(
      "UNKNOWN_TOPIC_COUNT_HDP",
    ),
  );

  const covariateAnalysis = recommendModels({
    ...staticBase,
    researchGoal: "比较不同行业的主题差异",
    researchBrief: {
      ...staticBrief,
      comparisonGroups: ["industry"],
    },
    columnConfirmation: {
      ...confirmedWithoutCovariates,
      covariateColumns: ["industry"],
      groupingColumns: [],
    },
  });
  assert.equal(covariateAnalysis.recommendations[0]?.modelId, "stm");
  assert.ok(
    covariateAnalysis.recommendations[0]?.reasonCodes.includes(
      "COVARIATE_ANALYSIS_STM",
    ),
  );

  const groupingOnly = recommendModels({
    ...staticBase,
    researchGoal: "industry 只用于展示分组",
  });
  assert.ok(
    groupingOnly.skipped.some(
      (item) =>
        item.modelId === "stm" &&
        item.reasonCodes.includes("COVARIATE_COLUMN_REQUIRED"),
    ),
  );

  const semanticClustering = recommendModels({
    ...staticBase,
    researchGoal: "使用本地嵌入进行语义聚类分析",
    researchBrief: {
      ...staticBrief,
      requestedEmbedding: "local",
    },
  });
  assert.equal(semanticClustering.recommendations[0]?.modelId, "bertopic");
  assert.ok(
    semanticClustering.recommendations[0]?.reasonCodes.includes(
      "SEMANTIC_CLUSTERING_BERTOPIC",
    ),
  );
  const semanticWithoutLocalEmbedding = recommendModels({
    ...staticBase,
    researchGoal: "执行语义聚类分析",
    researchBrief: {
      ...staticBrief,
      requestedEmbedding: "unknown",
    },
  });
  assert.ok(
    semanticWithoutLocalEmbedding.skipped.some(
      (item) =>
        item.modelId === "bertopic" &&
        item.reasonCodes.includes("LOCAL_EMBEDDING_REQUIRED"),
    ),
  );

  const unconfirmedColumns = recommendModels({
    ...staticBase,
    columnConfirmation: undefined,
  });
  assert.equal(unconfirmedColumns.recommendations.length, 0);
  assert.ok(
    unconfirmedColumns.skipped.every((item) =>
      item.reasonCodes.includes("COLUMN_CONFIRMATION_REQUIRED"),
    ),
  );

  console.log(
    JSON.stringify({
      status: "ok",
      indexedSources: firstBuild.indexedSources,
      indexedChunks: firstBuild.indexedChunks,
      evidenceCount: evidence.length,
      topModelId: result.recommendations[0]?.modelId,
      hardConstraintCases: 5,
      recommendationBoundaryCases: 8,
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
