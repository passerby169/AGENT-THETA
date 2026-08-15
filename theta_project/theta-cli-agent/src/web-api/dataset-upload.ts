import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { SQLiteDatasetRegistry, type DatasetRecord } from '../storage/dataset-registry.js';
import { configuredMaxDatasetBytes, supportedDatasetSuffixes } from '../tools/dataset-path-policy.js';

export class DatasetUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DatasetUploadError';
  }
}

export interface PublicDatasetRecord {
  datasetRef: string;
  displayName: string;
  sha256: string;
  sizeBytes: number;
  suffix: string;
  createdAt: string;
}

export const uploadDataset = async (input: {
  request: IncomingMessage;
  runtimeDb: string;
  uploadDir: string;
  userId: string;
  workspaceId: string;
}): Promise<PublicDatasetRecord> => {
  const contentType = input.request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new DatasetUploadError('THETA_DATASET_MULTIPART_REQUIRED', 'Content-Type must be multipart/form-data.', 415);
  }
  const uploadRoot = path.resolve(input.uploadDir);
  await mkdir(uploadRoot, { recursive: true });
  const maximumBytes = configuredMaxDatasetBytes();
  let temporaryPath: string | undefined;
  let uploadProblem: DatasetUploadError | undefined;
  let fileTask: Promise<StoredUpload> | undefined;
  let fileCount = 0;
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: input.request.headers,
      preservePath: false,
      limits: { fileSize: maximumBytes, files: 1, fields: 0, parts: 2, headerPairs: 100 },
    });
  } catch (error) {
    throw new DatasetUploadError(
      'THETA_DATASET_MULTIPART_INVALID',
      error instanceof Error ? error.message : 'Malformed multipart request.',
      400,
    );
  }

  parser.on('file', (fieldName, stream, info) => {
    fileCount += 1;
    const displayName = path.basename(info.filename || 'dataset');
    const suffix = path.extname(displayName).toLowerCase();
    if (fieldName !== 'file') {
      uploadProblem = new DatasetUploadError('THETA_DATASET_FILE_FIELD_REQUIRED', 'The multipart file field must be named "file".', 400);
      stream.resume();
      return;
    }
    if (!supportedDatasetSuffixes.has(suffix)) {
      uploadProblem = new DatasetUploadError(
        'THETA_DATASET_SUFFIX_UNSUPPORTED',
        `Unsupported dataset suffix "${suffix || '(none)'}". Supported: ${[...supportedDatasetSuffixes].join(', ')}.`,
        415,
      );
      stream.resume();
      return;
    }
    temporaryPath = path.join(uploadRoot, `.upload-${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    stream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    stream.once('limit', () => {
      uploadProblem = new DatasetUploadError(
        'THETA_DATASET_TOO_LARGE',
        `Dataset exceeds THETA_MAX_DATASET_BYTES (${maximumBytes}).`,
        413,
      );
    });
    fileTask = pipeline(stream, createWriteStream(temporaryPath, { flags: 'wx' })).then(() => ({
      temporaryPath: temporaryPath as string,
      displayName,
      suffix,
      sha256: hash.digest('hex'),
      sizeBytes,
      truncated: stream.truncated === true,
    }));
  });
  parser.once('filesLimit', () => {
    uploadProblem = new DatasetUploadError('THETA_DATASET_FILE_COUNT_INVALID', 'Exactly one dataset file is allowed.', 400);
  });
  parser.once('fieldsLimit', () => {
    uploadProblem = new DatasetUploadError('THETA_DATASET_FIELD_COUNT_INVALID', 'Dataset upload does not accept additional form fields.', 400);
  });
  parser.once('partsLimit', () => {
    uploadProblem = new DatasetUploadError('THETA_DATASET_PART_COUNT_INVALID', 'The upload may contain only one file part.', 400);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      parser.once('close', resolve);
      parser.once('error', reject);
      input.request.once('aborted', () => reject(new DatasetUploadError('THETA_DATASET_UPLOAD_ABORTED', 'Dataset upload was aborted.', 400)));
      input.request.pipe(parser);
    });
    if (uploadProblem) throw uploadProblem;
    if (fileCount !== 1 || !fileTask) {
      throw new DatasetUploadError('THETA_DATASET_FILE_REQUIRED', 'The multipart request must contain one file field named "file".', 400);
    }
    const uploaded = await fileTask;
    if (uploaded.truncated) {
      throw new DatasetUploadError('THETA_DATASET_TOO_LARGE', `Dataset exceeds THETA_MAX_DATASET_BYTES (${maximumBytes}).`, 413);
    }
    const managedPath = path.join(uploadRoot, `${uploaded.sha256}${uploaded.suffix}`);
    if (await exists(managedPath)) await unlink(uploaded.temporaryPath);
    else {
      try {
        await rename(uploaded.temporaryPath, managedPath);
      } catch (error) {
        if (await exists(managedPath)) await unlink(uploaded.temporaryPath);
        else throw error;
      }
    }
    temporaryPath = undefined;
    const registry = new SQLiteDatasetRegistry(input.runtimeDb);
    try {
      const record = await registry.registerManagedFile(
        managedPath,
        uploadRoot,
        { userId: input.userId, workspaceId: input.workspaceId },
        uploaded.displayName,
      );
      return publicDatasetRecord(record);
    } finally {
      registry.close();
    }
  } catch (error) {
    if (temporaryPath && await exists(temporaryPath)) await unlink(temporaryPath);
    if (error instanceof DatasetUploadError) throw error;
    throw new DatasetUploadError(
      'THETA_DATASET_UPLOAD_FAILED',
      error instanceof Error ? error.message : String(error),
      400,
    );
  }
};

export const listDatasets = (
  runtimeDb: string,
  owner: { userId: string; workspaceId: string },
): PublicDatasetRecord[] => {
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try {
    return registry.list(owner).map(publicDatasetRecord);
  } finally {
    registry.close();
  }
};

export const publicDatasetRecord = (record: DatasetRecord): PublicDatasetRecord => ({
  datasetRef: record.datasetRef,
  displayName: record.displayName,
  sha256: record.sha256,
  sizeBytes: record.sizeBytes,
  suffix: record.suffix,
  createdAt: record.createdAt,
});

interface StoredUpload {
  temporaryPath: string;
  displayName: string;
  suffix: string;
  sha256: string;
  sizeBytes: number;
  truncated: boolean;
}

const exists = async (filename: string): Promise<boolean> => {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
};
