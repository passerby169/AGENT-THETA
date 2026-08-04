# THETA 2.0 Web

THETA 2.0 的独立 Web 操作面。首页直接沿用 `theta.code-soul.com` 的页面结构、
组件、样式和品牌素材；工作台继续使用相同的视觉语言，但信息架构改为匹配
THETA CLI Agent 的 Run、Event、FSM 与审批流程。一代目录保持不变。

## 边界

- Web 只通过 `theta-cli-agent` 暴露的版本化 Agent API 读取状态。
- Run 状态来自 Hypha Event Store 投影，浏览器不维护权威运行状态。
- MiniMax 和其他模型密钥只配置在 `theta_project/.env`，不会进入前端环境变量。
- 当前预览 API 是只读的；训练写操作将在审批契约接入后开放。
- 首页中的研究对话仅用于引导进入二代工作台，不会连接一代 Agent API。
- `/workbench` 展示真实本地 Run、事件数量、FSM 状态和运行环境检查结果。

## 本地启动

终端一：

```powershell
cd ..\theta-cli-agent
npm.cmd run build
npm.cmd run web:api
```

终端二：

```powershell
cd ..\theta-web-v2
pnpm install --frozen-lockfile
pnpm run dev
```

打开首页 `http://127.0.0.1:4320`，或直接进入
`http://127.0.0.1:4320/workbench`。
