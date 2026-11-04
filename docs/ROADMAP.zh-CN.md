# Oh My CoHarness（OMC）0.X → 1.X → 2.X 完整发展路线

> **总体定位**：从多模型协作插件，发展为跨 Harness 智能体操作层，最终形成可长期运行、可验证改进的 RSI-Agent 系统。
> 状态：**产品路线文档**（方向与排期），不是验收证据，也不构成本仓库当前能力的声明。
> 固定于 2026-11-03，起点版本 `0.5.0-alpha.2-practice.5`。文中 `0.6`–`0.9`、`1.0`–`1.9`、`2.0`–`2.9` 均为**建议排期**，不代表已发布版本。
>
> **2026-11-03 修订**：0.X 重定位为 **Internal Foundation**（内部技术验证，不发布 npm）；npm 首次公开发布转移到 **1.X Coharness Core GA**。0.9 由"1.0 发布候选"改为"内部架构冻结"。0.X 的实施与验收入口见 [OMC-0X-CLOSEOUT.md](OMC-0X-CLOSEOUT.md)，本文只保留方向。

---

## 0. 三个时代与三个问题

它们不是三个独立产品，而是同一个 OMC 架构逐级获得三种能力：

| 时代 | 名称 | 要解决的问题 | 发布 |
|---|---|---|---|
| 0.X | **Internal Foundation**（Multi-Model Orchestration） | 让不同模型协同工作；以 DSH 为宿主，整合 OMO-Slim 的角色、路由、委派与多模型工作流 | **内部验证，不发布 npm** |
| 1.X | **Product Differentiation**（Cross-Harness Agent Collaboration） | 让不同 Harness 中的 Agent 真正协作；统一 Agent 协议、双向通信、执行生命周期、持久会话与跨 Harness 任务交接 | **核心能力验收后首次 npm 发布** |
| 2.X | **Persistent Intelligence**（Persistent RSI-Agent） | 让协作系统持续完成任务并逐步改进；借鉴 Superagent，引入长期 Workstream、授权账本、持续运行、反馈评估与受控自我改进 | 渐进式自主改进 |

其逻辑可以浓缩为三个问题：

| 时代 | 核心问题 | 最终交付 |
|---|---|---|
| 0.X | Who should do it? | 多模型智能路由与协作 |
| 1.X | How do agents work together? | 跨 Harness Agent 协议与执行平台 |
| 2.X | How can the system work and improve over time? | 长期持久化 RSI-Agent |

**RSI（Recursive Self-Improvement，递归自我改进）需要准确界定。** OMC 2.X 的合理目标应当是：通过历史任务、可重复 Benchmark、策略候选、独立评估和受控发布，使系统逐步改善**路由与协作方式**；而不是一开始就允许 Agent 无限制地修改自身代码和权限。这一定义保持 OMC 的工程可实现性，也使每一代升级具备可以检验的进步。

---

## 1. 现有 OMC 的实际发展起点

截至本次查看，仓库主分支标注版本为 `0.5.0-alpha.2-practice.5`。README 记录 R00–R04、R06–R07 已完成，R05 代码与设置卡已完成但仍缺 Desktop 点击验收，R08–R10 以及 Alpha 发布闸门尚未完成。

这意味着 0.X 已经具备相当多的功能基础，但**尚未达到可以宣布 0.X 时代完成的程度**。

当前已有的关键积累：合并 OMD-Slim 的角色 Preset、DSH Native / 外部 CLI 路由、工作包、原生会话复用、任务 Graph、邮箱、用量账本、预算闸门和初步的验收组件。**新路线应复用这些能力，而不是为 1.X / 2.X 再建一套。**

---

## 2. 0.X 时代：DSH 原生多模型编排的成熟化

**目标产品：OMO-Slim+ for DSH**

0.X 的核心任务是让用户在 DSH 中获得一套稳定、易配置、低成本的专业 Agent 团队，能充分利用各模型各自的能力。

这一阶段不需要追求"所有 Harness 都变成独立自治 Agent"。外部 CLI 能可靠接收任务、续接已支持的会话、返回结果，就已经能满足大部分需求。

### 2.1 里程碑

