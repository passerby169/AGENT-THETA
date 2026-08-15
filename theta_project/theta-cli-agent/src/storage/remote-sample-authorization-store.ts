import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';

export interface RemoteSampleAuthorizationReceipt {
  receiptId: string;
  runId: string;
  datasetHash: string;
  userId: string;
  workspaceId: string;
  maxRows: number;
  grantedAt: string;
  expiresAt: string;
}

export class SQLiteRemoteSampleAuthorizationStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename = defaultThetaV6RuntimeDb()) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_remote_sample_authorizations (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        max_rows INTEGER NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(run_id, dataset_hash, user_id, workspace_id)
      );
    `);
  }

  grant(input: {
    runId: string;
    datasetHash: string;
    userId: string;
    workspaceId: string;
    maxRows?: number;
    ttlMinutes?: number;
  }): RemoteSampleAuthorizationReceipt {
    const grantedAt = new Date().toISOString();
    const maxRows = Math.max(1, Math.min(10, input.maxRows ?? 10));
    const ttlMinutes = Math.max(1, Math.min(24 * 60, input.ttlMinutes ?? 120));
    const expiresAt = new Date(Date.parse(grantedAt) + ttlMinutes * 60_000).toISOString();
    const receiptId = `sample-auth-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO theta_remote_sample_authorizations
        (receipt_id, run_id, dataset_hash, user_id, workspace_id, max_rows, granted_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(run_id, dataset_hash, user_id, workspace_id) DO UPDATE SET
        receipt_id = excluded.receipt_id,
        max_rows = excluded.max_rows,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        revoked_at = NULL
    `).run(
      receiptId,
      input.runId,
      input.datasetHash,
      input.userId,
      input.workspaceId,
      maxRows,
      grantedAt,
      expiresAt,
    );
    return this.requireActive(input);
  }

  active(input: {
    runId: string;
    datasetHash: string;
    userId: string;
    workspaceId: string;
  }): RemoteSampleAuthorizationReceipt | null {
    const row = this.database.prepare(`
      SELECT * FROM theta_remote_sample_authorizations
      WHERE run_id = ? AND dataset_hash = ? AND user_id = ? AND workspace_id = ?
        AND revoked_at IS NULL AND expires_at > ?
    `).get(input.runId, input.datasetHash, input.userId, input.workspaceId, new Date().toISOString()) as Row | undefined;
    return row ? toReceipt(row) : null;
  }

  requireActive(input: {
    runId: string;
    datasetHash: string;
    userId: string;
    workspaceId: string;
  }): RemoteSampleAuthorizationReceipt {
    const receipt = this.active(input);
    if (!receipt) throw new Error('No active authorization permits remote dataset samples for this Run.');
    return receipt;
  }

  close(): void {
    this.database.close();
  }
}

interface Row {
  receipt_id: string;
  run_id: string;
  dataset_hash: string;
  user_id: string;
  workspace_id: string;
  max_rows: number;
  granted_at: string;
  expires_at: string;
}

const toReceipt = (row: Row): RemoteSampleAuthorizationReceipt => ({
  receiptId: row.receipt_id,
  runId: row.run_id,
  datasetHash: row.dataset_hash,
  userId: row.user_id,
  workspaceId: row.workspace_id,
  maxRows: Number(row.max_rows),
  grantedAt: row.granted_at,
  expiresAt: row.expires_at,
});
