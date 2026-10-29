> **历史文档（v0.2 / v0.3）**：v0.4.0-alpha.1 已将 OMD v0.8.6 源码合并进 Oh My CoHarness，
> 文中“OMC 与 OMD 两个插件并存 / 两套角色入口”的前提不再成立。
> 当前架构、角色后端与迁移方式见 [`ARCHITECTURE.zh-CN.md`](./ARCHITECTURE.zh-CN.md)、
> [`MIGRATION.md`](./MIGRATION.md)。

# 角色 → Harness 路由：现状、差距与方案

> 2026-10-29 · 针对「OMD 调用的子 Agent 应该是不同 harness」这一本意
> 相关：[`V0.2-PLAN.zh-CN.md`](./V0.2-PLAN.zh-CN.md) §3.1 / §11 · [`ACCEPTANCE-V0.2.md`](./ACCEPTANCE-V0.2.md) Case B

## 0. 一句话结论

**当前实现不满足这个本意，而且不是配置问题，是接线问题。**
`oh-my-dsh-slim` 的角色工具在源码里把子 Agent 后端写死成 `provider: 'spawn'`（DSH 进程内子 Agent），
OMC 只提供 `omc:<id>` 外部 CLI provider 和一个独立的 `coharness` 工具。
两者唯一的汇合点是主 Agent——角色从来不会走到外部 CLI 上。

好消息：DSH 的 `@deepseek-ai/dsh-tool-subagent` **支持**用 `config.provider` 绑定任意已注册 provider，
所以「角色跑在 Codex / Kimi / GLM 上」技术上可行，缺的是**一个把两者接起来的薄层**。

## 1. 事实（读源码得到，不是推断）

| 事实 | 出处 |
|---|---|
| 子 Agent 工具的配置项：`provider`（必填）、`toolName`、`modelSelectionSettings`、`agentOptions`、`agentPreset`、`allowedAgentPresets`、`maxDepth`；**没有** `description` 或 `backgroundMode` | 宿主 asar `dsh-tool-subagent/lib/index.js` → `Config = z.object({…})` |
| 挂载时会校验 provider 能力：非 `provider-managed` 的 `maxDepth` 要求 `depthLimit`；`agentOptions` 要求 `agentOptions`；独立 preset 要求 `agentPreset` 且不继承父上下文 | 同上 `assertSubagentProviderConfiguration` |
| 一次性还是可续接由 **provider 能力**决定（有没有 `prepareContinuable`），不是工具配置项 | 同上 |
| slim 的每个角色行：`provider: 'spawn'`、`backgroundMode: 'continuable'`、`maxDepth: 1` | `oh-my-dsh-slim/preset/preset.js` → `roleRow()` |
| slim 角色卡片里的 `provider/model` 是**LLM 模型路由**，不是 subagent 后端 | `oh-my-dsh-slim/preset/subagent-roles.js` → `targetRoute()` 读 `session.requestHeader().config` |
| OMC 的 provider 能力：`agentOptions:false, agentPreset:false, outputSchema:false, depthLimit:false` | `src/provider.js` |
| OMC 的 `coharness` 是独立工具，角色不会调用它；只有主 Agent 会 | `src/index.js` / `src/dispatch.js` |

## 2. 两条链路的区别

| 维度 | DSH 原生子 Agent（slim 的 `subagent_*`） | OMC 外部 Harness（`coharness → omc:<id>`） |
|---|---|---|
| 执行位置 | 同宿主进程，DSH Agent | 独立 CLI 进程（codex / opencode / kimi / agy / glm） |
| 模型 | 默认继承会话模型；可在卡片里按角色 pin `provider/model` | 该 CLI 自己的模型与登录 |
| 上下文 | 可由父会话派生（spawn/fork） | `inheritsParentContext: false`，一次性、看不到对话 |
| 生命周期 | `continuable`、后台优先、`send_message` 追问、名册 | one-shot；不能追问、没有 nativeSessionId |
| 结果形态 | 结构化 content blocks | 纯文本（`outputSchema: false`） |
| 写权限 | 受 DSH sandbox / approval 管辖 | 绕过 DSH 策略，用 CLI 自己的权限 |
| 容量 | 宿主 `maxActiveSubagents`（默认 8） | provider 路径受同一容量约束；direct 路径无容量槽 |
| 计费 | 会话模型 | 各自 CLI 的配额 |
| 角色人格 | 每个角色一套 persona + 工具白名单 | 无（OMC 目前不注入 persona） |