| 版本 | 核心目标 | 主要交付 | npm |
|---|---|---|---|
| 0.5.x 当前 | OMO-Slim 功能集成 | 单一 Preset、角色路由、Native/CLI、Lane、Graph、Session | 不发布 |
| 0.6 | Correctness（稳定性与正确性） | 可信父子身份、任务账本、统一验收、崩溃恢复、Writer 闸门 | 不发布 |
| 0.7 | Collaboration（多模型协作完善） | 模型能力检测、默认角色配置、路由回退、Council、多模型实测 | 不发布 |
| 0.8 | Benchmark（工作流与性能优化） | 上下文交接、会话复用策略、三策略 Benchmark、预算与进展诊断 | 不发布 |
| 0.9 | **Foundation Freeze（内部架构冻结）** | 配置迁移、跨平台验收、真实 Harness 测试、文档与兼容性冻结 | 不发布 |

> 0.9 不再是"1.0 发布候选"。首次 npm 公开发布移到 **1.X Coharness Core GA**，门槛见 [OMC-0X-CLOSEOUT.md §9](OMC-0X-CLOSEOUT.md)。

### 2.2 应冻结的四组核心能力

- **角色系统（Roles）**：保留 Orchestrator、Fixer、Designer、Explorer、Oracle、Librarian、Council。角色表达能力需求，不绑定某个模型或 Harness。
- **执行路由（Execution Routing）**：DSH Native 优先复用官方子 Agent；外部 CLI 走受支持的官方调用接口。模型、权限、可用性、上下文长度和价格信息都应参与路由判定。
- **协作工作流（Workflow）**：可靠完成 Explorer → Oracle → Fixer → Verify、Designer → Fixer，以及 Council 并行评审等常见流程。Graph 负责依赖和验收，不重复实现 DSH 的执行生命周期。
- **正确性与可观测性（Reliability）**：任务能够停止、查询、恢复、计费、验收；拒绝伪造证据；准确显示实际执行模型；不把 CLI 启动误判为任务完成。

**0.X 的功能边界是可靠的多模型任务编排，而非完全的跨 Harness 实时通信。** 这正好给 1.X 留出明确的创新空间。

### 2.3 完成门槛

达到以下条件，才能把 OMO-Slim 集成时代视为真正完成：

- 核心角色与工作流达到约定的 OMO-Slim 功能对等，并通过差异矩阵验收。
- DSH 原生和至少两种有代表性的外部 CLI 完成真实模型端到端测试。
- 父子任务归属、费用记录、取消、重启、验收、写入冲突等正确性测试通过。
- 用同一任务集评估不同模型组合和会话策略，而不是预设 OMC 一定比 OMO-Slim 快。
- 设置卡、安装和升级迁移在实际 Desktop 环境完成验收。

现有 R08（真实实验）归入 **0.8 内部 Benchmark 验证**，R09（发布验收）归入 **0.9 内部架构冻结验收**，**均不推迟到 1.X，也不再以 npm 发布为目标**。

---

## 3. 1.X 时代：Coharness——真正的跨 Harness Agent 协作

**核心研发重点：Harness-Agentization**

1.X 才是 OMC 在技术上最有可能形成独立竞争力的阶段。

0.X 的外部 CLI 本质上仍主要是一个可调用的执行端；即使支持原生 Session Resume，它也不必具备真正的 Agent 通信语义。1.X 要解决的问题是：

> 如何让 Codex、Claude Code、Gemini CLI、DSH 等不同 Harness 内运行的 Agent，被 OMC 作为**可寻址、可续接、可协作、可监管**的执行参与者来管理？

这要求从现在的 `Role → Provider → Result` 升级为 `Role → Agent Instance → Message / Task / Artifact → Result`。

### 3.1 Coharness Agent Contract

不建议一开始创造庞大的全新协议，而应先统一最小能力接口：

| 原语 | 功能 | 能力要求 |
|---|---|---|
| discover | 查找 Harness 与 Agent 能力 | 必须 |
| start | 创建一次执行或 Agent 会话 | 必须 |
| status | 查询真实执行状态 | 必须 |
| result | 获取最终结果与产物 | 必须 |
| interrupt | 请求取消执行 | 按后端能力 |
| resume | 继续既有会话 | 可选 |
| message | 向进行中的 Agent 发送消息 | 可选 |
| events | 获取进度与生命周期事件 | 可选 |
| artifacts | 获取结构化产物 | 必须提供统一表示 |

这里必须采用**能力协商**而非虚假的功能对等：某个 CLI 只能通过再次调用恢复 Session，就不能把它包装成支持实时双向消息的常驻 Agent。

DSH 官方的 Subagent API 已经统一了本地与外部执行的启动、所有权和完成通知；但 Codex、Claude Code 等外部执行 Provider 不一定支持持续会话内消息。这正是 Coharness Adapter 需要显式表达的差异。

