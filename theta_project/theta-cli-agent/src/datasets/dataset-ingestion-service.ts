import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SQLiteDatasetRegistry, type DatasetRecord } from '../storage/dataset-registry.js';
import { configuredMaxDatasetBytes, supportedDatasetSuffixes } from '../tools/dataset-path-policy.js';

export class DatasetIngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'DatasetIngestionError';
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

export interface DatasetIngestionServiceOptions {
  runtimeDb: string;
  managedRoot: string;
}

export class DatasetIngestionService {
  private readonly managedRoot: string;

  constructor(private readonly options: DatasetIngestionServiceOptions) {
    this.managedRoot = path.resolve(options.managedRoot);
  }

  async inspectLocalFile(filePath: string): Promise<{
    sourcePath: string;
    displayName: string;
    suffix: string;
    sizeBytes: number;
  }> {
    const requested = path.resolve(stripOuterQuotes(filePath.trim()));
    let sourcePath: string;
    try {
      sourcePath = await realpath(requested);
    } catch {
      throw new DatasetIngestionError('THETA_DATASET_FILE_NOT_FOUND', `Dataset file does not exist: ${requested}`, 404);
    }
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new DatasetIngestionError('THETA_DATASET_NOT_FILE', `Dataset path is not a regular file: ${sourcePath}`);
    const displayName = path.basename(sourcePath);
    const suffix = path.extname(displayName).toLowerCase();
    assertSupportedSuffix(suffix);
    const maximumBytes = configuredMaxDatasetBytes();
    if (info.size > maximumBytes) {
      throw new DatasetIngestionError('THETA_DATASET_TOO_LARGE', `Dataset exceeds THETA_MAX_DATASET_BYTES (${maximumBytes}).`, 413);
    }
    return { sourcePath, displayName, suffix, sizeBytes: info.size };
  }

  async ingestLocalFile(input: {
    filePath: string;
    userId: string;
    workspaceId: string;
  }): Promise<PublicDatasetRecord> {
    const inspected = await this.inspectLocalFile(input.filePath);
    await mkdir(this.managedRoot, { recursive: true });
    const temporaryPath = path.join(this.managedRoot, `.upload-${randomUUID()}.tmp`);
    try {
      await copyFile(inspected.sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      return await this.ingestPreparedFile({
        temporaryPath,
        displayName: inspected.displayName,
        suffix: inspected.suffix,
        sha256: await hashFile(temporaryPath),
        sizeBytes: inspected.sizeBytes,
        userId: input.userId,
        workspaceId: input.workspaceId,
      });
    } catch (error) {
      if (await exists(temporaryPath)) await unlink(temporaryPath);
      if (error instanceof DatasetIngestionError) throw error;
      throw new DatasetIngestionError('THETA_DATASET_INGESTION_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  async ingestPreparedFile(input: {
    temporaryPath: string;
    displayName: string;
    suffix: string;
    sha256: string;
    sizeBytes: number;
    userId: string;
    workspaceId: string;
  }): Promise<PublicDatasetRecord> {
    const suffix = input.suffix.toLowerCase();
    assertSupportedSuffix(suffix);
    await mkdir(this.managedRoot, { recursive: true });
    const temporaryPath = path.resolve(input.temporaryPath);
    assertInsideManagedRoot(temporaryPath, this.managedRoot);
    const preparedStat = await stat(temporaryPath);
    if (!preparedStat.isFile()) throw new DatasetIngestionError('THETA_DATASET_NOT_FILE', 'Prepared upload is not a regular file.');
    const maximumBytes = configuredMaxDatasetBytes();
    if (preparedStat.size > maximumBytes) throw new DatasetIngestionError('THETA_DATASET_TOO_LARGE', `Dataset exceeds THETA_MAX_DATASET_BYTES (${maximumBytes}).`, 413);
    if (preparedStat.size !== input.sizeBytes) throw new DatasetIngestionError('THETA_DATASET_SIZE_MISMATCH', 'Prepared upload size changed before it could be registered.');
    const actualSha256 = await hashFile(temporaryPath);
    if (actualSha256 !== input.sha256.toLowerCase()) throw new DatasetIngestionError('THETA_DATASET_HASH_MISMATCH', 'Prepared upload hash changed before it could be registered.');
    const managedPath = path.join(this.managedRoot, `${actualSha256}${suffix}`);
    if (await exists(managedPath)) await unlink(temporaryPath);
    else {
      try {
        await rename(temporaryPath, managedPath);
      } catch (error) {
        if (await exists(managedPath)) await unlink(temporaryPath);
        else throw error;
      }
    }
    const registry = new SQLiteDatasetRegistry(this.options.runtimeDb);
    try {
      const record = await registry.registerManagedFile(
        managedPath,
        this.managedRoot,
        { userId: input.userId, workspaceId: input.workspaceId },
        input.displayName,
      );
      if (path.resolve(record.managedPath) !== path.resolve(managedPath) && await exists(managedPath)) {
        await unlink(managedPath);
      }
      return publicDatasetRecord(record);
    } finally {
      registry.close();
    }
  }

  list(owner: { userId: string; workspaceId: string }): PublicDatasetRecord[] {
    const registry = new SQLiteDatasetRegistry(this.options.runtimeDb);
    try {
      return registry.list(owner).map(publicDatasetRecord);
    } finally {
      registry.close();
    }
  }
}

export const publicDatasetRecord = (record: DatasetRecord): PublicDatasetRecord => ({
  datasetRef: record.datasetRef,
  displayName: record.displayName,
  sha256: record.sha256,
  sizeBytes: record.sizeBytes,
  suffix: record.suffix,
  createdAt: record.createdAt,
});

const assertSupportedSuffix = (suffix: string): void => {
  if (!supportedDatasetSuffixes.has(suffix)) {
    throw new DatasetIngestionError(
      'THETA_DATASET_SUFFIX_UNSUPPORTED',
      `Unsupported dataset suffix "${suffix || '(none)'}". Supported: ${[...supportedDatasetSuffixes].join(', ')}.`,
      415,
    );
  }
};

const assertInsideManagedRoot = (candidate: string, root: string): void => {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DatasetIngestionError('THETA_DATASET_TEMP_PATH_INVALID', 'Prepared upload path is outside the managed upload directory.');
  }
};

const stripOuterQuotes = (value: string): string => {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
};

const hashFile = async (filename: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};

const exists = async (filename: string): Promise<boolean> => {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
};
