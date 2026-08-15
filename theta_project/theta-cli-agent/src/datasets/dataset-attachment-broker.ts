import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatasetIngestionService, type PublicDatasetRecord } from './dataset-ingestion-service.js';

export type DatasetUploadRequestStatus = 'waiting_for_file' | 'attachment_ready' | 'ingested' | 'cancelled';

export interface DatasetUploadRequestRecord {
  uploadRequestId: string;
  runId: string;
  userId: string;
  workspaceId: string;
  reason: string;
  acceptedFormats: string[];
  status: DatasetUploadRequestStatus;
  attachmentRef?: string;
  displayName?: string;
  suffix?: string;
  sizeBytes?: number;
  sha256?: string;
  datasetRef?: string;
  allowRemoteSamples?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DatasetUploadRequestInternal extends DatasetUploadRequestRecord {
  stagedPath?: string;
}

export class SQLiteDatasetAttachmentStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS theta_dataset_upload_requests (
        upload_request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        accepted_formats_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attachment_ref TEXT,
        display_name TEXT,
        suffix TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        staged_path TEXT,
        dataset_ref TEXT,
        allow_remote_samples INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_theta_dataset_upload_run
        ON theta_dataset_upload_requests(run_id, user_id, workspace_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_theta_dataset_attachment_ref
        ON theta_dataset_upload_requests(attachment_ref)
        WHERE attachment_ref IS NOT NULL;
    `);
    const columns = this.database.prepare('PRAGMA table_info(theta_dataset_upload_requests)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'allow_remote_samples')) {
      this.database.exec('ALTER TABLE theta_dataset_upload_requests ADD COLUMN allow_remote_samples INTEGER;');
    }
  }

  request(input: {
    runId: string;
    userId: string;
    workspaceId: string;
    reason: string;
    acceptedFormats: string[];
  }): DatasetUploadRequestRecord {
    const existing = this.currentInternal(input.runId, input);
    if (existing && existing.status !== 'cancelled') return publicRecord(existing);
    const now = new Date().toISOString();
    const uploadRequestId = `upload_request_${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO theta_dataset_upload_requests
      (upload_request_id, run_id, user_id, workspace_id, reason,
       accepted_formats_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting_for_file', ?, ?)
    `).run(
      uploadRequestId,
      input.runId,
      input.userId,
      input.workspaceId,
      input.reason.trim(),
      JSON.stringify(input.acceptedFormats),
      now,
      now,
    );
    return this.require(uploadRequestId, input);
  }

  current(runId: string, owner: { userId: string; workspaceId: string }): DatasetUploadRequestRecord | null {
    const record = this.currentInternal(runId, owner);
    return record === null ? null : publicRecord(record);
  }

  require(uploadRequestId: string, owner: { userId: string; workspaceId: string }): DatasetUploadRequestRecord {
    return publicRecord(this.requireInternal(uploadRequestId, owner));
  }

  requireReadyAttachment(
    attachmentRef: string,
    owner: { runId: string; userId: string; workspaceId: string },
  ): DatasetUploadRequestInternal {
    const row = this.database.prepare(`
      SELECT * FROM theta_dataset_upload_requests
      WHERE attachment_ref = ? AND run_id = ? AND user_id = ? AND workspace_id = ?
    `).get(attachmentRef, owner.runId, owner.userId, owner.workspaceId) as Row | undefined;
    if (!row) throw new Error('Attachment reference is unknown or outside the current Run scope.');
    const record = rowToRecord(row);
    if (record.status !== 'attachment_ready' || !record.stagedPath || !record.sha256 || !record.suffix || record.sizeBytes === undefined) {
      throw new Error(`Attachment is not ready for ingestion: ${record.status}.`);
    }
    return record;
  }

  attach(input: {
    uploadRequestId: string;
    runId: string;
    userId: string;
    workspaceId: string;
    attachmentRef: string;
    displayName: string;
    suffix: string;
    sizeBytes: number;
    sha256: string;
    stagedPath: string;
    allowRemoteSamples: boolean;
  }): DatasetUploadRequestRecord {
    const current = this.requireInternal(input.uploadRequestId, input);
    if (current.runId !== input.runId) throw new Error('Upload request belongs to another Run.');
    if (current.status !== 'waiting_for_file') throw new Error(`Upload request cannot accept a file from ${current.status}.`);
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE theta_dataset_upload_requests
      SET status = 'attachment_ready', attachment_ref = ?, display_name = ?, suffix = ?,
          size_bytes = ?, sha256 = ?, staged_path = ?, allow_remote_samples = ?, updated_at = ?
      WHERE upload_request_id = ? AND status = 'waiting_for_file'
    `).run(
      input.attachmentRef,
      input.displayName,
      input.suffix,
      input.sizeBytes,
      input.sha256,
      path.resolve(input.stagedPath),
      input.allowRemoteSamples ? 1 : 0,
      updatedAt,
      input.uploadRequestId,
    );
    return this.require(input.uploadRequestId, input);
  }

  markIngested(input: {
    uploadRequestId: string;
    userId: string;
    workspaceId: string;
    datasetRef: string;
  }): DatasetUploadRequestRecord {
    const current = this.requireInternal(input.uploadRequestId, input);
    if (current.status === 'ingested' && current.datasetRef === input.datasetRef) return publicRecord(current);
    if (current.status !== 'attachment_ready') throw new Error(`Upload request cannot be completed from ${current.status}.`);
    this.database.prepare(`
      UPDATE theta_dataset_upload_requests
      SET status = 'ingested', dataset_ref = ?, staged_path = NULL, updated_at = ?
      WHERE upload_request_id = ? AND status = 'attachment_ready'
    `).run(input.datasetRef, new Date().toISOString(), input.uploadRequestId);
    return this.require(input.uploadRequestId, input);
  }

  close(): void {
    this.database.close();
  }

  private currentInternal(runId: string, owner: { userId: string; workspaceId: string }): DatasetUploadRequestInternal | null {
    const row = this.database.prepare(`
      SELECT * FROM theta_dataset_upload_requests
      WHERE run_id = ? AND user_id = ? AND workspace_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(runId, owner.userId, owner.workspaceId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  private requireInternal(uploadRequestId: string, owner: { userId: string; workspaceId: string }): DatasetUploadRequestInternal {
    const row = this.database.prepare(`
      SELECT * FROM theta_dataset_upload_requests
      WHERE upload_request_id = ? AND user_id = ? AND workspace_id = ?
    `).get(uploadRequestId, owner.userId, owner.workspaceId) as Row | undefined;
    if (!row) throw new Error('Upload request is unknown or outside the current workspace.');
    return rowToRecord(row);
  }
}

export class DatasetAttachmentBroker {
  private readonly managedRoot: string;
  private readonly ingestion: DatasetIngestionService;

  constructor(private readonly options: { runtimeDb: string; managedRoot: string }) {
    this.managedRoot = path.resolve(options.managedRoot);
    this.ingestion = new DatasetIngestionService(options);
  }

  request(input: {
    runId: string;
    userId: string;
    workspaceId: string;
    reason: string;
    acceptedFormats: string[];
  }): DatasetUploadRequestRecord {
    const store = new SQLiteDatasetAttachmentStore(this.options.runtimeDb);
    try {
      return store.request(input);
    } finally {
      store.close();
    }
  }

  current(runId: string, owner: { userId: string; workspaceId: string }): DatasetUploadRequestRecord | null {
    const store = new SQLiteDatasetAttachmentStore(this.options.runtimeDb);
    try {
      return store.current(runId, owner);
    } finally {
      store.close();
    }
  }

  async stageLocalFile(input: {
    uploadRequestId: string;
    runId: string;
    filePath: string;
    userId: string;
    workspaceId: string;
    allowRemoteSamples: boolean;
  }): Promise<DatasetUploadRequestRecord> {
    const inspected = await this.ingestion.inspectLocalFile(input.filePath);
    const store = new SQLiteDatasetAttachmentStore(this.options.runtimeDb);
    const attachmentRef = `attachment_${randomUUID()}`;
    const stagingRoot = path.join(this.managedRoot, '.attachments');
    const stagedPath = path.join(stagingRoot, `${attachmentRef}.upload`);
    try {
      const request = store.require(input.uploadRequestId, input);
      if (request.runId !== input.runId) throw new Error('Upload request belongs to another Run.');
      if (request.acceptedFormats.length && !request.acceptedFormats.includes(inspected.suffix.slice(1))) {
        throw new Error(`The Agent requested ${request.acceptedFormats.join(', ')}; ${inspected.suffix} is not accepted.`);
      }
      await mkdir(stagingRoot, { recursive: true });
      await copyFile(inspected.sourcePath, stagedPath);
      const stagedStat = await stat(stagedPath);
      const sha256 = await hashFile(stagedPath);
      return store.attach({
        ...input,
        attachmentRef,
        displayName: inspected.displayName,
        suffix: inspected.suffix,
        sizeBytes: stagedStat.size,
        sha256,
        stagedPath,
      });
    } catch (error) {
      await unlink(stagedPath).catch(() => undefined);
      throw error;
    } finally {
      store.close();
    }
  }

  async ingestAttachment(input: {
    runId: string;
    attachmentRef: string;
    userId: string;
    workspaceId: string;
  }): Promise<{ request: DatasetUploadRequestRecord; dataset: PublicDatasetRecord }> {
    const store = new SQLiteDatasetAttachmentStore(this.options.runtimeDb);
    try {
      const attachment = store.requireReadyAttachment(input.attachmentRef, input);
      const dataset = await this.ingestion.ingestPreparedFile({
        temporaryPath: attachment.stagedPath as string,
        displayName: attachment.displayName as string,
        suffix: attachment.suffix as string,
        sha256: attachment.sha256 as string,
        sizeBytes: attachment.sizeBytes as number,
        userId: input.userId,
        workspaceId: input.workspaceId,
      });
      const request = store.markIngested({
        uploadRequestId: attachment.uploadRequestId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        datasetRef: dataset.datasetRef,
      });
      return { request, dataset };
    } finally {
      store.close();
    }
  }
}

const publicRecord = (record: DatasetUploadRequestInternal): DatasetUploadRequestRecord => ({
  uploadRequestId: record.uploadRequestId,
  runId: record.runId,
  userId: record.userId,
  workspaceId: record.workspaceId,
  reason: record.reason,
  acceptedFormats: [...record.acceptedFormats],
  status: record.status,
  ...(record.attachmentRef === undefined ? {} : { attachmentRef: record.attachmentRef }),
  ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
  ...(record.suffix === undefined ? {} : { suffix: record.suffix }),
  ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
  ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }),
  ...(record.datasetRef === undefined ? {} : { datasetRef: record.datasetRef }),
  ...(record.allowRemoteSamples === undefined ? {} : { allowRemoteSamples: record.allowRemoteSamples }),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

interface Row {
  upload_request_id: string;
  run_id: string;
  user_id: string;
  workspace_id: string;
  reason: string;
  accepted_formats_json: string;
  status: DatasetUploadRequestStatus;
  attachment_ref: string | null;
  display_name: string | null;
  suffix: string | null;
  size_bytes: number | null;
  sha256: string | null;
  staged_path: string | null;
  dataset_ref: string | null;
  allow_remote_samples: number | null;
  created_at: string;
  updated_at: string;
}

const rowToRecord = (row: Row): DatasetUploadRequestInternal => ({
  uploadRequestId: row.upload_request_id,
  runId: row.run_id,
  userId: row.user_id,
  workspaceId: row.workspace_id,
  reason: row.reason,
  acceptedFormats: JSON.parse(row.accepted_formats_json) as string[],
  status: row.status,
  ...(row.attachment_ref === null ? {} : { attachmentRef: row.attachment_ref }),
  ...(row.display_name === null ? {} : { displayName: row.display_name }),
  ...(row.suffix === null ? {} : { suffix: row.suffix }),
  ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
  ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
  ...(row.staged_path === null ? {} : { stagedPath: row.staged_path }),
  ...(row.dataset_ref === null ? {} : { datasetRef: row.dataset_ref }),
  ...(row.allow_remote_samples === null ? {} : { allowRemoteSamples: row.allow_remote_samples === 1 }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const hashFile = async (filename: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
