# OMC 0.X 收官方案：完成技术内核，暂缓 npm 发布，集中进入 1.X

> 状态：**路线决策 + 收官验收标准**。本文是 0.X 剩余工作的唯一实施与验收入口。
> 固定于 2026-11-03，基线版本 `0.5.0-alpha.2-practice.5`。本文中的版本号（0.6–0.9）均为**内部排期**，不代表已发布；npm 发布转移到 1.X。
> 上位路线见 [ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)；本文替代其中"0.9 = 1.0 发布候选"的旧表述。
>
> **执行状态（2026-11-04）**：0.6 与 0.8 已完成；0.7 与 0.9 为部分完成，**0.X 尚未冻结**。离线回归 56/56 套件通过，[最终 CI](https://github.com/PengYangchao0808/oh-my-coharness/actions/runs/41871037131) 全绿，真实 Pilot 为 **25 executed / 24 passed / 1 real model failure**（[汇总](evidence/v0.8/pilot-final-summary.json)）。External Mixed、managed Council 的真实模型验收因用户决定停止模型调用而未执行；Desktop 点击没有自动化证据。

---

## 0. 本次决策

| 决策 | 内容 |
|---|---|
| **0.X 的目标** | 形成**稳定、可测、可扩展的 DSH 多模型协作内核**，不再以"完成 OMO-Slim 全功能复刻并发布产品"为目标 |
| **0.X 的责任** | 只承担**技术验证责任**，不再承担公开产品功能完整性的责任 |
| **npm 首发时机** | 移到 **1.X Coharness Core GA**（§9）。0.X 全程不发布 npm 包 |
| **0.9 的性质** | **内部架构冻结**，不是 Release Candidate |
| **打包工具** | 保留 `npm pack` / `pack-check` / 隔离安装测试；`package.json` 加 `"private": true` 防误发 |
| **差异化归属** | "OMC 与 OMD 的差异"是 **1.X 的产品问题**，0.X 不需要为此堆功能 |
| **R 系列的归属** | R08 归 0.8（内部验证），R09 归 0.9（内部验收），R10 移出 0.X 归 2.X |

一句话：**0.X 的成功标准不是比 OMD 功能更多，而是让 1.X 不再需要重写底层架构。**

---

## 1. OMC 与 OMD 的差异在哪一代兑现

如果 OMC 只做到角色分工、模型路由、Council 和子 Agent 委派，那么它与 OMD 的主要区别确实只是增加了外部 CLI 接入与一些任务管理能力——这不足以支撑长期差异化。差异要按代划分：

| 维度 | OMD-Slim | OMC 0.X | OMC 1.X 目标 |
|---|---|---|---|
| DSH 原生角色协作 | 核心能力 | 继承并完善 | 保留 |
| 多模型配置与路由 | 支持 | Native + 外部 CLI | 跨 Harness 能力驱动 |
| 专业 Agent 委派 | 支持 | 统一工作包与结果 | 跨 Harness Agent 委派 |
| 外部 Harness | 非核心能力 | 启动、结果、部分 Resume | 独立 Agent 实例 |
| Agent 间通信 | DSH 原生范围 | 外部以异步交接为主 | 跨 Harness 消息协议 |
| 持久身份与状态 | 宿主会话为主 | Task、Session、Attempt | 统一 Agent Registry |
| 独立验收与审计 | 有相关机制 | 建立一致的执行契约 | 全 Harness 统一 |
| 长期运行与改进 | 非核心定位 | 保留基础能力 | 为 2.X 铺路 |

三个时代由此重新定位：

| 时代 | 名称 | 交付 | 发布 |
|---|---|---|---|
| 0.X | **Internal Foundation**（集成、修复、验证） | 一个可靠的多模型协作内核 | **内部开发与验收，不面向 npm 正式发布** |
| 1.X | **Product Differentiation**（连接、通信、协同） | 真正的 Coharness Agent System | **核心能力验收后首次公开发布** |
| 2.X | **Persistent Intelligence**（持续运行、反馈、进化） | 长期持久化 RSI-Agent | 借鉴 Superagent，逐步实现有授权、可验证的自主改进 |

---

## 2. 0.X 版本规划

| 版本 | 开发定位 | 必须交付 | npm 发布 |
|---|---|---|---|
| **0.6** | Correctness | 身份、验收、账本、恢复、Writer 控制 | 不发布 |
| **0.7** | Collaboration | 真实多模型协作、路由、工作流和会话 | 不发布 |
| **0.8** | Benchmark | 真实任务、效率实验、回归与性能基线 | 不发布 |
| **0.9** | Foundation Freeze | 架构清理、契约冻结、完整集成验收 | 不发布 |
| **1.X** | Coharness Agentization | 跨 Harness Agent 协议和通信闭环 | 核心功能完成并验收后**首发** |

原来安排在 0.9 的"正式发布准备"，现在改成 1.X 开发前的**内部架构冻结**。仍然需要执行打包和安装测试（它能发现真实依赖、资源打包、配置迁移等错误），但不需要公开 npm 发布、市场宣传、完整用户文档或覆盖所有潜在 Harness。

---

## 3. v0.6：完成所有 P0 正确性修复

**目标：把当前已有功能从"能运行"升级成"可靠运行"。这是整个 0.X 最不能省略的阶段。**

### 3.1 必做任务

| 编号 | 任务 | 核心修改 | 验收 |
|---|---|---|---|
| C01 | 可信身份 | `native-runtime.js`、`tasks.js`、`graph.js` | Root / Child / Attempt 关系不混乱 |
| C02 | 统一验收 | `acceptance-runner.js`、所有 settle 入口 | 不接受执行者自报通过 |
| C03 | 执行账本 | `provider.js`、`execution-events.js` | CLI 启动前记录执行意图 |
| C04 | 崩溃恢复 | `managed-execution.js`、`request-gate.js` | Unknown 不被错误结算或重试 |
| C05 | Writer 管理 | `graph.js`、`file-lock.js` | 跨 Graph、跨进程单 Writer |
| C06 | 统一执行约束 | `dispatch.js`、Provider、Role 工具 | 最终权限和预算不能被绕过 |

### 3.2 三个特别注意的问题

1. **验收 Runner 必须真正接入运行路径。** 代码核查已确认：`src/index.js:916-923` 的 `graph.complete`、`integration/native-managed.js:120` 的 `settle`、`integration/managed-execution.js` 的 settle 都可能通过**调用方提交的证据**完成节点，而 `integration/acceptance-runner.js` 全仓零 importer。这是 **P0**，不能等到 2.X 的 Superagent 开发再处理。三个入口必须收敛到同一个 verdict 函数，且 `baseline()`（`acceptance-runner.js:459`）要在**派发之前**冻结。
2. **执行状态必须可以恢复。** 采用 `intent → launching → running → ended / unknown`。执行启动后如果崩溃且无法确认是否仍在运行，进入 `unknown`，等待核对后再决定恢复或重新执行——**未知不等于失败，更不等于可以重放**。当前 `src/provider.js:249-251` 启动 CLI 先于 `:265` 的 `tasks.start`，这个顺序要反过来。
3. **Writer 控制必须具有全局性。** 不能仅在单张 Graph 内检查写冲突（`graph.js:278-286` 目前只比较同一张图的运行中节点）。至少需要**项目级跨进程 Writer Lease**。0.6 不必实现多 Writer 并行和自动 Git 合并，默认单 Writer 就足够。

### 3.3 0.6 不做什么

不新增 Lead 角色，不引入 Mandate/Ticket，不做 Agent Teams 集成，不开发新的消息总线，不实现新 Harness。

**0.6 退出条件**：所有 P0 正确性测试、Host 探针及故障注入全部通过。

---

## 4. v0.7：完成真正可用的多模型协作

**目标：保证日常 Coding 可以稳定使用 OMC，但不追求复制 OMD 的全部边缘功能。** 收敛成四个工作包。

### 0.7-A 角色和模型路由

保留现有 Orchestrator、Explorer、Oracle、Fixer、Designer、Librarian 和 Council。完善 DSH Native 模型目录选择、外部 Harness 连接状态、真实执行模型显示、失败分类及显式回退策略。默认仍是 **Safe Native**，只有认证、能力和计费条件满足时才启用外部 Harness 路由。**不要再建立另一套 Provider 系统。**

### 0.7-B 多 Agent 工作流

必须跑通三个核心案例：

| 场景 | 链路 |
|---|---|
| 场景一：DSH Native 代码定位、修复与独立验收 | Explorer → Fixer → Verify |
| 场景二：跨模型方案评审、原生实施与验收 | External Oracle → Native Fixer → Verify |
| 场景三：多模型独立评审与可信汇总 | Council Seats → Synthesizer → Decision |

三个场景中，任务和结果必须统一进入 Graph、WorkPacket、Execution Ledger 与 Acceptance。外部 CLI 目前只需要具备**可靠的启动、结果、部分会话续接及错误处理**，不要求实时双向通信。

### 0.7-C 会话与上下文管理

复用现有 `worker-registry.js`、`sessions.js`、`session-strategy.js` 和 Mailbox。完善 Resume、Restart、Queue、工作包注入及消息消费确认。**尤其需要验证：旧任务结束后继续执行的新 Attempt，不会自动继承已经过期的验收结果或错误上下文。**

### 0.7-D 简化前端体验

既然暂时不公开发布，就没必要重做一个复杂 UI。保留现有 DSH 设置卡，完成角色模型选择、外部 CLI 连接状态、Runtime 状态、真实用量和错误提示即可。视觉系统、复杂的 Agent 管理面板、独立 Dashboard 等统一推迟。

**0.7 退出条件**：至少一条 Native 协作链、一条 Mixed 协作链和一个 Council 案例通过真实模型与 Desktop 验收。

---

## 5. v0.8：低成本 Benchmark 与架构决策验证

这一阶段应尽量利用已有的 R06/R07 实现，而不是建立新项目。

### 5.1 测试集（4 + 2 + 3）

| 测试组 | 题目来源 | 数量 | 主要检验 |
|---|---|---|---|
| A | Latitude Coding Agent Benchmark | 4 | JS 修复、编排成本、速度 |
| B | Coding Agent Bench | 2 | 异步 DAG、CRDT 等复杂实现 |
| C | OMC 现有 session-strategies | 3 | Resume / Handoff / Adaptive |

**具体题目 ID、基线 Commit、评分脚本和许可证必须在导入时核验**，不能仅凭任务名称直接纳入最终成绩。

### 5.2 主要开发任务

| 编号 | 任务 | 现有基础 |
|---|---|---|
| B01 | 导入并冻结 Benchmark 任务 | `test/benchmarks/` |
| B02 | 接入真实 Host Executor | `scripts/strategy-runner.mjs` |
| B03 | 固定三策略实验分组 | `integration/strategy-eval.js` |
| B04 | 独立测试与防篡改 | `integration/acceptance-runner.js` |
| B05 | 真实 Trial 采集与统计 | `integration/trial-collector.js` |
| B06 | 输出 Benchmark 报告 | `docs/evidence/v0.8/` |

**B02 是目前最关键的功能缺口**：现有 Runner 可以生成实验计划、创建隔离工作树并传递预算，但还需要接入真实的 OMC Host 执行器才能自动完成端到端 Trial。

### 5.3 实验划分

| 实验 | 内容 |
|---|---|
| **E1 单 Agent vs 多 Agent** | 4 道 JS 题，比较单 Agent、相同模型多角色、不同模型多角色。重点判断复杂编排是否带来额外收益 |
| **E2 三种 Session 策略** | 3 道连续任务，比较 `reuse_compact`、`fresh_handoff`、`adaptive`。必须保留共同前置任务，避免把普通单轮修复误当作会话复用实验 |
| **E3 复杂任务协作** | 2 道 Python 题，比较单 Agent 与多角色协作的正确率、额外调用量和失败情况 |

**首轮每个条件运行一次，共 25 个 Trial**，作为运行器和指标的**探索性 Pilot**，而不是用于证明性能领先的最终统计样本。之后可按预算增加重复实验，并固定模型、任务、策略版本、起始工作树和独立验收标准。

**费用口径**：现有订阅 CLI 的内部消耗可能无法精确换算为美元。实验应首先控制**真实 CLI 激活次数、可观测请求量、最长运行时长与并发数**，不能把未知费用记为零。新增付费实验需要明确授权。

### 5.4 v0.8 应当回答的三个问题

- **是否需要让所有 Coding 任务都经过多 Agent？** 很可能不需要。简单任务若单 Agent 更快，应允许直接派发。
- **会话复用究竟何时有效？** 必须用连续任务的真实数据决定，而不能一味追求 Resume 率。
- **OMC 的调度开销有多大？** 除最终成功率外，还要记录主控消耗、子 Agent 请求、协作耗时、重试和人工介入量。

这套 Benchmark 不仅服务 0.X，也将成为 1.X Agent 通信与 2.X RSI 策略优化的基线。

**0.8 退出条件**：真实 Runner 可复跑、采集与验收可信、结果可归因；**不要求证明 OMC 优于 OMD**。

---

## 6. v0.9：内部架构冻结，而不是 npm Release

这是本次最重要的路线修订。0.9 的交付物不再是公开 npm Release，而是一个**经过测试、可以作为 1.X 开发基础的内部稳定版本**。

### 6.1 六项收尾

| 工作 | 要求 |
|---|---|
| 代码清理 | 删除确认不可达的死代码，保留动态注册与迁移逻辑 |
| 配置统一 | 不再维护互相冲突的旧路线和默认配置 |
| CI | Node 版本、静态检查、契约回归、打包与安装 |
| 宿主兼容 | 固定并验证 DSH 版本、Desktop、Windows/WSL 等实际支持环境 |
| 基础契约 | 角色、路由、Task、Session、Result、Artifact 稳定 |
| 文档与证据 | 0.X 已实现功能、限制、Benchmark 与 1.X 接口草案 |

由于仓库已包含 Vendored OMD-Slim 源码，还要检查 `vendor/omd/PATCHES.md` 中记录的修改和许可证声明，保证后续公开包能保留正确的第三方归属。

### 6.2 暂缓 npm 发布的具体做法

- 保留 `package.json`、打包配置、`npm pack` 和隔离安装测试。
- 在 0.X 内部阶段给 `package.json` 设置 **`"private": true`**，防止意外执行 `npm publish`。
- 使用 **Git Commit、内部版本 Tag、测试报告和本地 tarball** 作为交付物。
- 不触发 npm 发布工作流，不把未经真实验收的 CLI 列为正式支持。
- 到 1.X 核心功能验收完成、准备首次正式发布时，再移除 `private` 并执行 npm 发布流程。

**需要区分**：不发布 npm 包 ≠ 不用 npm 打包工具。OMC 仍然可以通过本地构建、开发 Profile 或 tarball 进行真实安装验证。

**如果代码仓库本身是公开的**，源码仍可能被外部使用；`private: true` 只能防止 npm 意外发布，**不能替代对仓库可见性和公开声明的管理**。

---

## 7. 关键路径与 PR 拆分

0.X 剩余工作组织为九个交付 PR，**不再新增一套并列研发计划**。

| PR | 名称 | 归属 | 内容 |
|---|---|---|---|
| **PR-01** | Identity & Graph | 0.6 | 可信 lineage、Root/Child/Attempt、跨分片任务归属 |
| **PR-02** | Acceptance & Recovery | 0.6 | 统一验收出口、Baseline、Intent、Unknown 和取消恢复 |
| **PR-03** | Writer & Policy | 0.6 | 项目级 Writer Lease、最终权限约束、跨进程并发验证 |
| **PR-04** | Role Routing | 0.7 | 角色配置、连接状态、受控回退、实际模型显示 |
| **PR-05** | Workflow Closure | 0.7 | Native/Mixed/Council、消息消费、会话继续、独立验收 |
| **PR-06** | Benchmark Fixtures | 0.8 | GitHub 数据集导入、冻结起点与参考解验证 |
| **PR-07** | Real Trial Runner | 0.8 | 真实 Host Executor、三策略对照、统计与证据归档 |
| **PR-08** | Integration Acceptance | 0.8–0.9 | Desktop、真实 CLI、安装、迁移、崩溃与回归验证 |
| **PR-09** | Foundation Freeze | 0.9 | 文档收敛、死代码审计、接口版本化、内部 0.9 Tag |

**实际落地（2026-11-04）**：

| PR | 状态 | 证据 / 剩余 |
|---|---|---|
| PR-01 | done | `identity.test.mjs` 20 例；宿主 lineage 与跨分片归属 |
| PR-02 | done | `pr02-acceptance.test.mjs` 8 例；统一 Runner verdict、unknown 恢复 |
| PR-03 | done | `pr03-writer-policy.test.mjs` 16 例 + Writer Lease 真双进程竞争 |
| PR-04 | done | `pr04-routing.test.mjs` 8 例；routable+billing、worker/session 决策 |
| PR-05 | 代码 done / 真实验收 partial | `pr05-workflow.test.mjs` 6 例；真实 External Mixed/Council 未执行 |
| PR-06 | done | 9 题 + 1 前置，双向验收、38 个上游文件哈希与许可证 |
| PR-07 | done | 真实 Host Executor、25 个唯一 Trial、恢复与三组报告 |
| PR-08 | partial | CI/安装/零模型宿主通过；Desktop、External Mixed/Council 未执行 |
| PR-09 | partial | CI/打包/许可证/注册面/契约草案完成；0.X 未冻结、未建 0.9 Tag |

**可并行的部分**：PR-06 的任务准备、PR-04 的路由设计、PR-08 的验收脚本准备，可以在后端正确性修复期间并行开展。

**必须单集成人协调的部分**：PR-02/03 修改核心执行路径时，应由一个集成人协调 `src/index.js`、`provider.js` 和 Graph 等共享文件，避免开发过程中制造新的写入冲突。

### 必须明确移出 0.X 的功能

| 功能 | 新归属 |
|---|---|
| 完整跨 Harness Agent Contract | 1.X |
| 外部 Harness 实时消息与 Steering | 1.X |
| ACP / App-server / A2A 适配 | 1.X |
| 独立 Agent Registry 与统一 Agent 生命周期 | 1.X |
| 长期 Workstream Lead | 2.X |
| Superagent Mandate / Ticket 授权模型 | 2.X |
| 自主策略生成、灰度和晋升 | 2.X |
| 完整 Observer、Companion、视觉增强 | 可选功能，不阻断主线 |

**唯一的例外**：身份、任务账本、验收、会话恢复、消息持久化等基础正确性能力必须保留在 0.X——否则到 1.X 会重复开发。

---

## 8. 0.X 结束时究竟应该得到什么

用五项硬验收代替漫长且不断增长的功能清单：

- [x] **0.6**：跨进程、恢复、权限、验收的 P0 正确性问题全部关闭（[identity](../test/integration/identity.test.mjs)、[acceptance](../test/integration/pr02-acceptance.test.mjs)、[writer/policy](../test/integration/pr03-writer-policy.test.mjs)、[真实宿主原生闭环](evidence/alpha.2/practice-r01-native-runtime.json)）
- [ ] **0.7**：Native、Mixed、Council 三类真实工作流通过验收 —— Native 单/多角色与不同模型已在真实 Pilot 验证；**External Mixed 与 managed Council 因用户决定不再调用模型而 blocked**（[三链自动化闭环](../test/integration/pr05-workflow.test.mjs)，[真实多角色冒烟](evidence/v0.8/smoke-e1-multirole-kimi-review.json)）
- [x] **0.8**：真实 Benchmark Executor 接通，并形成可复现的实验报告（[25-Trial 汇总](evidence/v0.8/pilot-final-summary.json)：24/25；含 watchdog/基础设施恢复，费用全 unknown，E1 baseline 重建、E3 后验复核限制保留）
- [ ] **0.9**：CI、Desktop、安装迁移与核心协议冻结完成 —— [CI 全绿](https://github.com/PengYangchao0808/oh-my-coharness/actions/runs/41871037131)、真实 npm pack/install、许可证/注册面/跨平台检查已完成；**Desktop 点击与 Mixed/Council 验收未闭环，内部 0.9 Tag 未创建**
- [x] **1.X 准备**：明确 Agent Contract v1 的输入输出与 Adapter 能力边界（[AGENT-CONTRACT-V1](AGENT-CONTRACT-V1.md)，仅为 1.X 草案，不宣称已实现跨 Harness 协议）

> 勾选仅用于规划。真正完成仍需仓库中的代码、测试和运行证据。

达到以上条件，0.X 即可冻结。此时不需要额外再做"比 OMD 多了多少功能"的展示——**OMC 的产品差异化任务本就属于 1.X**。

---

## 9. 首次 npm 发布的真正门槛

首次公开发布的门槛明确改为 **1.X Coharness Core GA**，而非某个固定日期或简单的版本数字。届时至少要证明：

- 外部 Harness 不再只是被调用的 CLI，而是具有**稳定 Agent 身份、任务状态与能力声明**的执行参与者。
- **至少两种不同 Harness** 的 Agent 可以在真实任务中通过 OMC 可靠交换任务、消息或异步交接产物。
- 支持**能力协商**：不支持实时消息的 Harness 不会被错误标记为支持。
- Agent 会话重启、任务查询、取消、权限和预算沿用 0.X 的统一机制。
- 完成一套**端到端跨 Harness Coding Benchmark**，并能提供独立验收证据。

**不需要**等待 2.X 的 RSI-Agent 完成，也**不需要**所有第三方 Harness 都具备完全相同的功能。首次稳定 npm 包可以在这些 1.X 核心能力完成并通过发布验收后定为 **1.0.0**；此前的 1.X Alpha/RC 仍采用内部安装与测试方式，不向 npm 公开发布。

---

## 10. 同步修订的文档清单

| 文件 | 修改内容 | 状态 |
|---|---|---|
| `docs/OMC-0X-CLOSEOUT.md` | 新增：唯一的 0.X 收官实施与验收入口（本文） | 已建 |
| `docs/ROADMAP.zh-CN.md` | 0.X 重定位为 Internal Foundation；npm 首发转移到 1.X | 已同步 |
| `docs/STABILIZATION.zh-CN.md` | 取消 0.6 的公开发布目标，保留正确性与内部验收要求 | 已同步 |
| `docs/NEXT-PRACTICE.zh-CN.md` | R08/R09 改为内部验证，R10 移出 0.X | 已同步 |
| `docs/plans/next-practice.backlog.json` | 更新基线、剩余 PR、状态、验收与依赖 | 已同步 |
| `docs/OMO-SLIM-GAP-2026-11-03.zh-CN.md` | 明确核心行为兼容范围，不再追求完整生态复刻 | 已同步 |
| `package.json` / CI | 增加防意外发布保护（`private: true`），保留 pack/install 检查 | 已同步 |
| `README.md` | 头部说明改为 Internal Foundation，文档表加入口 | 已同步 |

**历史审计文件的处理**：`REMAINING-AUDIT` 等旧审计文件仍使用较早的 Alpha 基线。**保留它们作为历史证据**，但不再让它们充当最新工作状态——最新状态以本文与 `docs/plans/next-practice.backlog.json` 为准。

---

## 11. 最终节奏

```
0.6 修复核心正确性
  → 0.7 跑通真实多模型协作
    → 0.8 建立可信 Benchmark
      → 0.9 内部架构冻结
        → 1.X 完成跨 Harness Agent 协作
          → 首次正式 npm 发布
```

这次调整的意义在于，把开发目标从"做一个 OMD 的增强版"重新拉回到"形成真正的 Coharness 多智能体协作系统"。

**0.X 的成功标准不是比 OMD 功能更多，而是让 1.X 不再需要重写底层架构。1.X 的成功标准才是证明 OMC 具有 OMD 所不具备、且经过真实任务验证的跨 Harness Agent 协作能力。**

这会是一条更聚焦，也更利于后续 2.X Superagent 与 RSI-Agent 发展的路线。