**结论**：slim 的角色是「同一台机器上的不同专家」，OMC 的 harness 是「另一台机器上的另一个团队」。
本意要的是后者被当作前者使用——目前没有这条接线。

## 3. 三种接法

### A. OMC 提供「绑定 harness 的委派工具」（最贴近本意）

用 DSH 原生机制：给每个外部 harness 挂一个 `@deepseek-ai/dsh-tool-subagent` 行，`provider: 'omc:<id>'`。

```yaml
# 形态示意（preset 内）
- id: subagent_codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: omc:codex
    toolName: subagent_codex
    maxDepth: provider-managed   # 必须是这个：OMC 没有 depthLimit 能力
    # 不写 agentOptions：OMC 没有 agentOptions 能力
```

- **得到什么**：主 Agent 像用角色一样用 `subagent_codex` / `subagent_kimi`，每个都不一样的 CLI；
  有 `childId`、容量、完成通知，结果进子会话面板（比 `coharness` 的 direct 路径好）。
- **代价**：
  - 需要一个新的 **agent preset**（工具行必须在 agent 作用域里），用户要选这个 preset；
  - 工具描述默认是通用的，要像 slim 那样做一层 `tools.register` 代理来写「这是什么角色」；
  - 每个 harness 一个工具，模型可见工具数量上升；
  - 外部 provider 不支持 `continuable` / `agentOptions` / `outputSchema`，必须避开这些能力位。
- **风险**：与 slim 的 `subagent_*` 并存，模型要会挑；preset 是新的产品面。

### B. `coharness` 加 `role` 字段 + 路由表（最小）

```jsonc
coharness({ action: 'dispatch', role: 'oracle', prompt: '…' })
// config: roles: { oracle: 'codex', explorer: 'opencode', librarian: 'kimi' }
```

- **得到什么**：一个工具、一条路由表，主 Agent 说「让 oracle 看」就走 Codex；provider 路径仍有 `childId`。
- **代价**：这是 0.2.1 才允许的 Schema 变更（V0.2-PLAN §4.4 明确把 `role` 留到 0.2.1）；
  角色语义仍是「主控选择」，不是 DSH 原生角色工具。
- **风险**：小；但本意里「角色是可委派的 Agent」这一层仍是提示词纪律。

### C. 让 slim 的角色改用外部 provider（改上游）

在 slim 的 `roleRow()` 里把 `provider` 变成可配置项，指向 `omc:<id>`。

- **不推荐**：slim 的整套机制（background-first、`continuable`、名册、角色作用域 persona、
  `send_message` 追问）都建立在**本地可续接子 Agent** 上；外部 provider 是 one-shot，
  即使接上也会退化成「没有续接的角色」，与 slim 的产品承诺冲突。要做也应该走上游 PR 并明确降级语义。

## 4. 路线与实施状态

| 阶段 | 做什么 | 状态 |
|---|---|---|
| 0.2.x | 现行方式：`coharness` 的 `harness` 参数 + Skill 约定（oracle→codex…） | 可用，但这是纪律不是能力 |
| 0.2.1 候选 | **B**：`role` 字段 + `roles` 路由表 | **未做**（A 落地后优先级下降） |
| **0.3.0** | **A**：OMC 自家的 agent preset，内含 `subagent_<harness>` 委派工具 | **已实现**，见 §4.2 |
| 不做 | **C**：改 slim 的角色 provider | 语义错配（外部 provider 不可续接） |

### 4.1 要不要「重写一个 OMD」？

**不用，而且不该。** 需要区分三件事：

| 你以为要做的 | 实际要做的 | 是否动 OMD 源码 |
|---|---|---|
| 重写整 OMD（角色 + 设置卡 + Council + 命名配置 + MCP 作用域） | 什么都不用：OMD 继续装、继续用它自己的 preset 与设置卡 | 否 |
| 让 OMD 的 `subagent_oracle` 跑 Codex | 只能改 OMD 的角色行（`provider: 'spawn'` → 可配置）；它不支持外部 provider 的续接语义 | **是**（上游 PR 或 fork） |
| 让主 Agent 能把「角色」派给不同 CLI | 只需一层薄接线：B（工具加 `role`）或 A（OMC 自己的 preset，用宿主现成的 `dsh-tool-subagent` 行） | 否 |

