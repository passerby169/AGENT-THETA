import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evidenceRefSchema } from "./rag/contracts.js";
import { FtsEvidenceIndex } from "./rag/fts-index.js";
import { loadKnowledgeManifest } from "./rag/manifest.js";

const evaluationSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    minimumRecallAt5: z.number().min(0).max(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            query: z.string().min(1),
            expectedSourceIds: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    noEvidenceCases: z.array(
      z
        .object({
          id: z.string().min(1),
          query: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const evaluation = evaluationSchema.parse(
  JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        "fixtures",
        "evaluation",
        "rag-cases.json",
      ),
      "utf8",
    ),
  ),
);
const manifest = await loadKnowledgeManifest(
  path.join(packageRoot, "knowledge", "manifest.yaml"),
  packageRoot,
);
const sourceCommits = new Map(
  manifest.sources.map((source) => [source.sourceId, source.sourceCommit]),
);
const root = await mkdtemp(path.join(os.tmpdir(), "theta-rag-evaluation-"));
const index = await FtsEvidenceIndex.open(
  path.join(root, "knowledge.sqlite"),
  packageRoot,
);

try {
  const build = await index.build(manifest);
  assert.equal(build.indexedSources, manifest.sources.length);

  let passed = 0;
  for (const testCase of evaluation.cases) {
    const first = index.search(testCase.query, 5);
    const second = index.search(testCase.query, 5);
    assert.deepEqual(first, second, `${testCase.id} was not deterministic.`);
    assert.ok(first.length > 0, `${testCase.id} returned no evidence.`);
    for (const evidence of first) {
      evidenceRefSchema.parse(evidence);
      assert.equal(path.isAbsolute(evidence.relativePath), false);
      assert.equal(
        evidence.sourceCommit,
        sourceCommits.get(evidence.sourceId),
      );
    }
    const sourceIds = new Set(first.map((item) => item.sourceId));
    if (
      testCase.expectedSourceIds.some((sourceId) => sourceIds.has(sourceId))
    ) {
      passed += 1;
    }
  }

  for (const testCase of evaluation.noEvidenceCases) {
    assert.deepEqual(
      index.search(testCase.query, 5),
      [],
      `${testCase.id} fabricated evidence for an unindexable query.`,
    );
  }

  const recallAt5 = passed / evaluation.cases.length;
  assert.ok(
    recallAt5 >= evaluation.minimumRecallAt5,
    `RAG recall@5 ${recallAt5} is below ${evaluation.minimumRecallAt5}.`,
  );

  console.log(
    JSON.stringify({
      status: "ok",
      cases: evaluation.cases.length,
      noEvidenceCases: evaluation.noEvidenceCases.length,
      recallAt5,
      indexedSources: manifest.sources.length,
    }),
  );
} finally {
  index.close();
  await rm(root, { recursive: true, force: true });
}
