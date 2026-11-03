# DSH 契约边界：OMC 仍未支持的能力

日期：2026-11-02。对象：DSH 0.2.1-rc.5 + OMC 0.5.0-alpha.1。

> 审计修正：当前宿主源码已确认支持 native child 初始 cwd、运行时 agentPresets.register，以及能力允许时的逐调用模型选择。本文第 2 / 4 / 5 节的绝对限制表述不能作为当前开发结论；具体事实与剩余接线工作见 [剩余工作审计第 5 节](REMAINING-AUDIT.zh-CN.md#5-需要纠正的宿主边界说明)。首轮后整体 preset select 锁定仍有源码依据。

本文件只记录**由宿主契约决定、不能靠 OMC 单方面安全补齐**的能力。它不是“未实现清单”的替代：已实现的 OMC 能力见 [持久化编排](DURABLE-ORCHESTRATION.zh-CN.md) 与 [差异审计](OMO-SLIM-PARITY.zh-CN.md)。

## 1. 当前会话 preset 热切换

**DSH 行为**：Agent 第一次 turn 之后，`agentPresets.select()` 返回 `agent-preset/locked`；已存在的 Agent 保留创建时的 preset revision。`agentPresets.read/select` 的语义是“选择新会话的 preset / 读取声明”，不是替换运行中 Agent 的插件树。

**OMC 现状**：

- `coharness({action:"preset", preset_action:"snapshot"})` 记录本会话实际生效的 OMC 角色配置；
- `status` 与当前全局配置 diff，明确 `hotSwitch:false`；
- 已创建的 child 不会被改写。

**为什么不能绕过**：替换运行中 Agent 的 preset 需要重新挂载插件树、重新注册工具并迁移已有会话；DSH 没有公开的“replace preset in place”接口。直接改工具注册会与 Agent loop 的 snapshot 语义冲突。

**需要上游**：一个显式的 `agentPresets.replace(agent, revision)` 或等价的“新 revision + 迁移”契约。

## 2. Native per-child worktree

**DSH 行为**：`ctx.worktrees.create()` 改变**整个 Session** 的 cwd；没有 per-child `cwd` / worktree 选择。子 Agent 继承父 Session 的工作目录。

**OMC 现状**：

- `coharness worktree` 创建/进入 session-wide checkout，支持显式 merge；
- `dispatch mode:"worktree"` 为每个**外部任务**创建 disposable branch checkout，CLI 在 checkout 内写，结果返回 branch/path/files/diff；
- native child 仍没有独立 cwd，因此不能安全地让两个 native Fixer 并行写同一仓库。

**为什么不能绕过**：OMC 不能伪造 DSH 子 Agent 的 cwd；外部进程可以换 cwd，native Agent 的 Session 不能。

**需要上游**：per-child workspace/cwd，或可嵌套的 worktree scope。

## 3. 外部运行中实时 steer

**DSH 行为**：外部 Agent Provider 的必需接口是 `start()`；`prepareContinuable` 是可选能力。没有 `prepareContinuable` 的 provider 只能启动一次性激活，不能在其运行中注入消息。

**OMC 现状**：

- 原生 child 可以用宿主 `send_message` 实时 steer；
- 外部 child 的 `coharness send` 进入 durable mailbox，等本轮结束后由同 Lane 的 `reuse` 带入下一次委派；
- 不是进程内实时 steer。

**为什么不能绕过**：OMC 没有外部 CLI 的 stdin/控制协议；向一个已经启动的 CLI 进程写入任意文本不是 DSH 的 continuable 契约。

**需要上游/后端**：支持 ACP 或 app-server continuation 的 adapter，并实现 `prepareContinuable`。

## 4. Native 自定义角色与项目级角色绑定

**DSH 行为**：preset 是 profile 里的 Cordis 插件行（`@deepseek-ai/dsh-agent-preset`），由 Loader 在启动/装载时构图；没有运行时 `registerPreset` 接口。Agent 的 preset 在创建时选择，之后不替换。

**OMC 现状**：

- `coharness role` 支持用户级 + `.omc/roles.json` 项目级 **external read-only 角色模板**；
- 模板可带 `model`、`fallbacks`，但执行仍走外部 CLI；
- 没有 `subagent_<custom>` native 工具，也不能按项目 cwd 重绑 native 角色模型/Prompt/Skill/MCP。

**为什么不能绕过**：新增 native 角色需要新增 preset row/工具行，并让新会话选择它；运行中动态注册工具会改变已存在 Agent 的工具集，违反 DSH 的 preset snapshot 语义。

**可行路径**：生成一个 profile bundle patch（或项目 bundle），安装后新建会话；不是当前会话热切换。

## 5. 角色级模型自动回退（native 角色工具）

**DSH 行为**：角色工具是 stock `@deepseek-ai/dsh-tool-subagent` 的静态配置；`agentOptions`（provider/model）在注册时固定。角色工具执行失败后没有 OMC 可插入的重试钩子。

**OMC 现状**：

- `dispatch` 有显式 `fallbacks`，只在可重试错误上换 harness；
- 自定义 external 角色有 `role_fallbacks`；
- native 角色工具仍按注册时模型，不会自动换模型。

**为什么不能绕过**：要重试 native 角色，需要在工具 wrapper 内重新创建激活并换 `agentOptions`；这等于重写 stock 工具的会话/容量/结果语义，且可能与 DSH 的 child 身份记录冲突。

**需要上游**：role/provider 级别的 `agentOptions` 覆盖或可重试的 activation API。

## 6. Desktop 混合编排验收

**不是代码缺口**，是验收缺口：

- 隔离宿主已通过（`OMC_HOST_LIVE_PASS`，9 工具，0 模型调用）；
- Codex Provider 两轮真实续接已分别通过；
- 尚未在真实 Desktop UI 中跑 Oracle/Codex → Fixer/native → 混合 Council 全链路。

步骤与记录模板见 [Desktop 验收清单](DESKTOP-ACCEPTANCE.zh-CN.md)。在没有这份记录前，不应把 P0-4 标为完成。

## 7. 当前可安全承诺的替代方案

| 需求 | 替代 |
|---|---|
| 当前会话换角色配置 | 新建会话；用 `preset snapshot` 审阅旧会话实际配置 |
| native 并行写 | 串行 native Fixer；或 `dispatch mode:"worktree"` 的外部任务 |
| 运行中追加要求 | 原生 `send_message`；外部走 mailbox + 下一轮 `reuse` |
| 自定义角色 | external read-only 模板；需要 native 时生成 bundle patch 后新会话 |
| 角色模型失败 | dispatch/custom-role 显式 fallback；native 角色手动改配置后新会话 |
