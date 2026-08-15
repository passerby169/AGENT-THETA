import path from 'node:path';
import type { JsonSchema } from '@hypha/core';
import type { ToolHandler, ToolSpec } from '@hypha/tools';
import { DatasetAttachmentBroker } from '../datasets/dataset-attachment-broker.js';
import { supportedDatasetSuffixes } from './dataset-path-policy.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const supportedFormats = [...supportedDatasetSuffixes].map((suffix) => suffix.slice(1));

const requestInputSchema: JsonSchema = {
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    acceptedFormats: {
      type: 'array',
      items: { type: 'string', enum: supportedFormats },
      uniqueItems: true,
      minItems: 1,
      maxItems: supportedFormats.length,
    },
  },
  additionalProperties: false,
};

const uploadRequestOutputSchema: JsonSchema = {
  type: 'object',
  required: ['status', 'uploadRequestId', 'reason', 'acceptedFormats'],
  properties: {
    status: { type: 'string', enum: ['waiting_for_file', 'attachment_ready', 'ingested'] },
    uploadRequestId: { type: 'string' },
    reason: { type: 'string' },
    acceptedFormats: { type: 'array', items: { type: 'string' } },
    attachmentRef: { type: 'string' },
    displayName: { type: 'string' },
    suffix: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    datasetRef: { type: 'string' },
  },
  additionalProperties: false,
};

export const thetaDatasetRequestUploadToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetRequestUpload,
  version: '1.0.0',
  displayName: '请求用户上传数据',
  description: 'Ask the current user for one dataset when this Run has no ingested dataset. Returns a Run-scoped upload request and never reads a local path.',
  tags: ['theta', 'dataset', 'intake', 'hypha'],
  inputSchema: requestInputSchema,
  outputSchema: uploadRequestOutputSchema,
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetWrite],
  timeoutPolicy: { timeoutMs: 5_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaDatasetRequestUploadHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = raw as { reason: string; acceptedFormats?: string[] };
  const broker = brokerFrom(context.metadata);
  const request = broker.request({
    runId: context.runId,
    userId: context.userId ?? context.principal?.userId ?? 'local_user',
    workspaceId: context.workspaceId ?? context.principal?.workspaceId ?? 'local_workspace',
    reason: input.reason,
    acceptedFormats: normalizeFormats(input.acceptedFormats),
  });
  return safeRequestOutput(request);
};

const ingestInputSchema: JsonSchema = {
  type: 'object',
  required: ['attachmentRef'],
  properties: {
    attachmentRef: { type: 'string', pattern: '^attachment_[0-9a-f-]{36}$' },
  },
  additionalProperties: false,
};

export const thetaDatasetIngestAttachmentToolSpec: ToolSpec = {
  id: THETA_TOOL_IDS.datasetIngestAttachment,
  version: '1.0.0',
  displayName: '摄取已上传的数据附件',
  description: 'Validate and ingest one ready Run-scoped attachment into THETA managed storage. The model receives only attachmentRef, never a filesystem path.',
  tags: ['theta', 'dataset', 'intake', 'hypha'],
  inputSchema: ingestInputSchema,
  outputSchema: {
    type: 'object',
    required: ['status', 'uploadRequestId', 'attachmentRef', 'datasetRef', 'displayName', 'suffix', 'sizeBytes', 'datasetHash'],
    properties: {
      status: { type: 'string', enum: ['ingested'] },
      uploadRequestId: { type: 'string' },
      attachmentRef: { type: 'string' },
      datasetRef: { type: 'string' },
      displayName: { type: 'string' },
      suffix: { type: 'string' },
      sizeBytes: { type: 'integer', minimum: 0 },
      datasetHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    },
    additionalProperties: false,
  },
  sideEffectLevel: 'write',
  permissionScope: [THETA_PERMISSION_SCOPES.datasetWrite],
  timeoutPolicy: { timeoutMs: 120_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true },
  source: 'local',
};

export const thetaDatasetIngestAttachmentHandler: ToolHandler<unknown, Record<string, unknown>> = async (raw, context) => {
  const input = raw as { attachmentRef: string };
  const owner = {
    runId: context.runId,
    userId: context.userId ?? context.principal?.userId ?? 'local_user',
    workspaceId: context.workspaceId ?? context.principal?.workspaceId ?? 'local_workspace',
  };
  const result = await brokerFrom(context.metadata).ingestAttachment({ ...owner, attachmentRef: input.attachmentRef });
  return {
    status: 'ingested',
    uploadRequestId: result.request.uploadRequestId,
    attachmentRef: input.attachmentRef,
    datasetRef: result.dataset.datasetRef,
    displayName: result.dataset.displayName,
    suffix: result.dataset.suffix,
    sizeBytes: result.dataset.sizeBytes,
    datasetHash: `sha256:${result.dataset.sha256}`,
  };
};

const brokerFrom = (metadata: Record<string, unknown> | undefined): DatasetAttachmentBroker => {
  if (typeof metadata?.thetaRuntimeDb !== 'string' || !metadata.thetaRuntimeDb.trim()) {
    throw new Error('Governed Intake Tool requires an explicit thetaRuntimeDb binding.');
  }
  const runtimeDb = path.resolve(metadata.thetaRuntimeDb);
  const managedRoot = typeof metadata?.thetaUploadRoot === 'string'
    ? path.resolve(metadata.thetaUploadRoot)
    : path.resolve(process.env.THETA_DATASET_UPLOAD_DIR ?? path.join(path.dirname(runtimeDb), 'uploads'));
  return new DatasetAttachmentBroker({ runtimeDb, managedRoot });
};

const normalizeFormats = (formats: string[] | undefined): string[] => {
  if (!formats?.length) return [...supportedFormats];
  const normalized = [...new Set(formats.map((format) => format.trim().toLowerCase().replace(/^\./u, '')))].filter((format) => supportedFormats.includes(format));
  if (!normalized.length) throw new Error('Upload request does not contain a supported dataset format.');
  return normalized;
};

const safeRequestOutput = (request: ReturnType<DatasetAttachmentBroker['request']>): Record<string, unknown> => ({
  status: request.status,
  uploadRequestId: request.uploadRequestId,
  reason: request.reason,
  acceptedFormats: request.acceptedFormats,
  ...(request.attachmentRef === undefined ? {} : { attachmentRef: request.attachmentRef }),
  ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
  ...(request.suffix === undefined ? {} : { suffix: request.suffix }),
  ...(request.sizeBytes === undefined ? {} : { sizeBytes: request.sizeBytes }),
  ...(request.datasetRef === undefined ? {} : { datasetRef: request.datasetRef }),
});