关键点：**A 不是重写 OMD**。A 不实现 agent 运行时、不复刻 persona、不做设置卡；它只是复用宿主已有的
`@deepseek-ai/dsh-tool-subagent`，把每次挂载的 `provider` 指向 `omc:<id>`。OMD 与 A 是两个并列的 preset，
用户选一个即可，装在一起也不会互相改代码。

真正的「重写」代价在于 OMD 那一整套产品面（后台优先、可续接、名册、Council 综合、命名配置、MCP 作用域），
而这些东西**都不是**「角色跑在不同 CLI 上」这个需求的一部分——外部 CLI 本来就不能续接。

### 4.2 A 已落地（0.3.0）——怎么用

bundle 的 `cordis.patch.yml` 插入了一个 preset 行 `preset-omc-harness`（`id: omc-harness`），
工具面与官方 `standard` 一致，只在 `delegation` 组里多了四个绑定外部 provider 的委派工具：

| 工具 | provider | 定位 |
|---|---|---|
| `subagent_codex` | `omc:codex` | 架构、硬调试、实现评审 |
| `subagent_antigravity` | `omc:antigravity` | UI、视觉、前端打磨 |
| `subagent_opencode` | `omc:opencode` | 代码库侦察、文件地图 |
| `subagent_kimi` | `omc:kimi` | 长上下文阅读、外部资料 |

用法：

1. 重启 DSH（或确认 Settings → Agent Presets 已出现「OMC · 外部 Harness 角色」）。
2. **新建**一个使用该 preset 的会话。
3. 说「用 subagent_codex 评审这段设计」，或直接 `subagent_codex({ prompt: "You are the oracle: …" })`。

**硬约束（由宿主与 provider 共同保证）**：

- 这些子 Agent **只能只读**：工具没有 mode 参数，provider 用配置里的 `dispatch.defaultMode`（默认 read-only）。
  要写文件仍然必须走 `coharness({ mode: 'in-place' })`，那是另一条显式路径。
- **一次性**：外部 CLI 不支持 `send_message` 追问与续接；需要同一上下文继续，用本地 `subagent`。
- **能力位对齐**：外部 provider 没有 `depthLimit` / `agentOptions` / `agentPreset`，所以行配置固定
  `maxDepth: provider-managed`，且不写 `agentOptions`——写错会在挂载时被宿主拒绝。
- **harness 缺失**：某个 CLI 没装或未启用时，对应工具不会注册（它在等 `subagent/provider-added`），
  而不是给一个必然失败的入口。
- **与 slim 的关系**：两个 preset 并列。用了 slim 的 preset 就没有这四个工具；用了 OMC 的 preset
  就没有 slim 的 `subagent_*` 角色。不要在同一会话里指望两套角色工具都出现。

## 5. 验收（落 B 或 A 时照此验）

- **角色路由**：`role: 'oracle'` → 实际 `harnessId: 'codex'`；路由表里没有的 role → 明确报错，不猜。
- **不静默降级**：目标 harness `signed-out` / 缺失时，返回该任务失败 + 原因，不换另一个 harness。
- **两种路径都可见**：provider 路径有 `childId`，direct 路径有 `surface: direct` + 原因。
- **与 slim 共存**：装了 slim 时，角色工具与 `coharness` 同时可用；模型不重复跑同一个任务。
- **成本**：默认一次只用 1 个外部角色；council 2 席；不允许「为了角色而角色」的扇出。

## 6. 需要你拍板的两点

1. **「不同 harness」= 不同模型 还是 不同 CLI？**
   如果只是不同**模型**，slim 的角色卡片已经支持按角色 pin `provider/model`——不需要 OMC 任何改动。
   如果是不同 **CLI 进程**（Codex / Kimi / GLM / AGY），才需要上面的 A 或 B。
2. **要「一个工具带角色参数」（B）还是「一排角色工具」（A）？**
   B 小、快、今天就能规划；A 更接近你描述的体验，但要新增 preset 与工具描述层。
