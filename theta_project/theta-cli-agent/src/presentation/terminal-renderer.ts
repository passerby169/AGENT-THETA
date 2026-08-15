import type { ConversationalCheckpoint } from '../checkpoints/contracts.js';
import { presentConfirmationCard } from '../checkpoints/confirmation-card-presenter.js';

export const renderValue = (value: unknown): string => JSON.stringify(withoutPercentages(value), null, 2);

export const renderUserError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `操作未完成\n${message}\n请运行 theta status --run-id <id> 查看当前 V6 状态。`;
};

export const renderActivityLine = (activity: {
  activityId?: string;
  kind?: string;
  phase?: string;
  toolId?: string;
  displayName?: string;
  status: string;
  userMessage: string;
  safeInputSummary?: string;
  safeOutputSummary?: string;
}): string => {
  const marker = activity.status === 'completed' ? '✓' : activity.status === 'failed' ? '✗' : '→';
  const tool = activity.toolId
    ? `${activity.toolId}${activity.displayName ? ` · ${activity.displayName}` : ''}`
    : activity.kind === 'thinking'
      ? '尚未调用（MiniMax 正在选择下一步）'
      : '无（FSM/对话步骤）';
  const details = [
    `  阶段：${phaseDisplayName(activity.phase)}`,
    `  工具：${tool}`,
    ...(activity.safeInputSummary ? [`  输入：${activity.safeInputSummary}`] : []),
    ...(activity.safeOutputSummary
      ? [`  ${activity.status === 'failed' ? '原因' : '结果'}：${activity.safeOutputSummary}`]
      : []),
  ];
  return `${marker} ${activity.userMessage}\n${details.join('\n')}`;
};

export const renderActivitySnapshot = (snapshot: {
  phase?: string;
  current?: Parameters<typeof renderActivityLine>[0];
  recent: Array<Parameters<typeof renderActivityLine>[0]>;
}): string => {
  const latestByActivity = new Map<string, Parameters<typeof renderActivityLine>[0] & { activityId?: string }>();
  for (const item of snapshot.recent) latestByActivity.set(item.activityId ?? `${item.kind}:${item.toolId}:${item.userMessage}`, item);
  const activities = [...latestByActivity.values()].slice(-12);
  return [
    `当前阶段：${phaseDisplayName(snapshot.phase)}`,
    '',
    ...(activities.length ? activities.flatMap((item) => [renderActivityLine(item), '']) : ['尚无工具调用记录。']),
  ].join('\n').trim();
};

export const renderPhaseStart = (phase?: string): string =>
  `\n── 当前阶段：${phaseDisplayName(phase)} ──\nAgent 将实时展示每一步动作和实际调用的工具。`;

export const renderPhaseEnd = (startedPhase?: string, currentPhase?: string): string => startedPhase === currentPhase
  ? `── 当前阶段：${phaseDisplayName(currentPhase)}（等待继续）──`
  : `── 阶段流转：${phaseDisplayName(startedPhase)} → ${phaseDisplayName(currentPhase)} ──`;

export const renderWorkflowOutcome = (value: unknown): string => {
  const result = object(value);
  const snapshot = object(result.snapshot);
  const state = text(snapshot.currentState) ?? text(result.currentState);
  const runId = text(snapshot.runId) ?? text(result.runId);
  const status = text(snapshot.status) ?? text(result.status);
  const disposition = text(result.disposition);
  const assistantMessage = text(result.assistantMessage);
  const summary = text(result.summary);
  const pendingReason = text(snapshot.pendingReason) ?? text(result.pendingReason);
  const recoveryReason = text(snapshot.recoveryReason) ?? text(result.recoveryReason);
  const error = text(result.error);
  const lines = [
    '阶段结果',
    ...(runId ? [`  任务：${runId}`] : []),
    ...(state ? [`  当前阶段：${phaseDisplayName(state)}`] : []),
    ...(status ? [`  运行状态：${status}`] : []),
    ...(disposition ? [`  本轮结果：${disposition}`] : []),
    ...(summary ? ['', summary] : []),
    ...(assistantMessage ? ['', 'Agent 回复', assistantMessage] : []),
    ...(pendingReason && pendingReason !== assistantMessage ? ['', `等待你的决定：${pendingReason}`] : []),
    ...(recoveryReason && recoveryReason !== pendingReason ? ['', `停止原因：${recoveryReason}`] : []),
    ...(error ? ['', `未完成原因：${error}`] : []),
    ...(runId && state ? ['', '下一步', `  → ${nextCommand(state, runId, status)}`] : []),
  ];
  return lines.join('\n').trim();
};