### 3.2 采用 A2A 思路，但不强制全面实现 A2A

可以参考 Agent2Agent（A2A）协议对 Agent 能力发现、Task、Message、Artifact 和异步状态的定义。A2A 规范明确区分 Message 与 Artifact，也强调异构 Agent 无须暴露内部状态即可协作。

OMC 1.X 的协议策略建议为：

- **内部**：轻量 Coharness Agent Contract，保证本地 CLI 接入效率。
- **DSH**：使用原生 Subagent、Session、Event 等宿主 API。
- **MCP**：继续作为工具与能力的接入边界，而非假定 MCP 本身提供完整 Agent 生命周期。
- **A2A**：后续通过适配层导入或导出跨框架 Agent，避免早期增加服务部署负担。

### 3.3 1.X 运行拓扑

```
                    DSH Host / OMC UI
            唯一用户入口 · Role Preset · Orchestrator
                              │
                   Coharness Control Plane
        Role & Route │ Agent Registry │ Task & Mailbox │ Session & Ledger
                              │
                  Agent Contract / Adapter Layer
        能力发现 · 消息映射 · 取消 · 结果 · 恢复
                              │
   ┌──────────┬───────────┬──────────┬──────────┬───────────┐
 DSH       Codex       Claude     Gemini     Kimi/GLM    Other
 Native    Adapter     Adapter    Adapter    Adapter     Future
```

这是**目标架构**，并不代表各外部 Harness 已支持相同通信或持久化能力。

值得保留的设计原则：**OMC 统一任务与通信语义，具体 Harness 继续负责自己的模型调用、工具执行和内部 Agent Loop。** 不必为每种 CLI 重新实现一个完整 Harness，更不需要让外部 Agent 自己再启动一个 DSH Runtime。

### 3.4 后台 Harness-Agent 化的四项关键技术

最重要的不是增加多少模型，而是这四项工程能力：

1. **身份与会话分离。** 同一个逻辑 Agent 可以多次启动不同的物理会话，通过 `workerKey`、`generation`、`sessionId` 与 `attemptId` 保证任务连续性。现有 `integration/worker-registry.js` 正好是起点。
2. **可靠消息交付。** 统一 `queued → delivered → consumed` 等状态，并对消息设置唯一 ID、幂等消费和过期处理。对于只支持 Resume 的 CLI，消息在下一次合法续派时注入，而不是假称实时投递。**OMC 不需要另建点对点聊天总线。**
3. **Agent 之间的任务委派。** 允许专业 Agent 请求其他角色协助，但必须经 OMC 校验其父任务、权限、预算及深度。跨 Harness 通信不能让子 Agent 自动获得扩大授权的权力。
4. **执行与产物归属。** 不同 Harness 的结果统一映射到 WorkPacket、Artifact、Evidence 和 Graph，**禁止因 CLI 结束就自动认定任务验收成功**。

### 3.5 里程碑

| 版本 | 交付重点 |
|---|---|
| 1.0 | Coharness Agent Contract v1：身份、能力、Task、Message、Artifact |
| 1.1 | Codex、Claude Code 等代表性 Harness Adapter 的真实接入验证 |
| 1.2 | 跨 Harness 消息、Session Resume、异步任务状态和回执 |
| 1.3 | 跨 Harness 子 Agent 委派、统一权限与调用预算 |
| 1.4 | 崩溃恢复、消息去重、版本兼容、可观测性 |
| 1.5–1.9 | 协议稳定化、扩充 Adapter、独立协作 Benchmark |

**1.X 的毕业测试**应当是一项由多种 Harness 共同完成的真实任务：例如 DSH Owner 将系统设计交给 Claude Agent、将代码分析交给 Codex Agent，再由受控 Fixer 实现修改，最后完成独立验收。过程中要验证消息、身份、会话复用、取消、失败恢复以及预算归属。只有这种闭环通过，才能宣称 Harness 已被真正 Agent 化，而不仅仅是包装成命令行工具。

---

## 4. 2.X 时代：Superagent 驱动的长期持久化 RSI-Agent

**核心研发方向：Persistent Intelligence**

如果 1.X 解决了 Agent 之间如何协作，那么 2.X 要解决的是：

> 当用户离开之后，Agent 团队如何在已授权的范围内持续推进任务，并且从长期执行历史中学习如何做得更好？

2.X 拆成两项独立能力，逐步完成：

