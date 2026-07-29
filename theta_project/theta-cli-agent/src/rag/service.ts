import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { FtsEvidenceIndex } from './fts-index.js';
import { loadKnowledgeManifest } from './manifest.js';

export interface KnowledgeIndexStatus {
  schemaVersion: '1.0.0';
  status: 'ready' | 'not_built';
  database: string;
  manifest: string;
  totalSources: number;
  totalChunks: number;
}

export interface KnowledgeIndexBuildResult extends KnowledgeIndexStatus {
  status: 'ready';
  indexedSources: number;
  unchangedSources: number;
  indexedChunks: number;
}

interface KnowledgePaths {
  packageRoot: string;
  manifestPath: string;
  databasePath: string;
}

export const getKnowledgeIndexStatus =
  async (): Promise<KnowledgeIndexStatus> => {
    const paths = knowledgePaths();
    if (!existsSync(paths.databasePath)) {
      return {
        ...baseStatus(paths),
        status: 'not_built',
        totalSources: 0,
        totalChunks: 0,
      };
    }
    const database = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      return {
        ...baseStatus(paths),
        status: 'ready',
        ...readCounts(database),
      };
    } finally {
      database.close();
    }
  };

export const buildKnowledgeIndex =
  async (): Promise<KnowledgeIndexBuildResult> => {
    const paths = knowledgePaths();
    const manifest = await loadKnowledgeManifest(
      paths.manifestPath,
      paths.packageRoot,
    );
    const index = await FtsEvidenceIndex.open(
      paths.databasePath,
      paths.packageRoot,
    );
    try {
      const result = await index.build(manifest);
      return {
        ...baseStatus(paths),
        status: 'ready',
        ...result,
        ...index.counts(),
      };
    } finally {
      index.close();
    }
  };

const knowledgePaths = (): KnowledgePaths => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  return {
    packageRoot,
    manifestPath: path.join(packageRoot, 'knowledge', 'manifest.yaml'),
    databasePath:
      process.env.THETA_KNOWLEDGE_INDEX ??
      path.join(packageRoot, '.theta_agent', 'knowledge.sqlite'),
  };
};

const baseStatus = (
  paths: KnowledgePaths,
): Pick<KnowledgeIndexStatus, 'schemaVersion' | 'database' | 'manifest'> => ({
  schemaVersion: '1.0.0',
  database: displayPath(paths.packageRoot, paths.databasePath),
  manifest: displayPath(paths.packageRoot, paths.manifestPath),
});

const displayPath = (root: string, target: string): string => {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return path.basename(target);
  }
  return relative.split(path.sep).join('/');
};

const readCounts = (database: DatabaseSync) => {
  const sources = database
    .prepare('SELECT COUNT(*) AS count FROM knowledge_sources')
    .get() as { count: number };
  const chunks = database
    .prepare('SELECT COUNT(*) AS count FROM knowledge_chunks')
    .get() as { count: number };
  return {
    totalSources: Number(sources.count),
    totalChunks: Number(chunks.count),
  };
};
