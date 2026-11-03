# OMC 与 OMO-SLIM：可用化差距与开发顺序

核查日期：2026-11-02。OMC 基线：`0.5.0-alpha.1`，本次修改留在 Unreleased。

> **2026-11-03 现状复核：** [当前差距报告](OMO-SLIM-GAP-2026-11-03.zh-CN.md) 已纳入后续基础实现与查询时的上游文档，优先用于判断当前差距。旧表中的“缺失/已完成”可能不再准确；上游已有 Developer Evals、Reflect 与 Runtime Efficiency，不能将这些方向笼统视作 OMC 已领先的功能。

> 后续独立核查发现：项目限制、CLI 解析/分类组合与 preset 快照仍有缺口，部分宿主限制表述也需纠正。当前完成状态以 [剩余工作审计](REMAINING-AUDIT.zh-CN.md) 为准，不应仅凭本文阶段性 ✅ 判断已完成。

## 0. 现在到底能用什么

OMC 目前有两个层次，成熟度不同：

1. **DSH Native 角色层**（从 OMD-Slim 继承，实际可用）：Orchestrator + Oracle / Explorer / Fixer / Designer / Librarian / Council，子 Agent、工具、权限、会话全部由 DSH 管理；每个角色可以钉一个 provider/model。
2. **外部 Harness 层**（alpha，只有 Codex 真正过了两轮续接）：`omc:<id>` Provider → CLI，只读角色、Handoff、Session Registry。它不是“所有 CLI 都可用”，也不是多 Harness 同时协同。

“尽快可用的 demo”只做第 1 层：不引入外部 CLI，不新建模型 Provider，直接把用户已经在 OMD-Slim 里配好的角色模型搬进 OMC，并用一个真实任务把“分工 → 执行 → 结果 → 验证”跑通。见 [原生多模型 Demo](NATIVE-FLEET-DEMO.zh-CN.md)。

### 0.1 现在可承诺 / 不可承诺

| 能力 | 现状 | 证据或边界 |
|---|---|---|
| Native 角色编排 | ✅ 可用 | 继承 OMD 0.8.6 的角色与绑定；隔离宿主装载 9 个工具通过 |
| 每角色独立 DSH 模型 | ✅ 可用 | `roles.<id>.provider/model`；`fleet` 从实时模型目录生成，并在 `status` 校验 |
| 复用现有 OMD-Slim 角色模型 | ✅ | `fleet` 读取仍挂载的 `oh-my-dsh-slim` 设置，完整 provider/model 对作为首选 |
| 一键 demo（原生） | ✅ | `/coharness demo`：写 fleet + 生成确定性工作区 + 给出可直接粘贴的 prompt；不自动调模型 |
| 跨进程会话锁 / profile 分区 | ✅ | `$DSH_HOME/omc/profiles/<profile>/`；Lane lease + dirty 合并；两进程实测 |
| 持久外部结果 / unknown | ✅ | `tasks/result` 重启后可读；结果体丢失返回 `unknown` |
| 工作图 / 验收 / 写范围 | ✅ | `coharness graph` plan/claim/complete/audit；写节点必须给 changed_files |
| 消息邮箱 / 任务复用 | ✅ 基础层 | `send/inbox/ack/thread/reuse`；原生 child 走 `send_message`，外部排队 |
| Runtime 设置卡 / 逐 Lane 清除 | ✅ | 设置卡第三个 tab；`/coharness sessions --clear --lane=<id>` |
| 外部 CLI 角色 | ⚠️ Alpha | Codex 两轮真实续接已验证；Claude/Kimi/OpenCode/Gemini/GLM 仍是 documented/unverified |
| 外部运行中实时 steer | ⚠️ 部分 | 只有 durable mailbox 排队；DSH 外部 Provider 无 `prepareContinuable` |
| 外部 dispatch fallback | ⚠️ 部分 | 显式 `fallbacks` 只在可重试错误上换线；角色工具没有模型级回退 |
| 项目配置 / 自定义角色 | ⚠️ 部分 | `.omc/project.json` 只能收紧 dispatch/harness/routing；`coharness role` 用户级 + `.omc/roles.json` 项目级 external read-only 模板；没有项目级角色模型/Prompt/Skill/MCP 绑定与 native 自定义角色工具 |
| 当前会话 preset | 🟡 | `preset snapshot/status` 记录实际快照并对比全局；热切换仍受 DSH `agent-preset/locked` 限制 |
| per-child worktree | 🟡 | `dispatch mode:"worktree"` 给每个外部任务独立 checkout；`coharness worktree` 是 session-wide；native child 仍无 per-child cwd |
| 多 Harness 同时协同 | ❌ 下一阶段 | 没有消息总线，也不应现在做 |

