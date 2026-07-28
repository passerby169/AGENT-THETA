import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  evidenceRefSchema,
  type EvidenceRef,
  type KnowledgeManifest,
} from "./contracts.js";
import { resolveKnowledgeSources } from "./manifest.js";

interface Chunk {
  evidenceId: string;
  sourceId: string;
  authority: EvidenceRef["authority"];
  relativePath: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  sourceCommit: string;
  contentHash: string;
  excerpt: string;
}

export interface KnowledgeBuildResult {
  indexedSources: number;
  unchangedSources: number;
  indexedChunks: number;
}

const authorityScore: Record<EvidenceRef["authority"], number> = {
  L1: 40,
  L2: 30,
  L3: 20,
  L4: 10,
};

export class FtsEvidenceIndex {
  private readonly db: DatabaseSync;

  constructor(
    private readonly databasePath: string,
    private readonly packageRoot: string,
  ) {
    this.db = new DatabaseSync(databasePath);
    this.initialize();
  }

  static async open(
    databasePath: string,
    packageRoot: string,
  ): Promise<FtsEvidenceIndex> {
    if (databasePath !== ":memory:") {
      await mkdir(path.dirname(databasePath), { recursive: true });
    }
    return new FtsEvidenceIndex(databasePath, packageRoot);
  }

  close(): void {
    this.db.close();
  }

  async build(manifest: KnowledgeManifest): Promise<KnowledgeBuildResult> {
    const sources = resolveKnowledgeSources(manifest, this.packageRoot);
    let unchangedSources = 0;
    let indexedChunks = 0;

    for (const source of sources) {
      const content = await readFile(source.absolutePath, "utf8");
      const sourceHash = sha256(content);
      const existing = this.db
        .prepare(
          "SELECT content_hash AS contentHash FROM knowledge_sources WHERE source_id = ?",
        )
        .get(source.sourceId) as { contentHash?: string } | undefined;
      if (existing?.contentHash === sourceHash) {
        unchangedSources += 1;
        continue;
      }

      const chunks = chunkSource({
        sourceId: source.sourceId,
        authority: source.authority,
        relativePath: source.relativePath,
        sourceCommit: source.sourceCommit,
        content,
      });
      this.replaceSource(source.sourceId, sourceHash, chunks);
      indexedChunks += chunks.length;
    }

    return {
      indexedSources: sources.length - unchangedSources,
      unchangedSources,
      indexedChunks,
    };
  }

  search(query: string, limit = 8): EvidenceRef[] {
    const matchQuery = toMatchQuery(query);
    if (!matchQuery) return [];

    const rows = this.db
      .prepare(
        `SELECT
           c.evidence_id AS evidenceId,
           c.source_id AS sourceId,
           c.authority,
           c.relative_path AS relativePath,
           c.symbol,
           c.start_line AS startLine,
           c.end_line AS endLine,
           c.source_commit AS sourceCommit,
           c.content_hash AS contentHash,
           c.excerpt,
           bm25(knowledge_fts) AS textRank
         FROM knowledge_fts
         JOIN knowledge_chunks c
           ON c.evidence_id = knowledge_fts.evidence_id
         WHERE knowledge_fts MATCH ?
         ORDER BY textRank
         LIMIT ?`,
      )
      .all(matchQuery, Math.max(1, Math.min(limit, 20))) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => {
      const authority = String(row.authority) as EvidenceRef["authority"];
      const rank = Math.abs(Number(row.textRank ?? 0));
      const textScore = Math.max(0, 60 - Math.min(60, rank * 10));
      return evidenceRefSchema.parse({
        evidenceId: row.evidenceId,
        sourceId: row.sourceId,
        authority,
        relativePath: row.relativePath,
        symbol: row.symbol ?? null,
        startLine: row.startLine,
        endLine: row.endLine,
        sourceCommit: row.sourceCommit,
        contentHash: row.contentHash,
        excerpt: row.excerpt,
        finalScore: Math.min(100, authorityScore[authority] + textScore),
      });
    });
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        source_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        evidence_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        symbol TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        source_commit TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        excerpt TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        evidence_id UNINDEXED,
        source_id UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
  }

  private replaceSource(
    sourceId: string,
    contentHash: string,
    chunks: readonly Chunk[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM knowledge_fts WHERE source_id = ?")
        .run(sourceId);
      this.db
        .prepare("DELETE FROM knowledge_chunks WHERE source_id = ?")
        .run(sourceId);

      const insertChunk = this.db.prepare(
        `INSERT INTO knowledge_chunks (
           evidence_id, source_id, authority, relative_path, symbol,
           start_line, end_line, source_commit, content_hash, excerpt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare(
        "INSERT INTO knowledge_fts (evidence_id, source_id, content) VALUES (?, ?, ?)",
      );
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.evidenceId,
          chunk.sourceId,
          chunk.authority,
          chunk.relativePath,
          chunk.symbol,
          chunk.startLine,
          chunk.endLine,
          chunk.sourceCommit,
          chunk.contentHash,
          chunk.excerpt,
        );
        insertFts.run(chunk.evidenceId, chunk.sourceId, chunk.excerpt);
      }
      this.db
        .prepare(
          `INSERT INTO knowledge_sources (source_id, content_hash)
           VALUES (?, ?)
           ON CONFLICT(source_id) DO UPDATE SET content_hash = excluded.content_hash`,
        )
        .run(sourceId, contentHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const chunkSource = (input: {
  sourceId: string;
  authority: EvidenceRef["authority"];
  relativePath: string;
  sourceCommit: string;
  content: string;
}): Chunk[] => {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  const chunks: Chunk[] = [];
  const chunkSize = 18;
  const overlap = 3;
  for (let start = 0; start < lines.length; start += chunkSize - overlap) {
    const slice = lines.slice(start, start + chunkSize);
    const excerpt = slice.join("\n").trim();
    if (!excerpt) continue;
    const startLine = start + 1;
    const endLine = Math.min(lines.length, start + slice.length);
    const contentHash = sha256(excerpt);
    const symbol =
      slice
        .map((line) => line.match(/^\s*(?:#{1,6}\s+|([a-zA-Z0-9_-]+):)/))
        .find(Boolean)?.[1] ?? null;
    chunks.push({
      evidenceId: sha256(
        `${input.sourceId}:${startLine}:${endLine}:${contentHash}`,
      ).slice(0, 32),
      sourceId: input.sourceId,
      authority: input.authority,
      relativePath: input.relativePath,
      symbol,
      startLine,
      endLine,
      sourceCommit: input.sourceCommit,
      contentHash,
      excerpt: excerpt.slice(0, 1200),
    });
  }
  return chunks;
};

const toMatchQuery = (query: string): string => {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter((term) => term.length > 1),
    ),
  ].slice(0, 12);
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
