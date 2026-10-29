# 上游来源、固定基线与署名

v0.4 把 OMD 的成熟角色/编排层**源码导入**本仓库（`vendor/omd/`），不再是“仅参考设计”。许可证义务见根目录 [`LICENSE`](../LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

## 固定基线

| 项目 | 版本 | 固定 commit | 说明 |
|---|---|---|---|
| oh-my-coharness（本仓库） | 0.3.0 → 0.4.0-alpha.1 | `b2f0d3906f9d`（合并前 tag `omc-pre-omd-merge`） | Host / Provider / Transport / Doctor |
| oh-my-dsh-slim（OMD） | 0.8.6 | `537d4c7f5dc316c449de4ccfff8ab15d15901fa6` | 导入 `vendor/omd/`，不再追踪上游 main |
| DeepSeek Harness | 0.2.1-rc.3 | 本机 Desktop 安装 | 宿主契约以运行中 Host Service 为准 |

来源记录：[`vendor/omd/UPSTREAM.json`](../vendor/omd/UPSTREAM.json)。改动清单：[`vendor/omd/PATCHES.md`](../vendor/omd/PATCHES.md)。

## 运行时依赖

本包仍**没有** `dependencies`。它通过宿主 Loader 使用 DSH 官方模块；`peerDependencies` 只表达能力期望，且全部 optional。

| 能力 | 包 | 用途 |
|---|---|---|
| 子 Agent 注册与激活 | `@deepseek-ai/dsh-subagent` | `SubagentProvider` / `startActivation` / catalog |
| 角色工具 | `@deepseek-ai/dsh-tool-subagent` | 官方 `apply()`；角色行只包裹描述与 Persona |
| 工具注册 | `@deepseek-ai/dsh-tools` | `ToolDefinition` / `defineTool` |
| Agent Preset | `@deepseek-ai/dsh-agent-preset` / `-registry` | 声明式 Preset |
| 设置 | `@deepseek-ai/dsh-settings` / `schemastery` | 设置卡 schema 与 revision |
| 子进程 | `@deepseek-ai/dsh-subprocess` | CLI 启动、收集、终止 |
| Web/客户端 | `@deepseek-ai/dsh-client-*` / `dsh-api-remotes` | 设置页 Slot、locale、RPC |
| 命令 / Skill | `dsh-commands` / `dsh-skill` | `/coharness` 与五个 Skill |

## 参考项目与借用范围

| 项目 | 许可证 | 借用了什么 | 处理 |
|---|---|---|---|
| [oh-my-dsh-slim](https://github.com/ninipa/oh-my-dsh-slim) | MIT © 2026 contributors | 角色体系、Orchestrator / Council prompt、角色工具包装、配置卡、Profile registry | **源码导入** `vendor/omd/`，保留 LICENSE，改动记录在 PATCHES.md |
| [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) | MIT © 2025 alvinunreal | OMD 角色 Persona 与 Council prompt 的上游文本；ulw / council 流程设计 | 通过 OMD 携带；署名保留在 LICENSE 与 THIRD_PARTY_NOTICES.md |
| [dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor) | MIT | 多个 CLI 的 headless argv 形态、超时 + 整树终止、head/tail 裁剪、Doctor 产品形态 | 只借鉴事实与设计，未复制代码 |
| [dsh-wsl](https://github.com/XINY11451/dsh-wsl) | MIT | `wsl.exe -e bash -lc`、路径转换边界、`DSH_WSL_DISTRO` 约定、“WSL 在 sandbox 之下”的结论 | 只借鉴事实与设计 |
| [orchestmux](https://github.com/layl-labs/orchestmux) | — | “派发 / 等待 / 收集 / 升级”与“子 Agent 未真正完成不得宣布成功” | 只借鉴流程概念 |

## 事实核查（2026-10-29 / 2026-10-30）

- 运行中的 Host Service：`subagents`、`agentPresets`、`settings`、`commands`、`tools`、`webServer`、`connection` 的精确签名（`cordis_inspect_query`）。
- `@deepseek-ai/dsh-tool-subagent` 0.2.1 源码：`Config` 只接受 `provider` / `toolName` / `modelSelectionSettings` / `agentOptions` / `agentPreset` / `allowedAgentPresets` / `maxDepth`；`persona` / `toolFilter` 已移除；外部 provider 无 `prepareContinuable` 时走 `startExternal`。
- `@deepseek-ai/dsh-subagent` 0.2.1 源码：`SubagentCapabilities` 四项、`provider-managed` maxDepth、external run 的 `id`/`result`/`dispose` 契约。
- `@deepseek-ai/dsh-client-modules` 源码：客户端 bundle 从 package `exports["./client"]` 解析，module id 取包名。
- 本机 CLI 实测：opencode 2.1.4、codex 0.165.0、kimi 2.4.0、antigravity 1.4.10、claude/GLM 2.1.312；argv 与认证状态见 README 支持矩阵。

## 代码复用门槛

若未来再次复制超过约 20 行第三方代码，必须：

1. 在 `THIRD_PARTY_NOTICES.md` 增加来源、版权行、许可证；
2. 在源文件头部保留原版权声明；
3. 在 `vendor/` 中保留原始 LICENSE；
4. 不把第三方代码混入本仓库 MIT 声明而不加区分。
