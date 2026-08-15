import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';

export interface DatasetObservationReceipt {
  observationRef: string;
  runId: string;
  datasetHash: string;
  toolId: string;
  outputHash: string;
  observedAt: string;
}

export class SQLiteDatasetObservationStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename = defaultThetaV6RuntimeDb()) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_dataset_observations (
        observation_ref TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        output_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_observations_run
        ON theta_dataset_observations(run_id, dataset_hash, observed_at);
    `);
  }

  record(receipt: DatasetObservationReceipt): DatasetObservationReceipt {
    this.database.prepare(`
      INSERT OR IGNORE INTO theta_dataset_observations
        (observation_ref, run_id, dataset_hash, tool_id, output_hash, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      receipt.observationRef,
      receipt.runId,
      receipt.datasetHash,
      receipt.toolId,
      receipt.outputHash,
      receipt.observedAt,
    );
    return structuredClone(receipt);
  }

  requireAll(runId: string, datasetHash: string, refs: readonly string[]): DatasetObservationReceipt[] {
    const unique = [...new Set(refs)];
    return unique.map((ref) => {
      const row = this.database.prepare(`
        SELECT * FROM theta_dataset_observations
        WHERE observation_ref = ? AND run_id = ? AND dataset_hash = ?
      `).get(ref, runId, datasetHash) as Row | undefined;
      if (!row) throw new Error(`Dataset observation is unknown or stale: ${ref}`);
      return {
        observationRef: row.observation_ref,
        runId: row.run_id,
        datasetHash: row.dataset_hash,
        toolId: row.tool_id,
        outputHash: row.output_hash,
        observedAt: row.observed_at,
      };
    });
  }

  close(): void {
    this.database.close();
  }
}

interface Row {
  observation_ref: string;
  run_id: string;
  dataset_hash: string;
  tool_id: string;
  output_hash: string;
  observed_at: string;
}