- **Persistent Agent**：具备长期任务责任、持久状态、事件触发、暂停恢复和独立验收。
- **RSI Controller**：根据真实任务反馈提出协作策略改进，通过 Benchmark 验证、灰度和回滚实现受控优化。

它们有依赖关系，但不必在 2.0 同时完成。

### 4.1 持久化的对象不是模型上下文，而是任务责任

需要避免一个常见误区：**长期 Agent 并不意味着让同一个 LLM Session 无限延续。** LLM 上下文始终有限，模型版本、工具和运行环境也会变化。长期保持的应该是稳定的项目责任与可信记录，而不是永不清空的对话。

```
Project Owner · L0
  项目目标 · 授权 · 全局策略 · 最终验收
   │
   ├── Workstream A ── Lead Agent（可续接 / 可轮换）── Specialist Agents
   └── Workstream B ── Lead Agent（可续接 / 可轮换）── Specialist Agents

Persistent Ledger + Evaluation
  Mandate · Ticket · Assignment · Evidence · Lessons
```

这里保留 L0/L1/L2 三层，但**第三层是否值得作为默认模式，仍应由 1.X 的真实协作 Benchmark 决定**。如果一个项目只有一个任务，L0 完全可以直接调用 Specialist；只有持续接收相关需求的复杂模块才需要常驻的逻辑 Lead。这能避免 2.X 变成"无论任务大小都强制启动三个层级"的高成本框架。

### 4.2 引入 Superagent 的长期任务生命周期

DeepSeek Superagent 原型将授权工作单元 **Ticket**、执行实例 **Assignment** 与 **Mandate** 分开，同时维护人工介入和恢复逻辑。OMC 应吸收这一原则，而不直接复制完整 Superagent 引擎。

推荐的长期运行流程：

```
Requirement / Trigger        用户需求、已订阅事件或合法定时检查
        │
Policy Gate + Mandate        确认是否授权、范围和执行预算
        │
Ticket → Workstream → Assignment   任务归属、Lead 选择、Harness 派发
        │
Execution + Checkpoint       执行、记录、等待、停止与崩溃恢复
        │
Independent Acceptance       产物、测试、证据、人工审批
        │
Feedback → Strategy Evaluation     为后续 RSI 提供可复核的学习样本
```

这套流程允许某个 Ticket 在等待人工答复、CI 或外部依赖时挂起，也允许 Agent Session 被替换后继续承担原来的工作责任。

**2.X 默认仍以 observe 模式启动，自动执行必须具备明确的授权范围。** 新发现的潜在需求不能仅因 Agent 自己认为有价值就立即开始写入代码。

### 4.3 RSI 的真正实现：让协作策略进化，而不是让模型随意改代码

现有 [FEEDBACK-EVOLUTION](FEEDBACK-EVOLUTION.zh-CN.md) 方案已具备 RSI 研究的早期基础：会话策略对照、执行轨迹收集、独立评分和候选策略评估。自我改进建议分为四级：

| 等级 | 改进对象 | 自动化程度 |
|---|---|---|
| RSI-L0 | 收集失败原因、任务经验、历史轨迹 | 自动记录 |
| RSI-L1 | 推荐模型路由、会话策略与任务拆分方式 | 自动提出建议 |
| RSI-L2 | 生成候选配置，进行隔离 Benchmark | 可在预算内自动实验 |
| RSI-L3 | 晋升已验证策略，灰度、监控并回滚 | 经明确授权后自动化 |

例如，OMC 发现某类 TypeScript 修复任务，在相同模型和相近环境下，`fresh_handoff` 比 `resume` 的验收表现更稳定。正确的 RSI 流程不是立即全局切换策略，而是：

1. 从历史任务中提出一个**可检验的假设**。
2. 在**独立测试集**上比较旧策略和候选策略。
3. 同时评估成功率、成本、耗时和人工介入量。
4. 对候选策略进行**小范围灰度**。
5. 达到预先设定的晋升标准才启用，出现退化立即回退。

最初应只允许系统优化**提示词、模型选择、路由规则、工作包粒度与会话策略**。修改 OMC 自身运行时代码、授权检查、验收器、沙箱配置或评测标准则应作为更高风险的独立软件开发任务处理，需要外部审批和独立验证——**不能由同一个优化器自行修改、自行评分、自行上线**。

这样才能把 RSI 从抽象概念变成真正可研究、可复现的工程系统。

### 4.4 里程碑

