import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import {
  DatasetIngestionError as DatasetUploadError,
  DatasetIngestionService,
  type PublicDatasetRecord,
} from '../datasets/dataset-ingestion-service.js';
import { configuredMaxDatasetBytes, supportedDatasetSuffixes } from '../tools/dataset-path-policy.js';

export { DatasetIngestionError as DatasetUploadError } from '../datasets/dataset-ingestion-service.js';
export type { PublicDatasetRecord } from '../datasets/dataset-ingestion-service.js';

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
    const service = new DatasetIngestionService({ runtimeDb: input.runtimeDb, managedRoot: uploadRoot });
    const record = await service.ingestPreparedFile({
      temporaryPath: uploaded.temporaryPath,
      displayName: uploaded.displayName,
      suffix: uploaded.suffix,
      sha256: uploaded.sha256,
      sizeBytes: uploaded.sizeBytes,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    temporaryPath = undefined;
    return record;
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
  const managedRoot = path.resolve(process.env.THETA_DATASET_UPLOAD_DIR ?? path.join(path.dirname(runtimeDb), 'uploads'));
  return new DatasetIngestionService({ runtimeDb, managedRoot }).list(owner);
};

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
