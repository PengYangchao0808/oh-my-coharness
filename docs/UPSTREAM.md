# 借鉴来源与署名

本包不复制上述项目的源代码。以下记录的是**事实与设计**的来源，以及若将来复用代码必须遵守的许可证。

## 依赖（运行时）

无。v0.1 不声明任何 `dependencies` 或 `peerDependencies`，只声明 `engines.dsh`。

## 直接依赖的宿主能力（DSH 官方，随宿主发布）

| 能力 | 包 | 用途 |
|---|---|---|
| 子 Agent 接缝 | `@deepseek-ai/dsh-subagent` | `SubagentProvider` / `SubagentRun` / `startActivation` |
| 进程 | `@deepseek-ai/dsh-subprocess` | `resolveExecutable` / `spawn` / 收集模式 / 终止 |
| 工具 | `@deepseek-ai/dsh-tools` | `ToolDefinition` |
| 命令 | `@deepseek-ai/dsh-commands` | `/coharness` |
| Skill | `@deepseek-ai/dsh-skill` | `ctx.skills.register` |

## 参考项目

| 项目 | 许可证 | 借用了什么 | 没有借用 |
|---|---|---|---|
| [dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor) | MIT | 11 个 CLI 的 headless argv 形态、10 分钟超时 + 整树终止、head/tail 裁剪思路、doctor 的产品形态 | 代码、`conductor_dispatch` 工具名、Python 脚本 |
| [dsh-wsl](https://github.com/XINY11451/dsh-wsl) | MIT | WSL 执行的事实：`wsl.exe -e bash -lc`、路径转换的边界情况、`DSH_WSL_DISTRO` 约定、「wsl 在 sandbox 之下」这一结论 | 10 个工具、面板、bootstrap、terminal |
| [oh-my-dsh-slim](https://github.com/ninipa/oh-my-dsh-slim) | MIT | 角色语义、background-first 委派纪律、配置卡的形态 | preset 结构、角色实现、persona |
| [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) | MIT | ulw / council 的流程设计（v0.2） | persona 文本（若复用须保留 `MIT © 2025 alvinunreal`） |
| [orchestmux](https://github.com/layl-labs/orchestmux) | — | 「派发 / 等待 / 收集 / 升级」四段式，以及「子 Agent 未真正完成不得宣布成功」 | 任何代码、coordinator 进程 |
| [multiagents](https://github.com/) | — | 跨 Agent 消息与 Handoff 的概念（v0.3） | Orchestrator、Dashboard |

> 在实现 v0.2/v0.3 时若确实复制超过约 20 行代码，必须在此文件新增一节，写明来源文件、版权行与许可证全文位置。

## 事实核查来源（2026-10-29）

- 本机安装：`DeepSeek Harness/resources/app.asar/dsh/package.json`（`0.2.1-rc.3`）、profile `desktop`。
- 宿主契约：`@deepseek-ai/dsh-subagent`、`dsh-tools`、`dsh-commands`、`dsh-skill`、`dsh-subprocess`、`dsh-worktrees` 的 README 与类型声明。
- npm registry：`oh-my-dsh-slim@0.8.5`、`dsh-wsl-tool@2.2.3` 的 manifest；`oh-my-coharness` 返回 404（名字可用）。
- 市场机制：`@deepseek-ai/dsh-plugin-market` README（"There is no official market"）、`dsh-experimental-plugin-market-bundle` README、`awesome-dsh-plugin` README（format-1 索引 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）。