| 版本 | 核心目标 | 主要交付 |
|---|---|---|
| 2.0 | Superagent 基础 | Mandate、Ticket、Assignment、Policy、审计与生命周期 |
| 2.1 | 长期 Workstream | L0/L1/L2 可选分层、模块负责人、会话轮换 |
| 2.2 | 持续运行 | 事件触发、恢复、检查点、人工介入、长期任务管理 |
| 2.3 | Feedback Engine | 完整轨迹、失败归因、独立 Benchmark、经验记忆 |
| 2.4 | RSI Controller | 候选生成、策略对照、受控灰度与自动回滚 |
| 2.5–2.9 | 系统成熟化 | 长期稳定性验证、跨项目迁移、能力评估和正式发布 |

其中 2.0 的核心工作已有一部分需要在 0.X 和 1.X 预先完成：**可信 lineage、统一验收出口、执行账本与预算闸门都是基础正确性能力，不应等到 2.0 才修复。** 2.0 要新增的是长期授权与工作责任的完整业务语义，而不是重新开发一套 Task、Session 和 Graph。

---

## 5. 三个时代共用的技术内核

为避免版本越大、系统越臃肿，从现在起固定一个跨版本的架构边界：

| 基础组件 | 0.X | 1.X | 2.X |
|---|---|---|---|
| DSH Runtime | 复用 | 继续复用 | 继续复用 |
| Role & Model Router | 完善 | 能力驱动路由 | 受控策略优化 |
| Coharness Adapters | CLI 调用 | Agent 化通信 | 长期可恢复执行 |
| Graph / Task Ledger | 工作流记录 | 跨 Harness 归集 | Ticket 责任管理 |
| Mailbox / WorkPacket | 任务交接 | 可靠异步消息 | 长期上下文传递 |
| Authorization | 基础执行约束 | 跨 Harness 授权 | Mandate 和 Policy |
| Acceptance | 独立验证 | 跨 Harness 统一 | 长期质量保障 |
| Feedback / Benchmark | 离线对照 | 协作效率分析 | RSI 策略进化 |
| UI | 角色与执行状态 | Agent 网络与消息 | 项目、责任和改进监控 |

特别需要明确的三条边界：

- **0.X 不引入第二套 Runtime。**
- **1.X 不引入第二套独立任务账本。**
- **2.X 不引入第二套并行的授权与调度系统。**

需要增加的是**能力和规则**，而不是反复替换基础设施。

同时建议从 0.X 就保持统一的身份模型：

```
projectId → ticketId → assignmentId → attemptId → sessionId
```

早期并不需要真正创建全部实体，但任务记录至少应预留稳定的关联能力。到 2.X 时，再把 Requirement、Mandate 和 Ticket 的长期业务语义完整接上。

> **与已冻结决策的关系**：[ARCHITECTURE §10](ARCHITECTURE.zh-CN.md) 目前把"第二套 Runtime／任务数据库／消息总线／自研 worktree 调度器"列为非目标（并注明"非永久拒绝"）。本路线中的 1.X Control Plane 与 2.X Ledger 只能作为**既有组件的扩展**落地；要越过 §10，必须是一次**显式决策**并留存理由，不能靠改名规避。

---

## 6. 贯穿三个时代的研发与验收体系

建议持续维护三类 Benchmark，而不是每次升级只跑单元测试：

| 时代 | Benchmark | 主要指标 |
|---|---|---|
| 0.X | Model Collaboration Benchmark | 对同一类任务比较单 Agent、OMO-Slim 风格协作和 OMC 协作：最终验收率、端到端耗时、Token/CLI 用量、配置可靠性 |
| 1.X | Cross-Harness Collaboration Benchmark | 跨 Harness 消息交付、任务接管、恢复、取消、重复消费、多 Agent 整合失败率；必须用**故障注入**验证可靠性，而不只测正常场景 |
| 2.X | Long-Horizon RSI Benchmark | 连续多轮需求与多次宿主重启下的任务完成质量、人工干预次数、授权违规、恢复能力，以及新策略在**留出任务**上的实际提升 |

每个大版本都应保留前一个版本的 Benchmark 作为回归测试。2.X 即使获得更强的长期自主能力，也不能以牺牲 0.X 的低延迟单任务体验和 1.X 的跨 Harness 可靠性为代价。

**RSI 的提升必须相对于冻结基线比较。** 成功率提高但成本翻倍、验收标准被修改，或只在同一批反复使用的任务上提高，都不能算作有说服力的进步。

---

## 7. 实际开发顺序

以当前 `0.5.0-alpha.2-practice.5` 为起点：

