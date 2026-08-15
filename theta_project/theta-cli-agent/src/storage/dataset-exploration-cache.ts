import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ThetaDatasetExploreOutput } from '../tools/dataset-exploration-contracts.js';

export const THETA_DATASET_READER_VERSION = '2.0.0' as const;

export class SQLiteDatasetExplorationCache {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_dataset_exploration_cache (
        dataset_hash TEXT NOT NULL,
        sheet_key TEXT NOT NULL,
        reader_version TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (dataset_hash, sheet_key, reader_version)
      );
    `);
  }

  get(datasetHash: string, sheetName?: string): ThetaDatasetExploreOutput | null {
    const row = this.database.prepare(`
      SELECT output_json FROM theta_dataset_exploration_cache
      WHERE dataset_hash = ? AND sheet_key = ? AND reader_version = ?
    `).get(datasetHash, sheetName?.trim() || '__auto__', THETA_DATASET_READER_VERSION) as { output_json: string } | undefined;
    return row ? JSON.parse(row.output_json) as ThetaDatasetExploreOutput : null;
  }

  put(datasetHash: string, sheetName: string | undefined, output: ThetaDatasetExploreOutput): void {
    this.database.prepare(`
      INSERT INTO theta_dataset_exploration_cache
      (dataset_hash, sheet_key, reader_version, output_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(dataset_hash, sheet_key, reader_version) DO UPDATE SET
        output_json = excluded.output_json,
        created_at = excluded.created_at
    `).run(
      datasetHash,
      sheetName?.trim() || '__auto__',
      THETA_DATASET_READER_VERSION,
      JSON.stringify(output),
      new Date().toISOString(),
    );
  }

  close(): void {
    this.database.close();
  }
}
