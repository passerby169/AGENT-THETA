import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThetaWorkflowDb } from '../theta-workflow-runtime.js';

export interface LocalRunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
}

export const listLocalRuns = (
  runtimeDb = defaultThetaWorkflowDb(),
  limit = 30,
): LocalRunSummary[] => {
  const database = new DatabaseSync(path.resolve(runtimeDb));
  try {
    try {
      return database
        .prepare(
          `SELECT run_id AS runId, MAX(timestamp) AS updatedAt, COUNT(*) AS eventCount
           FROM runtime_events
           GROUP BY run_id
           ORDER BY updatedAt DESC
           LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 100))) as unknown as LocalRunSummary[];
    } catch {
      return [];
    }
  } finally {
    database.close();
  }
};
