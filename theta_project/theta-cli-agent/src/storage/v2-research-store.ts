import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  datasetConfirmationSchema,
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  researchIntentSchema,
  type DatasetConfirmation,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
  type ResearchIntent,
} from '../dataset-understanding/contracts.js';
import {
  interviewMemorySchema,
  type InterviewMemory,
} from '../agent/decision-gap.js';
import { defaultThetaWorkflowDb } from '../theta-workflow-runtime.js';

type RevisionKind = 'facts' | 'understanding' | 'intent';

export interface ResearchRevision<T> {
  runId: string;
  revision: number;
  datasetRef?: string;
  datasetHash?: string;
  value: T;
  createdAt: string;
}

export class SQLiteV2ResearchStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename = defaultThetaWorkflowDb()) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_dataset_fact_snapshots (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_facts_hash
        ON theta_dataset_fact_snapshots(dataset_ref, dataset_hash, created_at DESC);

      CREATE TABLE IF NOT EXISTS theta_dataset_understanding_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_understanding_hash
        ON theta_dataset_understanding_revisions(dataset_ref, dataset_hash, created_at DESC);

      CREATE TABLE IF NOT EXISTS theta_dataset_confirmations (
        run_id TEXT PRIMARY KEY,
        dataset_ref TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS theta_research_intent_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, revision)
      );

      CREATE TABLE IF NOT EXISTS theta_interview_memory (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  appendFacts(runId: string, value: DatasetFacts): ResearchRevision<DatasetFacts> {
    const facts = datasetFactsSchema.parse(value);
    return this.appendRevision('facts', runId, facts, facts.datasetRef, facts.datasetHash);
  }

  latestFacts(runId: string): ResearchRevision<DatasetFacts> | undefined {
    const row = this.latestRevision('facts', runId);
    return row
      ? { ...row, value: datasetFactsSchema.parse(JSON.parse(row.payloadJson)) }
      : undefined;
  }

  appendUnderstanding(
    runId: string,
    value: DatasetUnderstandingDraft,
  ): ResearchRevision<DatasetUnderstandingDraft> {
    const draft = datasetUnderstandingDraftSchema.parse(value);
    return this.appendRevision(
      'understanding',
      runId,
      draft,
      draft.datasetRef,
      draft.datasetHash,
    );
  }

  latestUnderstanding(
    runId: string,
  ): ResearchRevision<DatasetUnderstandingDraft> | undefined {
    const row = this.latestRevision('understanding', runId);
    return row
      ? {
          ...row,
          value: datasetUnderstandingDraftSchema.parse(JSON.parse(row.payloadJson)),
        }
      : undefined;
  }

  saveConfirmation(runId: string, value: DatasetConfirmation): DatasetConfirmation {
    const confirmation = datasetConfirmationSchema.parse(value);
    this.database
      .prepare(`
        INSERT INTO theta_dataset_confirmations
          (run_id, dataset_ref, dataset_hash, payload_json, confirmed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          dataset_ref = excluded.dataset_ref,
          dataset_hash = excluded.dataset_hash,
          payload_json = excluded.payload_json,
          confirmed_at = excluded.confirmed_at
      `)
      .run(
        runId,
        confirmation.datasetRef,
        confirmation.datasetHash,
        JSON.stringify(confirmation),
        confirmation.confirmedAt,
      );
    return confirmation;
  }

  confirmation(runId: string): DatasetConfirmation | undefined {
    const row = this.database
      .prepare('SELECT payload_json FROM theta_dataset_confirmations WHERE run_id = ?')
      .get(runId) as { payload_json: string } | undefined;
    return row ? datasetConfirmationSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  appendIntent(runId: string, value: ResearchIntent): ResearchRevision<ResearchIntent> {
    const intent = researchIntentSchema.parse(value);
    return this.appendRevision('intent', runId, intent);
  }

  latestIntent(runId: string): ResearchRevision<ResearchIntent> | undefined {
    const row = this.latestRevision('intent', runId);
    return row
      ? { ...row, value: researchIntentSchema.parse(JSON.parse(row.payloadJson)) }
      : undefined;
  }

  saveInterviewMemory(runId: string, value: InterviewMemory): InterviewMemory {
    const memory = interviewMemorySchema.parse(value);
    this.database
      .prepare(`
        INSERT INTO theta_interview_memory (run_id, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      .run(runId, JSON.stringify(memory), new Date().toISOString());
    return memory;
  }

  interviewMemory(runId: string): InterviewMemory | undefined {
    const row = this.database
      .prepare('SELECT payload_json FROM theta_interview_memory WHERE run_id = ?')
      .get(runId) as { payload_json: string } | undefined;
    return row ? interviewMemorySchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  invalidateAfterDatasetHashChange(runId: string, currentHash: string): void {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database
        .prepare('DELETE FROM theta_dataset_confirmations WHERE run_id = ? AND dataset_hash <> ?')
        .run(runId, currentHash);
      this.database
        .prepare(`
          DELETE FROM theta_dataset_understanding_revisions
          WHERE run_id = ? AND dataset_hash <> ?
        `)
        .run(runId, currentHash);
      this.database
        .prepare('DELETE FROM theta_research_intent_revisions WHERE run_id = ?')
        .run(runId);
      this.database
        .prepare('DELETE FROM theta_interview_memory WHERE run_id = ?')
        .run(runId);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private appendRevision<T>(
    kind: RevisionKind,
    runId: string,
    value: T,
    datasetRef?: string,
    datasetHash?: string,
  ): ResearchRevision<T> {
    const table = tableName(kind);
    const revision = this.nextRevision(table, runId);
    const createdAt = new Date().toISOString();
    if (kind === 'intent') {
      this.database
        .prepare(`
          INSERT INTO ${table} (run_id, revision, payload_json, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(runId, revision, JSON.stringify(value), createdAt);
    } else {
      if (!datasetRef || !datasetHash) {
        throw new Error(`${kind} revisions require datasetRef and datasetHash.`);
      }
      this.database
        .prepare(`
          INSERT INTO ${table}
            (run_id, revision, dataset_ref, dataset_hash, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(runId, revision, datasetRef, datasetHash, JSON.stringify(value), createdAt);
    }
    return { runId, revision, datasetRef, datasetHash, value, createdAt };
  }

  private latestRevision(
    kind: RevisionKind,
    runId: string,
  ): StoredRevision | undefined {
    const row = this.database
      .prepare(`
        SELECT revision, payload_json, created_at,
               ${kind === 'intent' ? 'NULL' : 'dataset_ref'} AS dataset_ref,
               ${kind === 'intent' ? 'NULL' : 'dataset_hash'} AS dataset_hash
        FROM ${tableName(kind)}
        WHERE run_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `)
      .get(runId) as RevisionRow | undefined;
    return row
      ? {
          runId,
          revision: Number(row.revision),
          ...(row.dataset_ref ? { datasetRef: row.dataset_ref } : {}),
          ...(row.dataset_hash ? { datasetHash: row.dataset_hash } : {}),
          payloadJson: row.payload_json,
          createdAt: row.created_at,
        }
      : undefined;
  }

  private nextRevision(table: string, runId: string): number {
    const row = this.database
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM ${table} WHERE run_id = ?`)
      .get(runId) as { revision: number };
    return Number(row.revision) + 1;
  }
}

interface RevisionRow {
  revision: number;
  dataset_ref: string | null;
  dataset_hash: string | null;
  payload_json: string;
  created_at: string;
}

interface StoredRevision {
  runId: string;
  revision: number;
  datasetRef?: string;
  datasetHash?: string;
  payloadJson: string;
  createdAt: string;
}

const tableName = (kind: RevisionKind): string => ({
  facts: 'theta_dataset_fact_snapshots',
  understanding: 'theta_dataset_understanding_revisions',
  intent: 'theta_research_intent_revisions',
})[kind];
