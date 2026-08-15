import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const THETA_TOOL_FAILURE_LIMIT = 5 as const;

export interface ToolFailureCircuitState {
  runId: string;
  phase: string;
  datasetHash: string;
  toolId: string;
  consecutiveFailures: number;
  open: boolean;
  lastErrorMessage?: string;
}

export class ThetaToolCircuitOpenError extends Error {
  readonly code = 'THETA_TOOL_FAILURE_CIRCUIT_OPEN';

  constructor(readonly state: ToolFailureCircuitState) {
    super(`工具“${state.toolId}”已连续失败 ${state.consecutiveFailures} 次。最后原因：${state.lastErrorMessage ?? '工具调用失败'}。系统已停止继续调用。`);
    this.name = 'ThetaToolCircuitOpenError';
  }
}

export class SQLiteToolFailureCircuitBreaker {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_tool_failure_circuits (
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        circuit_open INTEGER NOT NULL,
        last_error_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, phase, dataset_hash, tool_id)
      );
    `);
  }

  recordFailure(input: Omit<ToolFailureCircuitState, 'consecutiveFailures' | 'open'> & { lastErrorMessage: string }): ToolFailureCircuitState {
    const current = this.get(input) ?? { ...input, consecutiveFailures: 0, open: false };
    const consecutiveFailures = current.consecutiveFailures + 1;
    const open = consecutiveFailures > THETA_TOOL_FAILURE_LIMIT;
    this.database.prepare(`
      INSERT INTO theta_tool_failure_circuits
      (run_id, phase, dataset_hash, tool_id, consecutive_failures, circuit_open, last_error_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, phase, dataset_hash, tool_id) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        circuit_open = excluded.circuit_open,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at
    `).run(input.runId, input.phase, input.datasetHash, input.toolId, consecutiveFailures, open ? 1 : 0, input.lastErrorMessage, new Date().toISOString());
    return { ...input, consecutiveFailures, open };
  }

  recordSuccess(input: Pick<ToolFailureCircuitState, 'runId' | 'phase' | 'datasetHash' | 'toolId'>): void {
    this.database.prepare(`
      DELETE FROM theta_tool_failure_circuits
      WHERE run_id = ? AND phase = ? AND dataset_hash = ? AND tool_id = ?
    `).run(input.runId, input.phase, input.datasetHash, input.toolId);
  }

  get(input: Pick<ToolFailureCircuitState, 'runId' | 'phase' | 'datasetHash' | 'toolId'>): ToolFailureCircuitState | null {
    const row = this.database.prepare(`
      SELECT * FROM theta_tool_failure_circuits
      WHERE run_id = ? AND phase = ? AND dataset_hash = ? AND tool_id = ?
    `).get(input.runId, input.phase, input.datasetHash, input.toolId) as Row | undefined;
    return row ? {
      runId: row.run_id,
      phase: row.phase,
      datasetHash: row.dataset_hash,
      toolId: row.tool_id,
      consecutiveFailures: Number(row.consecutive_failures),
      open: row.circuit_open === 1,
      ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    } : null;
  }

  close(): void {
    this.database.close();
  }
}

interface Row {
  run_id: string;
  phase: string;
  dataset_hash: string;
  tool_id: string;
  consecutive_failures: number;
  circuit_open: number;
  last_error_message: string | null;
}