### 0.2 与 OMO-SLIM 的差距，按“用户感知”重排

| 用户要做的事 | OMO-SLIM | OMC 现在 | 判定 |
|---|---|---|---|
| 让主控把任务分给专家 | 内置角色、后台优先、可并行 | 角色工具 + 原生子 Agent + 后台通知 | 可用 |
| 每个专家用不同模型 | 独立 model/variant/继承/故障切换 | `provider/model/effort`，`fleet` 自动分配 + 目录校验 | 可用（无角色级自动故障切换） |
| 看谁在跑、跑到哪 | 后台任务状态、结果查询 | `list_agents`、`send_message`、`subagent_result`、`/coharness status`、graph | 部分（无统一 UI 任务图） |
| 运行中追加要求 | steer/message | 原生 `send_message`；外部排队 | 原生可用，外部不可实时 |
| 完成后继续同一任务 | 原生会话复用 / resume | 原生 `send_message`；外部同 Lane 再委派 + `reuse` | 部分 |
| 跨角色交接事实 | 主控调度、上下文交接 | `context_summary/changed_files/artifact_refs/acceptance` | 部分（结构有，自动门禁靠 graph） |
| 接入别的 Agent | ACP wrapper | CLI start/resume；mcp/app-server 显式不支持 | Alpha |
| 写入隔离/并行改代码 | worktrees + 合并 | session-wide worktree + 显式 merge；无 per-child | 部分 |
| 项目配置/自定义角色 | 项目层合并、自定义 agent | 项目权限下限 + external role 模板；无 native 自定义角色 | 部分 |

## 1. 对齐哪个上游

| 对象 | 核查基线 | 用途 |
|---|---|---|
| OMO-SLIM | 仓库显示 3.0.6；源码固定到 `5c6655f0b7d36b0e7c1b3e537eedf799ee971102` | 主要功能目标 |
| 已导入 OMD | 0.8.6，`537d4c7f5dc316c449de4ccfff8ab15d15901fa6` | OMC 现有角色、原生宿主接线、设置卡来源 |
| 当前 OMD | CHANGELOG 已出现 0.8.7 / 0.8.8 | 参考宿主兼容降级、Windows/Linux 控件修复 |
| DSH | 本机 0.2.1-rc.5 | 本次真实装载验收 |
| 完整 OMO | `code-yeongyu/oh-my-openagent` | 第二阶段参考；不整包移植 |

