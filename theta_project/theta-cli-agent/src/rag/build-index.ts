import path from "node:path";
import { fileURLToPath } from "node:url";
import { FtsEvidenceIndex } from "./fts-index.js";
import { loadKnowledgeManifest } from "./manifest.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifestPath = path.join(packageRoot, "knowledge", "manifest.yaml");
const databasePath =
  process.env.THETA_KNOWLEDGE_INDEX ??
  path.join(packageRoot, ".theta_agent", "knowledge.sqlite");

const manifest = await loadKnowledgeManifest(manifestPath, packageRoot);
const index = await FtsEvidenceIndex.open(databasePath, packageRoot);
try {
  const result = await index.build(manifest);
  console.log(
    JSON.stringify({
      status: "ok",
      database: path.relative(packageRoot, databasePath),
      ...result,
    }),
  );
} finally {
  index.close();
}
