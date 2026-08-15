const COPY: Record<string, { displayName: string; running: string; completed: string }> = {
  'theta.dataset.overview': { displayName: '读取数据概况', running: '正在读取数据量和列名', completed: '已读取数据概况' },
  'theta.dataset.sample': { displayName: '查看脱敏样本', running: '正在查看最多 10 条已授权脱敏样本', completed: '已查看脱敏样本' },
  'theta.dataset.column_profile': { displayName: '分析列特征', running: '正在分析列类型和取值特征', completed: '已分析列特征' },
  'theta.dataset.text_profile': { displayName: '分析正文特征', running: '正在分析正文长度、稀疏性和重复情况', completed: '已分析正文特征' },
  'theta.dataset.time_profile': { displayName: '检查时间信息', running: '正在判断时间列是否适合分析', completed: '已检查时间信息' },
  'theta.dataset.categorical_profile': { displayName: '检查分类信息', running: '正在分析可用于比较的分类列', completed: '已检查分类信息' },
  'theta.dataset.submit_understanding': { displayName: '整理数据理解', running: '正在形成有证据的数据理解', completed: '已形成数据理解' },
  'theta.research.read_workspace': { displayName: '读取研究上下文', running: '正在回顾数据理解和已有研究意图', completed: '已读取研究上下文' },
  'theta.research.update_understanding': { displayName: '更新研究意图', running: '正在根据对话更新研究意图', completed: '已更新研究意图' },
  'theta.planner.inspect_case': { displayName: '整理规划上下文', running: '正在汇总数据、研究目标、环境和当前候选', completed: '已整理规划上下文' },
  'theta.model.shortlist': { displayName: '筛选可用模型', running: '正在检查候选模型能力、参数和本地可用性', completed: '已完成候选模型筛选' },
  'theta.rag.search': { displayName: '检索研究证据', running: '正在本地知识库检索模型与实践证据', completed: '已检索研究证据' },
  'theta.planner.create_candidate': { displayName: '创建候选计划', running: '正在把研究意图编译为候选计划', completed: '已创建候选计划' },
  'theta.planner.submit_revision': { displayName: '修订候选计划', running: '正在根据校验问题修订候选计划', completed: '已修订候选计划' },
  'theta.planner.evaluate_candidate': { displayName: '校验候选计划', running: '正在绑定证据并检查参数、环境和研究意图一致性', completed: '已完成候选计划校验' },
  'theta.planner.validate_alignment': { displayName: '检查意图一致性', running: '正在检查研究意图是否全部落实', completed: '已检查研究意图一致性' },
  'theta.planner.get_candidate': { displayName: '读取当前计划', running: '正在读取当前候选、证据和校验收据', completed: '已读取当前计划' },
  'theta.agent.protocol_feedback': { displayName: '修正 Agent 协议', running: '正在修正不合法的阶段动作', completed: '已完成协议修正' },
};

export const toolActivityCopy = (toolId: string, fallbackName?: string) => COPY[toolId] ?? {
  displayName: fallbackName ?? toolId,
  running: `正在调用 ${fallbackName ?? toolId}`,
  completed: `已完成 ${fallbackName ?? toolId}`,
};