上游入口：[SLIM 源码](https://github.com/alvinunreal/oh-my-opencode-slim/tree/5c6655f0b7d36b0e7c1b3e537eedf799ee971102)、[OMD 更新记录](https://github.com/ninipa/oh-my-dsh-slim/blob/main/CHANGELOG.md)、[OMO 当前项目](https://github.com/code-yeongyu/oh-my-openagent)。

## 2. 功能差异矩阵

> 本表是能力目标；本批新增的持久化/工作图/邮箱/Runtime 卡不改变“完整复刻未完成”的结论。

| 功能 | 当前 OMO-SLIM | OMC 状态 | 仍需完成 |
|---|---|---|---|
| Orchestrator + 专业角色 | 内置角色、职责路由、后台优先 | Oracle / Explorer / Designer / Fixer / Librarian / Council；保留 OMD Persona | 路由正确率与任务集评估 |
| 每角色多模型 | 独立模型、variant、继承与故障切换 | 原生 provider/model/effort；`fleet` 分配；外部 CLI 模型配置 | 角色级失败分类与回退链 |
| 后台分工 | 原生后台 + managed/native/off 生命周期层 | DSH startActivation、完成通知、原生 send_message；外部结果持久化 | 主控对结果的验收/消费状态、重启恢复诊断 |
| 任务查询和取回 | task_status、结果与异常片段查询 | 原生 list_agents/subagent_result；外部 tasks/result；durable unknown | 统一结果 UI、异常片段查询 |
| 取消 | 保留会话、由宿主中断 | 原生 interrupt_agent；外部 cancel 走宿主；重启后只记录请求 | Desktop UI 取消、超时、父会话关闭验收 |
| 正在运行时追加要求 | steer/message | 原生 send_message；外部 mailbox 排队 | 外部实时 steer（依赖 ACP） |
| 完成后继续 | 原生子会话复用、显式 resume | 原生 send_message；外部同 Lane + `reuse` | 统一“继续此任务”UI、确定失败处理 |
| 跨角色交接 | 主控调度和上下文交接 | context_summary / changed_files / artifact_refs / acceptance；graph 验收 | 自动验收门禁接入角色工具 |
| 外部 Agent 接入 | ACP wrapper，连接/选模/更新流 | CLI start/resume；mcp/app-server 不支持 | 真正 ACP/app-server 适配 |
| Council | 并行席位、按需流程、合成 | 原生合成器、混合席位、失败如实报告 | 真实混合模型 Council 回归 |
| 项目配置/自定义角色 | 项目层合并、Prompt/skills/MCP、自定义 agent | `.omc/project.json` 权限下限；`coharness role` external read-only 模板；无 native 自定义角色 | 项目级角色绑定、权限收紧、卸载清理 |
| 运行时预设 | 当前会话与全局默认分开 | 设置卡命名配置、Runtime tab；当前会话受 DSH 锁 | 当前会话 preset 快照/热切换（依赖 DSH） |
| 长任务/Deepwork | 分阶段、阶段评审、压缩恢复 | coharness-ulw / verify 是流程 Skill | 持久任务图、完成门禁、压缩恢复 |
| 代码工具增强 | AST 搜索/替换、LSP、增强 webfetch | DSH 原生读写/检索/Web/压缩 | 按生态评估，不复制冲突工具名 |
| 并行写入隔离 | worktrees Skill + 工作 Lane | session-wide worktree + 显式 merge；graph 写互斥 | per-child worktree、自动合并验收 |
| 视觉/附件 | Observer、图片路由 | Observer 锁定；外部附件省略 | 附件协议、视觉模型目录 |
| Interview / Implement | 结构化访谈、规格与实现 | 无 | 核心链路稳定后实现 |
| Companion / 分屏 / 市场 | 独立表面与生命周期 | DSH 原生子代理 UI + OMC 设置卡 | 可选体验 |

依据：[后台编排](https://github.com/alvinunreal/oh-my-opencode-slim/blob/5c6655f0b7d36b0e7c1b3e537eedf799ee971102/docs/background-orchestration.md)、[任务与工具](https://github.com/alvinunreal/oh-my-opencode-slim/blob/5c6655f0b7d36b0e7c1b3e537eedf799ee971102/docs/tools.md)、[配置](https://github.com/alvinunreal/oh-my-opencode-slim/blob/5c6655f0b7d36b0e7c1b3e537eedf799ee971102/docs/configuration.md)、[ACP](https://github.com/alvinunreal/oh-my-opencode-slim/blob/5c6655f0b7d36b0e7c1b3e537eedf799ee971102/docs/acp-agents.md)、[Worktrees](https://github.com/alvinunreal/oh-my-opencode-slim/blob/5c6655f0b7d36b0e7c1b3e537eedf799ee971102/docs/worktrees.md)。

## 3. 已修复的关键问题

| 问题 | 修复 |
|---|---|
| lane 被实现读取，但工具不声明 | 外部角色工具声明 lane 与交接字段 |
| 省略/相对 cwd 时先按错误目录签交接 | 先用 DSH workingDirectory.ensure 解析；Provider 校验签名 workspace 与实际 cwd |
| resumePolicy:new 未参与选会话 | 获取 lease 时强制 fresh |
| 到期/换 native id 后沿用旧 turns | 新会话重置轮数与用量 |
| require-resume 可能被绕过 | 前置条件不足即失败，不留虚假 running |
| 等待 lease 不响应取消 | 获取前及等待循环检查 signal |
| 无外部结果重读入口 | `coharness tasks/result/cancel` |
| 取消请求被当作完成 | 取消走宿主；结果索引保持 running 直到真实结算 |
| 原生 fork 结果扫描父历史 | 忽略 inheritedEventCount 之前消息 |
| Windows/Linux 下拉透明底 | 控件绘制不透明主题底色 |
| 外部结果索引重启丢失 | durable tasks + `unknown` |
| 只有一个进程内 lease | profile 分区 + 跨进程 token/心跳锁 + dirty 合并 |
| 工作图/写范围只靠 Prompt | `coharness graph` 运行时 claim/acceptance/write audit |
| 设置卡无会话/路由/用量 | Runtime tab + 逐 Lane 清除 + usage |
| exit 0 被当作完成 | `classifyCliResult` 独立 code/status |
| 项目文件可能放宽权限 | `.omc/project.json` 只允许收紧 |

## 4. 多模型、通信、会话复用分别意味着什么

### 多模型

1. **DSH 原生多模型**：角色指定 provider + model，工具、权限、会话仍由 DSH 管理。这是写入角色最完整的路径。
2. **外部 CLI 多模型**：OMC 启动 CLI；模型、登录、配额由 CLI 自己决定。Provider 注册成功不代表登录/调用成功。
3. **LLM Provider 与 Agent Provider 不相同**：前者提供模型流和工具调用，后者提供有独立生命周期的执行者。

### 通信

```text
DSH 原生子 Agent ← send_message → 主控
                                   │
                                   ├─ 自包含任务 + 已验证交接 → 外部 CLI
                                   └← 完成报告 + 原生会话引用 ─┘

coharness send/inbox/reuse：持久 mailbox，跨重启补位
```

外部 Agent 没有点对点实时通道；主控收到 Oracle 结果后，显式把必要事实交给 Fixer，才算跨角色协作。外部运行中的新要求排队，结束后再续委派。

### 复用

| 标识 | 属于谁 | 能做什么 |
|---|---|---|
| DSH child id | 一次原生或外部 activation | 取回本次结果、请求中断；外部 id 不能 send_message |
| OMC lane | 一个工作方向 | 再次委派时定位同一个复用候选 |
| CLI native session id | 某一个 CLI 的原生对话 | 仅该 CLI 可恢复；不是跨模型共享内存 |
| taskId | 一次交接 | 追踪本轮任务；不能代替 child id 或 native id |

相同角色、工作区、Lane、Harness、模型、环境与端点都匹配且上轮成功时，才可能恢复。默认 Lane 是“角色 × 项目”，**独立任务必须主动使用不同 Lane**；同 Lane 会按 lease 排队。结果索引严格按父 Agent 授权。

## 5. DSH 相关生态：复用什么、避免误接什么

以下为仓库自述与源码入口核对，**不是本机安装或兼容性背书**。

| 项目 | 可参考/复用 | 对 OMC 的意义 | 限制 |
|---|---|---|---|
| [DSH 官方](https://github.com/deepseek-ai/deepseek-harness) | subagents、workingDirectory、Agent preset、Session、scope、权限 | OMC 继续做角色/策略层；生命周期以宿主为准 | 依版本核对公开接口 |
| [oh-my-dsh-slim](https://github.com/ninipa/oh-my-dsh-slim) | 原生角色、配置卡、宿主兼容策略 | 按单个修复合并，不另装重复角色 | 上游小版本不等于本地兼容 |
| [dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor) | 多 CLI headless 调度、Doctor | 用于 argv 发现与可诊断性比较 | 进程输出不是可续接 DSH 孩子 |
| [dsh-plugin-product-subagents](https://github.com/shaokeyibb/dsh-plugin-product-subagents) | durable/continuable 产品子代理、ACP、闲置回收 | 优先审计的 continuable 参考 | README 验证宿主仍到 0.1.5 |
| [SoftSpark dsh-codex](https://github.com/softspark/dsh-codex) | app-server、模型流/工具桥接、线程恢复 | 参考 app-server adapter | 是 LLM Provider 路线，不是 Agent Provider 替换件 |
| [dsh-market](https://github.com/dsh-market/dsh-market) | 索引来源、宿主版本筛选、安装 UI | 发布时提供准确 bundle/engines/client | 上架不等于登录/续接成功 |

## 6. 当前仍阻碍完整可用化的限制

> 哪一项是 DSH 宿主契约、为什么不能用 OMC 绕过、可用的替代方案，集中见 [DSH 契约边界](DSH-CONTRACT-LIMITS.zh-CN.md)。

### P0：仍缺

- **完整 Desktop 混合编排尚未复验。** rc.5 真装载 + Codex Provider 真两轮分开通过；尚未证明 UI 发起的 Oracle/Codex → Fixer/native → 混合 Council 全链条。验收步骤见 [Desktop 混合编排验收清单](DESKTOP-ACCEPTANCE.zh-CN.md)。
- **外部运行中实时 steer 仍不可用。** DSH 外部 Provider 只有 `start()`；mailbox 只是排队。需要 continuable ACP 后端。

### P1：仍缺

- **角色级模型失败分类与自动回退**：dispatch 已有显式 fallbacks；角色工具仍按注册时 harness。
- **项目级角色/Prompt/Skill/MCP 绑定与 native 自定义角色**：只有 dispatch 权限下限 + external read-only role 模板。
- **当前会话 preset 快照/热切换**：`preset snapshot/status` 已能记录并对比；真正的热切换仍被 DSH `agentPresets.select()` 首轮后锁定。
- **per-child worktree 与自动合并验收**：外部 dispatch 已有 per-task checkout；DSH session worktree 仍是 session-wide，native child 没有 per-child cwd。
- **统一 RoleResult 信封**：`subagent_result` 已返回 `roleId/state/complete/capturedThroughSeq/readAt`；`coharness result` 也生成 `roleResult`（taskId/roleId/surface/state/complete/error），但仍保留原始 `task`，且外部没有 provider/model/structured/artifacts。

### P2：扩展

Observer/图片附件、AST/LSP、Interview/Implement、压缩后的 Deepwork 恢复、Companion/分屏、自定义 agent 市场。

## 7. 建议分批交付和验收门槛

| 批次 | 交付物 | 通过条件 |
|---|---|---|
| A（上一批） | Lane 委派、最小交接、外部结果控制、续接策略 | 203 项回归；rc.5 装载；Codex 两轮 |
| A2 | `fleet` / `demo`、native 路由可见性、OMD 继承 | 14 项 fleet；217 pass；0 模型调用 |
| A3 | profile 分区、跨进程锁、持久结果/unknown、工作图、邮箱、CLI 分类 | 237 pass；两进程 lease；宿主 action |
| **A4（本批）** | Runtime 设置卡、逐 Lane 清除、dispatch/custom-role fallback、项目权限下限、dispatch worktree/merge（可要求 graph acceptance）、自定义外部角色模板（含项目 roles.json + model/fallbacks）、统一 RoleResult 投影、会话 preset 快照 | **268 pass / 27 文件**；client bundle 22 项；宿主装载 |
| B | 结构化 RoleResult 与生命周期 | 五态、重启 unknown、跨父会话拒绝 |
| C | 统一 continuable 外部 backend | 运行中追加、权限问答、取消、冷恢复 |
| D | 项目配置、自定义角色、当前会话预设 | 项目边界、切换不影响已运行孩子、重启快照 |
| E | per-child worktree 与阶段门禁 | 两个 worktree 独立写入、合并、冲突/取消产物 |
| F | SLIM 扩展/完整 OMO | 每个新增能力单列来源、许可证、宿主需求、真实验收 |

不要用“功能完成百分比”表达进展：以本表的可执行验收为发布门槛。

## 8. P0 / P1 完成状态审计（2026-11-02 晚）

| 项 | 状态 | 依据 / 仍缺什么 |
|---|---|---|
| P0-1 会话表跨进程锁 | ✅ | `integration/state.js` profile 分区；`file-lock.js` token/PID/心跳/崩溃接管；`sessions.js` 锁内重读 + dirty 合并；两进程实测 |
| P0-2 外部结果持久化 | ✅ | `tasks.js` 持久收据/结果体；重启可读；缺失返回 `unknown`；重启 cancel 不谎报 |
| P0-3 外部运行中 steer | 🟡 | durable mailbox 排队；原生 child 走 `send_message`；外部 child 下次 `reuse/inbox` 带入；不是进程内实时 steer |
| P0-4 Desktop 混合编排复验 | ❌ | 隔离宿主已通过；真实 Desktop UI 全链路仍未执行 |
| P1-1 工作图/依赖/验收/写互斥 | ✅ | `graph.js` plan/claim/complete/audit；依赖、evidence、write claim、write scope 运行时检查 |
| P1-2 设置卡/逐 Lane/usage | ✅ | Runtime tab；`/coharness sessions --clear --lane=<id>`；usage/lane 聚合；provider 结果与 registry stats 带 `new/resumed/unconfirmed/unknown` 计数；浏览器点击未验收 |
| P1-3 模型失败分类与回退 | 🟡 | CLI 分类 + dispatch 显式 fallbacks + `maxParallelExternal`；角色工具无模型级自动回退 |
| P1-4 CLI 结果分类 | ✅ | `cli-result.js` 统一 auth/quota/rate/context/truncated/semantic/empty/id-changed/unconfirmed；exit 0 不再自动完成 |
| P1-5 项目配置/自定义角色/绑定 | 🟡 | `.omc/project.json` 只能收紧 dispatch/harness/routing；`coharness role` 用户级模板 + `.omc/roles.json` 项目级 external read-only 模板；仍无项目级角色模型/Prompt/Skill/MCP 绑定、无 native 自定义角色 |
| P1-6 当前会话 preset | 🟡 | `coharness preset snapshot/status` 记录本会话实际生效的 OMC 角色配置，并对比当前全局配置（`hotSwitch:false`）；DSH 首轮后 `agent-preset/locked`，仍不能热切换 |
| P1-7 worktree/合并验收 | 🟡 | `dispatch mode:"worktree"` 为每个外部任务创建 disposable branch checkout，CLI 在 checkout 内写，返回 branch/path/files/diff；`coharness worktree` 可创建/进入 session worktree 并显式 merge（clean 预检、--no-ff、diff check、冲突 abort）。native child 仍无 per-child cwd |

**测试基线：268 pass / 0 fail（27 个测试文件）**；另有隔离宿主 `graph` / `mailbox` / `fleet` / `role` / `preset` action、两进程 lease 验收。仍不能把 P0-4、完整的 P1-5 / P1-6 / P1-7 宣称为完成。

**剩余工作的真实顺序**：P0-4 需要在真实 Desktop 手工验收；P1-6 依赖 DSH 会话内 preset；完整 P1-5 要重做预设装载；P1-7 依赖 DSH per-child worktree 或 OMC 自建隔离调度器；P0-3 实时 steer 依赖 continuable ACP 后端。
