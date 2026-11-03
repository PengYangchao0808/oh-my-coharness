# OMC 分层维护体系设计：Super-Agent 三层 + 授权账本

> 状态：**设计草案 v2，零实现**。本文不含任何"已通过"结论；凡未标「已实现」的条目一律视为未实现，且不以本文代替验收。
> 起草：2026-11-03。v2 按独立评审意见修订，逐条处理见 [附录 A](#附录-a评审意见与处理)。
> 前置门槛：v0.6 稳定化 §7 验收矩阵 + [STABILIZATION §9](STABILIZATION.zh-CN.md) 四项冻结契约 + R01/R02。
> 定位：本文是把 [NEXT-PRACTICE](NEXT-PRACTICE.zh-CN.md) 的 R03（派发/消息/验收闭环）与 R04（可轮换负责人）**串成层级**的那一层，不是与 R 系列并列的新方案。

---

## 1. 结论先行

需求可以一句话说清：**长期维护型项目，把不断进来的需求拆成子任务，交给"模块主 Agent"各自维护，模块主 Agent 再按 OMC 的路由规则调用专业子 Agent。**

这句话里真正难的不是"分层"，而是**分层之后谁有权、谁记账、谁验收**。DSH 已经能表达父子会话；OMC 缺的是把"哪条需求、哪个模块、谁授权、花了多少、验收了没"串起来的那本账。

因此本设计的主结论，按可信度排序：

1. **P0/P1 是通用修复，无论是否分层都必须做。** 三条硬缺陷已被代码确认：子 Agent 再调 `coharness` 会成为**新的独立 parent**（`tasks.js:202-207` 无 `parentTaskId`；`index.js:825` 只取 `agent.id`）→ 图之间无边；验收是**自证**（`index.js:916-923` 直接收调用方传入的 `evidence`；`acceptance-runner.js` 全仓零 importer）；**副作用先于账本**（`provider.js:249-251` 先启 CLI，`:265` 才 `tasks.start`）。
2. **三层结构本身尚未被证明有净收益。** 业界结论是编码任务并行度低、失败多在整合（见 §9），而 OMC 现在是 1 活动 writer。因此本设计不主张"先建三层"，而主张"**先建账本与授权，再用对照实验决定要不要第三层**"（§10 的 G-1 门）。
3. **"模块主 Agent"只能是一个原生角色行**（`maxDepth ≥ 2`、continuable、可写），不是新 runtime、不是 custom-role（`custom-roles.js:98` 强制只读）。此条是**待实测的假设**，不是结论（§13 Q1）。
4. **需求进入必须先过授权**，默认观察模式（observe）。借自 `dsh-superagent-prototype` 的默认值。
5. **验收必须有唯一可信出口。** 现在至少三条路径能"完成"一个节点（graph 工具直连、`native-managed.settle`、managed settle），只修其中一条等于没修。
6. **授权是契约，不是安全边界。** 原型原文必须照抄：wrappers/directories 只给默认值，不是安全边界。

核心判断：**P0/P1 不做完，不要引入第三个层级**——否则只是把一个不可审计的派发，变成了三个不可审计的派发。

---

## 2. 借什么、不借什么

参照 `deepseek-ai/dsh-superagent-prototype`（README 自述 *Research prototype for reference only, not an official DeepSeek product*）。

| 借 | 理由 | 落点 |
|---|---|---|
| **Ticket = "a unit of authorized work"**，只有 Eval 能创建 | 把"需求"和"任务"分开 | 扩展 `graph.js` 节点（不新建状态机） |
| **Mandate 不可变**；只有 accept 创建、人的 stop 撤回、revalidation 失败撤销 | 授权有版本、可审计、执行者不能自行扩大 | append-only 决策日志 |
| **accept mode 默认 observe** | 长期运行系统默认不自动花钱、不自动改代码 | `policy.acceptMode` |
| **resume 前 revalidation** | 跨会话续接是长期维护的主要风险点 | 接 `integration/sessions.js` 恢复路径 |
| **disposition 审计**（每次决策留 reason 码） | 事后能回答"为什么接了/没接这条需求" | 见 §4.3（默认并入既有事件流） |
| **effect 先存后做** | 崩溃窗口不能丢副作用 | 修正 `provider.js` 顺序 + `launching` 态 |
| **越权 handback 一次**（带 reason，不静默扩权） | 主 Agent 不能自己把 scope 变大 | 拒绝路径 |
| **不借** | 理由 | |
| Source / Channel 事件源 | OMC 没有外部 IM/Issue 事件流需求，DSH 会话本身就是源 | — |
| 单 SQLite 单写者引擎 | 插件内引入原生依赖与打包负担；但"JSONL 够用"本身未经基准验证（附录 A-9） | 先 JSON+file-lock，记录为待验证假设 |
| "记录永不删除、无限增长"（原文明列缺陷） | 长期维护必须有归档与 TTL | 保留策略 |
| "验收是 prompt 规则"（如 <200 行） | OMC 已有 acceptance 概念，必须可执行、可复跑 | 见 §7 |

一句话取舍：**借它的"授权与审计"，不借它的"引擎与接入"。**

---

## 3. 三层结构与不变量

| 层 | 运行时形态 | 能派发 | 能写 | 能改授权 |
|---|---|---|---|---|
| **L0 Owner**（DSH 主会话） | 唯一 root，既有 Orchestrator persona | L1 lead + 救急直派专业角色 | 通过 fixer | 唯一 accept / stop / 改 Policy |
| **L1 Workstream Lead**（新 `lead` 角色） | 原生 continuable 子会话，`maxDepth ≥ 2`，`workerKey` 长期稳定 | L2 专业角色 | 仅本 workstream scope | **不能**（只能申请，不能扩） |
| **L2 Specialist**（既有五角色） | 原生或 `omc:<harness>`，按 `resolveExecution` 判定 | 无（`maxDepth` 到此为止） | 仅 native fixer | 不能 |

**L1 为什么倾向原生（假设，待实测）**：外部 provider 没有 `prepareContinuable`（无 `send_message`）、固定只读、`maxDepth: provider-managed`、不能产生 DSH 子会话（ARCHITECTURE §6）。若探针证明存在别的方式，此条可放宽——**但它目前只是最可能形态，不是唯一可能形态**。

### 六条不变量与它们的真实强制力

| ID | 不变量 | 强制点 | 现在能做到吗 |
|---|---|---|---|
| I1 | 任意时刻只有一个 root；L1 是它的子会话 | 需**宿主认证的祖先链**，不能用工具入参自报 | **做不到**：lineage 目前从 `session.header.parentSession` 推导，但仅用于用量归属（`native-runtime.js:202/266`），不参与 claim 校验 |
| I2 | 授权只向下，`writeScope ⊆ 父` | `graph.claim` 增加层级包含判定 | **部分**：代码层可校验"申报的 scope"，实际文件写限制做不到（需宿主权限） |
| I3 | 执行与验收分离，无 evidence 不得 complete | 三个完成入口必须收敛到一个 verdict 函数 | **部分**：`graph.js:317-319` 只做条件性字符串检查，可被直连绕过 |
| I4 | 同一 workstream 单 writer；**且项目级总闸门仍为 1** | 项目级原子全局限额 + workstream 串行 | **做不到**：`graph.js:278-286` 只比较**同一张图**内运行中节点；跨图/跨进程无闸门 |
| I5 | 账本先于副作用 | 先落 intent/attempt 再启动；未知存活不得自动重跑 | **部分**：可约束 OMC 自身的启动；"任何文件写/外部动作"无法由 OMC 全覆盖 |
| I6 | 一个 ticket 执行期间 policyVersion 与路由不变 | 派发、续接、每请求前校验冻结快照 | **做不到**（运行期）：目前只能在派发与续接时校验 |

**这一段是本设计的诚实核心：I1 与 I4 当前不可强制。** 任何"分层后写冲突已经被防住"的说法在 P1 完成项目级闸门之前都属未验证。

---

## 4. 身份模型

### 4.1 现状的空洞

所有 store 按**顶层 agent id 分片**（`index.js:825`、`tasks.js:203`），task 行无 `parentTaskId` / `depth`（`tasks.js:202-207`）。唯一层级信息是用量归属（`native-runtime.js:202/266`，`MAX_LINEAGE_DEPTH=24`）。**结论：今天 OMC 在结构上做不到"父任务 → 子任务 → 孙任务"的关联。**

### 4.2 可信 lineage（不是"传个 rootId"）

| 要求 | 做法 | 反例（必须避免） |
|---|---|---|
| 来源可信 | 从宿主会话头（祖先链）读取，**工具入参不得声明 lineage** | 让调用方传 `root_task_id`，等于让执行者自证身份 |
| 跨分片寻址 | 子任务的 store 仍按 root 分片；写自己的分片需显式路由，不能默认落到 `agent.id` | 沿用 `index.js:825` 的裸 `agent.id` |
| 父票验证 | claim 时校验：父 ticket 存在、状态 open/running、`writeScope` 包含、workstream 匹配 | 只校验节点存在 |
| 原子认领 | 认领（claim）与账本写入在同一把锁内完成 | 先 claim 后记账 |

### 4.3 概念与落点（不新建状态机）

| 概念 | 定义 | 落点 | 新增/扩展 |
|---|---|---|---|
| **Project** | 一个工作区 | 已有 `projectId`（`handoff.js` 路径哈希） | 复用 |
| **Workstream** | 长期维护的模块边界：路径集合 + 负责人 key + 限额 | `<state>/workstreams/<projectId>.json` | 新增（一份登记表） |
| **Requirement** | 一次需求接收 | **`graph` 节点的字段与状态**（`kind:'requirement'`），不另立状态机 | 扩展 |
| **Ticket** | 被授权的工作单元 | 同上节点：`{requirementId, workstreamId, parentNodeId, mandateId}` | 扩展 |
| **Assignment** | Ticket ↔ 一次执行 | `tasks` 行：`{rootTaskId, depth, ticketId, workerKey}` | 扩展 |
| **Mandate** | 授权：Policy 版本 + 强度 + scope + 依据 + 发送者 | 决策日志中的 `mandate.created` 行 | append-only |
| **Evidence** | 可复跑的证据对象 | `graph` 节点 `evidence` 由字符串升级为对象数组（保留字符串兼容） | 扩展 |
| **Disposition** | 每次 gate 决策的审计行 | **默认并入 `execution-events` 既有日志**（见 §13 Q3） | 复用 |

**为什么不新建事件流**：v1 曾以"append-only 就不是数据库"自证，这个论证不成立——只要引入新的 Requirement/Ticket 状态机，就是实质扩张（附录 A-7）。v2 改为：**ticket 的生命周期就是 graph 节点的生命周期**，只additionally 记录决策行。

---

## 5. 授权层（Mandate 的最小可用版）

### 5.1 配置

```json
{
  "policy": {
    "version": "2026-11-03.1",
    "acceptMode": "observe",
    "admission": [
      { "scope": "workstream:plugin-runtime", "explicit": "accept", "inferred": "observe" },
      { "scope": "workstream:docs",           "explicit": "accept", "inferred": "ignore" }
    ],
    "limits": { "maxWorkstreams": 1, "maxActiveWriters": 1, "budgetPerRequirementUsd": 3, "budgetPerDayUsd": 10 }
  }
}
```

- `acceptMode`：`off | observe | auto`，**默认 `observe`**。observe 下推断命中只记 `decision=ignore, wouldAccept=true`，不建 Ticket、不派发。
- `maxWorkstreams` 初值 **1**：多模块并行是 P4 的事，不是默认值（v1 示例写 4，与 §9"默认单 workstream"自相矛盾，已改）。
- 与现有 `routing` / `allowPaidApi` 正交：`policy` 决定"做不做"，`routing` 决定"谁来做"。

### 5.2 授权生命周期（v1 的矛盾已修）

Mandate 是**不可变记录**，钉住创建时的 `policyVersion`。三条改它：accept 创建 / 人的 stop 撤回 / revalidation 失败撤销。

| 场景 | 规则 | 说明 |
|---|---|---|
| 新需求 | **必须重新 gate**，不得沿旧 Mandate 续接 | v1 说"人在 workstream 再说一句可直接 resume"是**授权旁路漏洞**，已删除 |
| 续接既有 ticket | 必须显式携带 `resumeTicketId`；无此字段即视为新需求 | 解决"再说一句"与"新需求"的歧义 |
| Policy 变更 | 只发 `policyChanged` 输入，不吊销 live ticket | 与"版本只影响新票"一致 |
| revalidation 判据 | **不是** `policyVersion` 相等，而是：mandate 未撤销 + 其 scope 的准入规则仍存在且强度未降级 | v1 写"版本未变"，与上一条冲突，已修 |
| 超 scope 的子 ticket | handback 一次（带 reason），不静默扩权 | 与原型一致 |

### 5.3 诚实边界

照抄原型原文进文档与状态卡：**"wrappers and directories establish defaults, not a security boundary"**、**"avoiding code reads is a prompt rule, not a tool restriction"**。分层之后写者变多，**这一点只会更依赖契约而非权限**。

---

## 6. 路由：L1 只声明意图，后端由 OMC 决定

分层最大的风险是 L1 变成第二个"选模型/选后端"的人。因此：

- **L1 不能读写 `roles.<id>.execution`**；只给 `role + 意图 + 工作包`，由 `resolveExecution()` + 连接六态决定后端。
- **意图 → 角色**（固定表）：

| 意图 | 角色 | 允许后端 | 说明 |
|---|---|---|---|
| 定位/影响面 | explorer | native；可外部只读 | 只读 |
| 实现/修复 | fixer | **仅 native** | 唯一写入口 |
| 架构/风险/评审 | oracle | native 或外部可读 | 不写 |
| 前端方案 | designer | 外部时仅 patch，native 落地 | ARCHITECTURE §4 |
| 查库/查文档 | librarian | native（MCP 依赖） | — |
| 独立验收 | verify（oracle 的只读 grader 用法） | native 优先 | §7 |

- **连接状态是硬门**：`routable` 才自动路由；`authenticated` 仅用户显式指定；`missing/disabled` 直接 blocked（`src/connection.js` 已实现，18 例）。
- **Council 不能当"多主 Agent"**：席位 `fixedAllow: ['read','glob','grep']`、合成器无工具。可复用的是"并行 + 汇总"的**指令结构**，不是席位本身。

---

## 7. 验收：唯一可信出口

**这是全设计最容易被跳过、跳过就全盘失效的一节。**

1. **收敛出口**：节点完成必须经过同一个 `resolveAcceptance()`。现有至少三条旁路必须全部改道：
   - `src/index.js:916-923` 的 `graph.complete` 直接收 `args.evidence`；
   - `integration/native-managed.js:120` 的 `settle` 同样收调用方 evidence；
   - `integration/managed-execution.js` 的 settle。
   只接第三条 = 没修（附录 A-1）。
2. **断言可执行**：`{ kind:'command', cmd, expectExit:0 }` / `{ kind:'diff-scope', paths }` / `{ kind:'review', rubricVersion }`。
3. **基线必须在执行前冻结**：`acceptance-runner.js:459` 的 `baseline()` 要**先于派发**调用，只在 settle 时接不够（附录 A-12）。
4. **树指纹不是绝对保证**：`work-packet.js:94` 对大文件只取头部 64KB，`MAX_PACKET_CHARS` 还有截断与外部化。指纹差别只能说"可能变了"，不能说"必然不同"（附录 A-15）。
5. **独立复核**：L1 的交付由 L0 指派的 verify lane 复核；**L1 不能写最终 evidence**。
6. **L0 只做整合判断**：L1 交付工作包（目标/改动/证据/未决项/剩余风险），L0 不重做实现。

---

## 8. 生命周期与崩溃恢复

```
Ticket(node): pending → running(claimed) → reported → verified → completed
                                              ↘ failed / cancelled
Attempt:      intent → launching → running → ended(report) | unknown
```

恢复规则（照原型的 recovery note）：

- **`launching` 是显式状态**：先写 `intent`（含 command、cwd、worktree、policyVersion），再写 `launching`（含 pid/startedAt），最后启动。仅把 `tasks.start` 提前**不够**——"已启动但未确认"窗口仍在（附录 A-5）。
- **未知存活 = unknown，不是 failed**：重启后旧 attempt 记 `host restarted` + recovery note；**在核对目录/git 之前禁止自动重跑**。没有宿主存活探针时，宁可卡住也不重放（重复外部动作比停顿更贵）。
- `managed.recover`（`managed-execution.js:212`）与 `requestGate.reconcile`（`request-gate.js:355`）**已实现但零调用**；P1 在 `src/index.js#apply` 启动时接线。
- `cancelRequested ≠ cancelled`（V0.5-ALPHA2 §4.1）：中断走宿主真实契约。

---

## 9. 失败模式与闸门

业界结论（[Anthropic multi-agent research](https://www.anthropic.com/research/multi-agent-research-system)、[Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)）：多 Agent 约 **15× token**；编码类并行度低；**典型失败是"分解后无法整合"**。故默认值保守：**默认单写者、observe、单 workstream**。

| 失败模式 | 表现 | OMC 闸门 | 现状 |
|---|---|---|---|
| 成本爆炸 | 一个需求扇出 20 个 assignment | 每 requirement 预算 + `maxActiveWriters` + observe 默认 | 预算仅在 dispatch 边界硬控（`dispatch.js:474-491`）；默认可无 cap → advisory |
| 分解后无法整合 | 各 L1 各自隐含决策，L0 收拾残局 | 同一接口只由一个 Ticket 产出契约；交付必须含"未决项" | 无机制，靠 prompt |
| 上下文丢失 | 超窗截断丢计划 | 工作包是唯一交接通道；不伪造 compact | 已有原则（R04），未接线 |
| 重复劳动 | 两个 Ticket 做同一件事 | 创建前查同 workstream open ticket 与 `writeScope` 交集 | 无 |
| 验收自证 | L1 自己写"已通过" | §7 统一出口 + runner 复跑 + 独立复核 | **旁路存在** |
| scope 漂移 | 改到 workstream 之外 | `graph.js:321-337` 越界改判 failed，扩展为 `pathGlobs` | 部分（只校验自报 `changed_files`） |
| 并行写冲突 | 两个 writer 改同一文件 | I4 单 writer + **项目级总闸门** | **跨图无闸门** |
| 层溢出 | L1 把整个 ticket 转包给另一个 L1 | `maxDepth` 硬限制 + 禁止同层转包（规则） | 规则，非权限 |
| 授权幻觉 | 把提示词限制当隔离 | §5.3 写进 UI 与文档 | — |

---

## 10. 分期路线

| 期 | 目标 | 主要改动 | 验收证据 | 明确不做 |
|---|---|---|---|---|
| **P0a** 身份贯通 | 三级会话归到同一 root | 从宿主取可信 lineage；`tasks` 加层级字段；`graph` 节点加 ticket 字段；`index.js:825` 改路由；`graph.claim` 校验父票 | **用合成 lineage 夹具**验证 root→mid→leaf 归属（不依赖 lead 角色存在）；跨分片不串；重复事件不重复计费 | 不新增角色、不改验收语义 |
| **P0b** 启动与恢复协议 | 崩溃窗口可追踪、可对账 | `provider.js` 改为 intent → launching → start；restart 置 unknown；启动时调 `managed.recover`/`requestGate.reconcile` | 启动失败有 intent 可查；未知存活不自动重跑；重复回放不加费 | 不做存活探针的自动化判断 |
| **P1a** 验收出口统一 | 验收不再是自证 | `resolveAcceptance()` 收敛三个入口；`baseline()` 前置到派发前；evidence 结构化 | **三个入口逐一**用假 evidence 测试：全部被拒 | 不做自动 review 验收（模型 grader 后置） |
| **P1b** 写者闸门 | 项目级全局限额 + workstream 串行 | 项目级原子锁（跨进程）＋ `graph.claim` 层级包含判定 | 两进程争最后一个 writer 名额只有一成功（不是进程内 Map 测试） | 不做自动合并 |
| **P2** Lead 角色 | 出现真正的"模块主 Agent" | `vendor/omd/npm-package/preset/{role-ids,roles,preset,config}.js` 解冻加 `lead` 行（`maxDepth ≥ 2`、仅 native、写权受限）；意图→角色路由表；设置卡显示层级 | 一个真实需求由 lead 拆成 ≥3 个子 ticket，L0 只做验收；lead 改 `execution` 被拒 | 不开 auto、不多 workstream |
| **P3** 准入与长期运行 | 需求持续进入且可解释 | `policy` + gate + 决策审计（并入既有事件流）；requirement 入口；revalidation；预算按 requirement/day | 连续 5 个需求在 auto 下完成且每笔可归因；observe 期决策可审计；越权 handback 一次 | 不做模型自选/自动合并 |
| **P4** 多模块并行 | 跨 workstream 并行 | 文件集不交叠判定 + L0 批准；失败分类 → 有限候选 → 灰度（复用 FEEDBACK R10） | 两 workstream 并行 3 天无写冲突；任一退化可回退 | 不做无人值守晋升 |

### 硬门与依赖

- **G-0（前置）**：STABILIZATION §9 四项证据 + v0.6 §7 P0 + **R01/R02**（原生事件归集与预算闸门是身份与账本的地基）。
- **G-1（收益对照）**：**P2 之后不得直接推广**。先用 R06–R08 的机制做三组对照（L0 直派 / 工作包 / lead 分层），比较成本、耗时、退回率。缺这组数据，三层只是"看起来更先进"。
- **G-2（物理前提探针）**：DSH 是否允许 `maxDepth ≥ 2` 的**写型 continuable** 行在其子会话里再派发。**未实测前 P2 只做设计**。
- **G-3（顺序修正）**：v1 让 P0 验收 `root→lead→fixer` 却把 lead 放到 P2，自相矛盾（附录 A-11）。v2 用合成夹具解耦。
- **G-4（授权前移）**：最小授权与预算校验**必须在 P2 之前**落地（哪怕只是 explicit-only），否则 lead 一出现就有无授权派发。

---

## 11. 最小文件改动清单

| 文件 | 改动 | 期 |
|---|---|---|
| `integration/tasks.js` | task 行加层级字段；`start` 接受可信 lineage | P0a |
| `src/index.js` | `:825` 改路由；graph 完成入口改道 §7；启动调 recover/reconcile | P0a/P0b/P1a |
| `src/provider.js` | intent → launching → start；失败可对账 | P0b |
| `integration/graph.js` | 节点加 ticket 字段；claim 加父票校验与层级包含 | P0a/P1b |
| `integration/managed-execution.js` | settle 走统一 `resolveAcceptance()` | P1a |
| `integration/native-managed.js` | `:120` settle 走统一出口 | P1a |
| `integration/acceptance-runner.js` | 从零 importer 变为被调用；`baseline()` 前置；补 workstream 断言 | P1a |
| 新增 `integration/workstreams.js` | 模块登记、`pathGlobs`、单 writer 锁、限额 | P1b |
| `vendor/omd/npm-package/preset/role-ids.js`、`roles.js`、`preset.js`、`config.js` | 解冻白名单加 `lead`；`preset.js` 加行与 persona；orchestrator 文案改为"除 lead 外不可再派发" | P2 |
| `locale/*.json`、设置卡 | 层级、workstream、observe 状态 | P2/P3 |

不改：`vendor/omd` 折叠逻辑、Provider 契约（`vendor/omd/PATCHES.md:68-75`）、`resolveExecution` 语义、外部只读等级。

---

## 12. 非目标与放弃条件

**非目标**：第二套 runtime / 第二调度器 / 点对点总线 / 任务数据库（ARCHITECTURE §10 仍然有效，变更需显式决策，**不能靠改名规避**）；搬 superagent 的 Source/Channel/SQLite；外部 CLI 当主 Agent；单角色双后端（`roles.js:505`）；无人值守自动合并；宣称"沙箱化"。

**放弃条件（阈值均为 provisional，须在 G-1 后用实测基线校准）**：

1. G-2 探针证明 DSH 不支持 `maxDepth ≥ 2` 的写型 continuable → 退回"单层 + 工作包"，只保留 P0/P1。
2. lead 平均每需求拆出 < 2 个子 ticket，且 L0 直派更快 → 层不成立。
3. 成品成本 > 单 Agent 的 N 倍（N 待定）而验收通过率无提升 → 保持 observe，不推广。
4. 整合失败率（L1 交付被 L0 退回重做）持续高于阈值 → 先修契约，不加层。

---

## 13. 待决问题（需拍板）

| # | 问题 | 选项 | 倾向 |
|---|---|---|---|
| Q1 | 先做 `maxDepth=2` 写型宿主探针，还是边做边探 | 先探针 / 边做边探 | **先探针**：整层物理前提 |
| Q2 | L1 常驻还是每需求新建 | 常驻（workerKey 稳定、child 轮换）/ 每需求新建 | **常驻**：符合长期维护语义，复用 R04 |
| Q3 | 决策审计放独立流还是并入 `execution-events` | 独立 / 并入 | **并入**（v2 已改）：避免实质扩张状态面 |
| Q4 | `review` 类断言是否允许模型 grader | 允许（校准后）/ 只允许可执行断言 | **先只允许可执行断言** |
| Q5 | L0 是否可绕过 lead 直派 | 允许留痕 / 禁止 | **允许但必须写绕过原因**，否则层级会被日常绕过 |
| Q6 | 是否接受"项目级全局 writer 闸门"作为 P1b 硬门（跨进程锁） | 是 / 先只做单进程 | **是**：I4 没有它就等于没有 |

---

## 附录 A：评审意见与处理

独立评审（只读，外部 CLI）提出 7 组问题，逐条处理如下。

| # | 评审意见 | 处理 | 位置 |
|---|---|---|---|
| A-1 | 验收有旁路，只接 managed 不够（`index.js:916`、`native-managed.js:120`） | **接受**。改为统一 `resolveAcceptance()`，三入口全改道 | §7.1、§11 |
| A-2 | 授权生命周期矛盾：新需求沿旧 Mandate resume；"版本只影响新票"与 resume 版本失配冲突 | **接受**。删除"同一 Mandate 直接 resume"；续接须显式 `resumeTicketId`；revalidation 判据改为"规则仍存在且强度未降级" | §5.2 |
| A-3 | 身份字段不是身份认证：需可信 lineage、跨分片寻址、父票验证、原子认领 | **接受**。新增 §4.2 专节 | §4.2 |
| A-4 | 每 workstream 单 writer 冒充全局限额；`graph.js:278` 只拦同图 | **接受**。I4 改为"项目级总闸门 + workstream 串行"，并标注当前**做不到** | §3、§10 P1b |
| A-5 | 先记录 ≠ 可恢复：仍有"已启动未确认"窗口，无存活探针 | **接受**。引入 `launching` 与 `unknown` 态；未知不自动重跑 | §8 |
| A-6 | 分层必要性未被证明；应把 R06–R08 对照前移到推广前 | **接受**。新增 G-1 收益对照门；§1 结论降级为"未证明" | §1、§10 |
| A-7 | §4.3 用 JSONL 证明"不是数据库"不成立；新增 Requirement/Ticket 状态机是实质扩张 | **接受**。取消新状态机，ticket 生命周期即 graph 节点；审计并入既有事件流 | §4.3、§13 Q3 |
| A-8 | P0 验收 `root→lead→fixer` 与"P2 才加 lead"自相矛盾 | **接受**。P0 改用合成 lineage 夹具 | §10 G-3 |
| A-9 | §2"JSONL 够用"缺证据 | **接受**。标为待验证假设，不再作论证依据 | §2 |
| A-10 | §3"原生是唯一可能形态"缺证据 | **接受**。降级为"最可能形态"，由 G-2 探针裁决 | §3 |
| A-11 | §7"树变必失效"过强 | **接受**。改为"可能变了"；引 `work-packet.js:94` 的 64KB 头哈希限制 | §7.4 |
| A-12 | runner 需执行前 `baseline()`，不能只在 settle 接 | **接受**。`baseline()` 前置到派发前 | §7.3 |
| A-13 | §9"默认单 workstream"与 §5 示例 `maxWorkstreams:4` 矛盾 | **接受**。示例改 1 | §5.1 |
| A-14 | §12 五需求/三天/3 倍/40% 无样本依据 | **接受**。阈值全部标 provisional，待 G-1 校准 | §12 |
| A-15 | §11 路径错（`preset/roles.js` 不存在，应在 vendor 下） | **接受**。改为完整 vendor 路径 | §11 |
| A-16 | STABILIZATION §9 措辞与 §10"只禁 P2"不统一 | **接受**。统一为：§9 禁止任何提前适配；P0/P1 只作为**通用修复**（不面向 SuperAgent） | §1、§10 G-0 |

**保留不同意见的一条**：评审建议"先做宿主能力探针再定 P0 内容"。本设计把探针限定在 G-2（只决定 P2 是否开工），P0a/P0b 不依赖探针——因为它们修的是**已确认存在**的缺陷，即使最终放弃分层也仍然要做。这一点保留。

---

## 附：与既有计划的对应关系

| 既有条目 | 在本设计中的位置 |
|---|---|
| R01 原生事件桥 | G-0 前置：身份与用量归集的地基 |
| R02 预算闸门 | G-0 前置；I4/P1b 的跨进程锁与之同源 |
| R03 派发/消息/验收闭环 | P0 + P1a；本设计是它的**层级化** |
| R04 可轮换负责人 / workerKey | L1 的"逻辑固定、物理轮换"直接用 R04 结论 |
| R05 设置卡与监控 | P2/P3 展示层 |
| R06–R08 三策略对照 | **G-1 收益门**，决定三层是否推广 |
| R10 有限候选与灰度 | P4 复用，且必须先有 P3 审计 |
| STABILIZATION §9 四契约 | G-0 前置门槛，不是可选项 |