| 阶段 | 内容 |
|---|---|
| **近期** | 完成 0.X 的可信执行基础：优先修复统一验收、Graph 跨进程 Writer 控制、外部执行 intent/launching 账本、unknown 恢复问题。随后完成已有 R08、R09 的**内部**真实实验与架构冻结验收（均不发布 npm） |
| **随后** | 定义 1.X Coharness Agent Contract：先写接口规范和能力矩阵，再用两种不同能力的真实 Harness 做通信原型。证明身份、消息、任务和产物能够跨 Harness 可靠传递后，再扩大支持范围 |
| **中期** | 完成跨 Harness 多 Agent 闭环：在真实项目中测试多轮任务、异步协作、失败恢复和独立验收，冻结稳定协议，再开始 2.X 的长期责任模型 |
| **远期** | 逐级开放 Persistent Agent 与 RSI：先实现授权的长期运行，再引入反馈学习、候选策略和灰度晋升。三层 Workstream 只在实测证明有收益的任务类型中启用 |

建议将 **OMC 自身作为 2.X 的第一个长期维护实验项目**：它有可重复运行的测试、明确的模块边界，以及真实的需求和发布历史，能够形成比较清晰的自我改进评价闭环。等 OMC 在维护自身时证明了可靠性，再把同一套系统用于 ACP 后端、RPH-Workbench 等更复杂的项目，减少领域特定问题对 OMC 内核评价的干扰。

---

## 8. 最终产品定位

> **Oh My CoHarness is a persistent, multi-harness agent orchestration system that coordinates specialized agents, manages long-running work, and improves its collaboration strategies through verifiable feedback.**
>
> OMC 是一个跨 Harness 的持久化智能体编排系统，通过多模型专业协作、长期任务管理和可验证的反馈优化，实现复杂工作的持续执行与渐进式自我改进。

三个时代的产品目标可以简洁概括为：

| 0.X | 1.X | 2.X |
|---|---|---|
| **Collaborate**<br>模型协同 | **Connect**<br>Harness 互联 | **Evolve**<br>持续改进 |

这条路线最大的优势是渐进性：0.X 本身就是可以发布的实用工具，1.X 在其基础上建立真正的跨 Harness 协作能力，2.X 再利用长期运行产生的真实证据，实现有边界、可验证的 RSI。这样即使 2.X 的 RSI 研究进度不及预期，0.X 和 1.X 仍然是独立成立的产品，而不是为了遥远的自主智能目标堆叠基础设施。

---

## 9. 与本仓库其他文档的对应关系

| 本路线 | 既有文档 / 代码 |
|---|---|
| **0.X 收官实施与验收入口** | [OMC-0X-CLOSEOUT.md](OMC-0X-CLOSEOUT.md)（0.6–0.9 目标、PR-01～PR-09、五项冻结验收、npm 首发门槛） |
| 0.6 稳定性与正确性 | [STABILIZATION.zh-CN.md](STABILIZATION.zh-CN.md)（PR-01～PR-04、§7 验收矩阵） |
| 0.5–0.9 的剩余接线 | [NEXT-PRACTICE.zh-CN.md](NEXT-PRACTICE.zh-CN.md)（R00–R10）、[R02–R10 执行方案](plans/r02-r10.execution-plan.zh-CN.md) |
| 0.X 的执行路由与角色 | [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)、[ROLE-ROUTING.zh-CN.md](ROLE-ROUTING.zh-CN.md) |
| 1.X 的契约与能力矩阵 | [ADAPTER.zh-CN.md](ADAPTER.zh-CN.md)、[DSH-CONTRACT-LIMITS.zh-CN.md](DSH-CONTRACT-LIMITS.zh-CN.md)、`integration/worker-registry.js`、`integration/mailbox.js` |
| 2.X 的 L0/L1/L2 与授权账本 | [SUPERAGENT-LAYERING.zh-CN.md](SUPERAGENT-LAYERING.zh-CN.md)（三层结构、Mandate、统一验收出口、G-1 收益对照门） |
| 2.X 的 RSI 与 Benchmark | [FEEDBACK-EVOLUTION.zh-CN.md](FEEDBACK-EVOLUTION.zh-CN.md)、`scripts/strategy-eval.mjs`、`test/benchmarks/` |
| 2.X 的长期编排语义 | [DURABLE-ORCHESTRATION.zh-CN.md](DURABLE-ORCHESTRATION.zh-CN.md)（工作图、邮箱、持久结果） |

**读法**：本文只给方向与排期。任何"已完成"的判定以对应验收文档与证据文件为准；本文不替代它们。
