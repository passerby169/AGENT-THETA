import type { ApiErrorDescriptor, ApiFailure, ApiMeta } from './contracts.generated';

export class ThetaApiError extends Error {
  readonly status: number;
  readonly descriptor: ApiErrorDescriptor;
  readonly meta?: ApiMeta;

  constructor(status: number, descriptor: ApiErrorDescriptor, meta?: ApiMeta) {
    super(descriptor.message);
    this.name = 'ThetaApiError';
    this.status = status;
    this.descriptor = descriptor;
    this.meta = meta;
  }

  get isStaleRevision(): boolean {
    return this.descriptor.code === 'STALE_RUN_REVISION';
  }
}

export const isApiFailure = (value: unknown): value is ApiFailure => {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<ApiFailure>;
  return envelope.ok === false && Boolean(envelope.error?.code) && Boolean(envelope.error?.message);
};

export const transportFailure = (status: number, message: string): ThetaApiError =>
  new ThetaApiError(status, {
    code: 'TRANSPORT_FAILURE',
    category: 'unavailable',
    message,
    retryable: true,
    recovery: {
      action: 'retry',
      label: '重试',
      description: '连接恢复后重新提交请求。',
    },
  });
