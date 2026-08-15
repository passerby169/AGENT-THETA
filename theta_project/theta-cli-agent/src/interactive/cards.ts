import type { PublicDatasetRecord } from '../datasets/dataset-ingestion-service.js';
import type { DatasetUploadRequestRecord } from '../datasets/dataset-attachment-broker.js';

export const welcomeCard = (): string => [
  '╭────────────────────────────────────────────╮',
  '│            欢迎使用 THETA Agent            │',
  '│                                            │',
  '│  我会陪你完成数据上传、研究意图梳理、       │',
  '│  方案确认、训练启动和结果读取。             │',
  '╰────────────────────────────────────────────╯',
  '',
  '请选择',
  '  [1] 与 THETA Agent 开始对话',
  '  [2] 继续之前的任务',
  '  [3] 查看本地运行环境',
  '  [4] 退出',
].join('\n');

export const datasetPathCard = (request?: Pick<DatasetUploadRequestRecord, 'reason' | 'acceptedFormats'>): string => [
  '── Agent 请求你提供数据 ──',
  '',
  ...(request ? [`原因：${request.reason}`, `本次接受：${request.acceptedFormats.map((item) => item.toUpperCase()).join('、')}`, ''] : []),
  '你可以把文件直接拖入终端，或粘贴完整路径。',
  '本地路径只由 CLI Host 使用，不会发送给 MiniMax。',
  '输入 /cancel 可以返回欢迎页。',
].join('\n');

export const datasetUploadCard = (input: {
  displayName: string;
  suffix: string;
  sizeBytes: number;
}): string => [
  '── 数据上传确认 ──',
  '',
  `文件名称：${input.displayName}`,
  `文件类型：${input.suffix.slice(1).toUpperCase()}`,
  `文件大小：${formatBytes(input.sizeBytes)}`,
  '下一步：先生成仅限当前任务使用的 attachmentRef',
  '原始文件：不会修改',
  '本地路径：不会进入 MiniMax 上下文',
  '数据登记：尚未执行，将由 MiniMax 调用工具完成',
  '网络发送：尚未授权',
  '',
  '请选择',
  '  [1] 将这个附件交给 Agent',
  '  [2] 重新选择文件',
  '  [3] 取消',
].join('\n');

export const stagedAttachmentCard = (request: DatasetUploadRequestRecord): string => [
  '✓ 文件已经安全暂存',
  `  文件：${request.displayName ?? '未命名附件'}`,
  `  附件引用：${request.attachmentRef ?? '未生成'}`,
  `  大小：${formatBytes(request.sizeBytes ?? 0)}`,
  '  MiniMax 接下来只能使用附件引用调用摄取工具，无法读取本地路径。',
  '  当前尚未生成 datasetRef。',
].join('\n');

export const managedDatasetCard = (dataset: PublicDatasetRecord): string => [
  '✓ 数据已由 THETA 安全托管',
  `  文件：${dataset.displayName}`,
  `  数据标识：${dataset.datasetRef}`,
  `  大小：${formatBytes(dataset.sizeBytes)}`,
  '  相同文件再次上传时会自动复用，不会重复保存。',
].join('\n');

export const sampleConsentCard = (): string => [
  '── MiniMax 数据样本授权 ──',
  '',
  '为了理解正文语义，THETA 可以随机抽取最多10条记录，',
  '先在本地脱敏，再把脱敏样本发送给 MiniMax。',
  '完整数据集不会发送。',
  '',
  '请选择',
  '  [1] 允许发送最多10条脱敏样本',
  '  [2] 不允许，只使用列名和本地统计信息',
].join('\n');

export const runCreatedCard = (runId: string): string => [
  '✓ 研究任务已经创建',
  `  任务标识：${runId}`,
  '  THETA Agent 接下来会先介绍如何协作，你可以像普通对话一样开始。',
].join('\n');

export const trainingAuthorizationCard = (summary: string): string => [
  '── 训练启动授权 ──',
  '',
  summary,
  '',
  '请选择',
  '  [1] 批准并启动训练',
  '  [2] 返回计划阶段修改',
  '  [3] 暂停并退出，稍后继续',
].join('\n');

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