export const renderConfirmationCard = (
  checkpoint: ConversationalCheckpoint,
  options: { includeCommands?: boolean } = {},
): string => {
  const card = presentConfirmationCard(checkpoint);
  const details = [
    card.summary,
    ...card.sections.flatMap((section) => [
      '',
      section.title,
      ...(Array.isArray(section.content)
        ? section.content.map((item) => `  - ${item}`)
        : [`  ${section.content}`]),
    ]),
  ];
  const decision = ['dataset', 'research', 'plan'].includes(checkpoint.kind)
    ? [
        '',
        '请选择',
        '  [1] 是，进入下一阶段',
        '  [2] 否，说明原因',
        ...(options.includeCommands === false
          ? []
          : [
              '',
              '非交互式命令',
              `  确认：theta workflow decide --run-id "${checkpoint.runId}" --approve`,
              `  修改：theta workflow decide --run-id "${checkpoint.runId}" --revise --text "修改原因"`,
            ]),
      ]
    : [];
  return [
    `── ${card.title} ──`,
    ...details,
    ...(card.warnings.length ? ['', '需要留意', ...card.warnings.map((item) => `  - ${item}`)] : []),
    ...decision,
  ].join('\n').trim();
};

const phaseDisplayName = (phase?: string): string => ({
  Intake: '接收并登记数据',
  DatasetDiscovery: '探索并理解数据',
  DatasetCheckpoint: '确认数据理解',
  ResearchDialogue: '明确研究意图',
  ResearchCheckpoint: '确认研究意图',
  PlanDesign: '设计训练计划',
  PlanConfirmation: '确认训练计划',
  CreatePlan: '生成可执行计划',
  DryRun: '训练前检查',
  TrainingConfirmation: '确认启动训练',
  VerifyDataset: '训练前数据复核',
  StartTraining: '启动训练',
  MonitorTraining: '监控训练',
  EvaluateResults: '读取训练结果',
  Completed: '流程完成',
  HumanRecovery: '等待人工修复',
  Quarantined: '隔离处理',
  Cancelled: '训练已取消',
}[phase ?? ''] ?? phase ?? '准备中');

const nextCommand = (phase: string, runId: string, status?: string): string => {
  if (status === 'waiting_human' && phase === 'DatasetDiscovery') {
    return `theta workflow message --run-id "${runId}" --text "你的自然语言回答"`;
  }
  if (status === 'waiting_human' && phase === 'ResearchDialogue') {
    return `theta workflow message --run-id "${runId}" --text "你的自然语言回答"`;
  }
  return ({
  DatasetDiscovery: `theta workflow discover --run-id "${runId}"`,
  DatasetCheckpoint: `theta workflow checkpoint --run-id "${runId}"，然后选择“是”或“否，说明原因”`,
  ResearchDialogue: `theta workflow research --run-id "${runId}"`,
  ResearchCheckpoint: `theta workflow checkpoint --run-id "${runId}"，然后选择“是”或“否，说明原因”`,
  PlanDesign: `theta workflow plan --run-id "${runId}"`,
  PlanConfirmation: `theta workflow checkpoint --run-id "${runId}"，然后选择“是”或“否，说明原因”`,
  CreatePlan: `theta workflow prepare --run-id "${runId}"`,
  DryRun: `theta workflow prepare --run-id "${runId}"`,
  TrainingConfirmation: `theta workflow checkpoint --run-id "${runId}"，确认后用 workflow message 回复`,
  VerifyDataset: `theta advance --run-id "${runId}"`,
  StartTraining: `theta advance --run-id "${runId}"`,
  MonitorTraining: `theta advance --run-id "${runId}"`,
  EvaluateResults: `theta advance --run-id "${runId}"`,
  Completed: `theta status --run-id "${runId}"`,
  }[phase] ?? `theta status --run-id "${runId}"`);
};

const withoutPercentages = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutPercentages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:percent|percentage)$/iu.test(key))
    .map(([key, item]) => [key, withoutPercentages(item)]));
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
