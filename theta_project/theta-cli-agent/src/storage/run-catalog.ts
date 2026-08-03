import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThetaWorkflowDb } from '../theta-workflow-runtime.js';

export interface LocalRunSummary {
  runId: string;
  updatedAt: string;
  eventCount: number;
  recoveryOfRunId?: string;
  successorRunId?: string;
}

export const listLocalRuns = (
  runtimeDb = defaultThetaWorkflowDb(),
  limit = 30,
): LocalRunSummary[] => {
  const database = new DatabaseSync(path.resolve(runtimeDb));
  try {
    try {
      const summaries = database
        .prepare(
          `SELECT run_id AS runId, MAX(timestamp) AS updatedAt, COUNT(*) AS eventCount
           FROM runtime_events
           GROUP BY run_id
           ORDER BY updatedAt DESC
           LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 100))) as unknown as LocalRunSummary[];
      const lineage = new Map<string, string>();
      const successor = new Map<string, string>();
      const starts = database
        .prepare("SELECT run_id AS runId, event_json AS eventJson FROM runtime_events WHERE type = 'run.started' ORDER BY timestamp ASC")
        .all() as unknown as Array<{ runId: string; eventJson: string }>;
      for (const start of starts) {
        try {
          const event = JSON.parse(start.eventJson) as { payload?: { input?: { recoveryOfRunId?: unknown } } };
          const parent = event.payload?.input?.recoveryOfRunId;
          if (typeof parent !== 'string' || !parent.trim()) continue;
          lineage.set(start.runId, parent);
          successor.set(parent, start.runId);
        } catch {
          continue;
        }
      }
      return summaries.map((summary) => ({
        ...summary,
        ...(lineage.has(summary.runId) ? { recoveryOfRunId: lineage.get(summary.runId) } : {}),
        ...(successor.has(summary.runId) ? { successorRunId: successor.get(summary.runId) } : {}),
      }));
    } catch {
      return [];
    }
  } finally {
    database.close();
  }
};
