# THETA 2.0 Web

THETA 2.0 的独立 Web 操作面。它复用 THETA 一代的产品语言，但不修改或依赖
`theta.code-soul.com` 的运行状态、认证接口和训练 API。

## 边界

- Web 只通过 `theta-cli-agent` 暴露的版本化 Agent API 读取状态。
- Run 状态来自 Hypha Event Store 投影，浏览器不维护权威运行状态。
- MiniMax 和其他模型密钥只配置在 `theta_project/.env`，不会进入前端环境变量。
- 当前预览 API 是只读的；训练写操作将在审批契约接入后开放。

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
npm.cmd install
npm.cmd run dev
```

打开 `http://127.0.0.1:4320`。
