---
name: coharness-ulw
description: Run a multi-stage job as Plan → Explore → Build → Review → Verify with explicit gates, a single writer, and a minimal handoff packet between stages.
whenToUse: The user asks for the whole thing — "做完整", "实现并审查", "修到测试通过", "多阶段", "backend + frontend", or any task where "done" must be proven rather than announced.
---

# ULW：Plan → Explore → Build → Review → Verify

多阶段工作的问题从来不是「模型不会写代码」，而是**跳过门禁就宣布完成**。ULW 用纪律和证据把门禁钉住。

开始前用 `todo_write` 把五个阶段写成任务，之后每完成一个阶段就更新状态——那是用户能看到的进度，也是你对自己的约束。

## 角色映射（同一个 Orchestrator）

| 阶段 | 优先使用 | 说明 |
|---|---|---|
| Plan | 主控自己 | 必要时 `subagent_oracle` 做架构判断 |
| Explore | `subagent_explorer` | 只读；外部后端也可，但一次性 |
| Build | `subagent_fixer` / `subagent_designer` | **默认 DSH 原生**，可续接、可写入；designer 可切外部只读产 patch，由原生 fixer 应用 |
| Review | `subagent_oracle`（独立时） | 外部 Oracle 也可，只读；不把 Review 交给 Build 的执行者 |
| Verify | 主控直接跑命令 | 真实退出码；不让子 Agent 自己宣布通过 |

内置角色不可用或用户明确点名某个 CLI 时，才回退到 `coharness`。**同一个阶段不要在 `subagent_*` 和 `coharness` 两边各跑一次。**

## 阶段与门禁

| 阶段 | 产出 | 进入下一阶段的条件 |
|---|---|---|
| **Plan** | 目标、范围、契约、文件归属、验收命令、风险 | 用户确认（或需求明确到没有分歧） |
| **Explore** | 现状事实：相关文件、已有测试、依赖、陷阱 | 只读调研足够支撑 Plan 的修正 |
| **Build** | 改动 + 自查 | Build 的最后一行是 `STATUS: done` 或 `STATUS: partial` |
| **Review** | 独立审查 | Review 的最后一行是 `VERDICT: approve` |
| **Verify** | 真实命令与退出码 | 有真实退出码，且等于 0 |

**硬规则**

- Build 没给出 `STATUS: done`，不开始 Review。
- Review 没给出 `VERDICT: approve`，不进入 Verify。
- Verify 没有真实退出码，**不说「完成」**。
- 最多**一轮修复 + 复核**。修完还不通过，就如实报告失败，不要无限循环。

## 输出契约

外部 CLI 和内置角色都不会主动守格式，所以要在 prompt 里**明确要求 footer**：

- Build 的最后一行：`STATUS: done | partial | blocked`
- Review 的最后一行：`VERDICT: approve | request-changes | insufficient-context`

没有 footer 时：按「未完成 / 上下文不足」处理，**不要猜通过**。在这种情况下你只有两个选项：补一次带格式要求的调用，或者把任务标为未完成。

## 写入纪律（单写者）

- **单写者**：同一时刻只有一个执行者能写。**不做并行写入。**
- 正常写路径是 DSH 原生的 `subagent_fixer` / `subagent_designer`：它们受 DSH 工具权限约束，可续接。
- designer 的外部后端只产 patch，不直接写：把 patch 交给原生 fixer 应用；**不要把“已产出 patch”报告成“已改动工作区”。**
- 只有用户明确要求某个 CLI 写入时，才用 `coharness` 的 `mode: 'in-place'`；派发前告诉用户：「这会用该 CLI 自己的权限写文件，不受 DSH 的文件策略约束。」
- 外部写入走 `surface: 'direct'`：**没有 childId、没有宿主容量槽、没有子会话面板**。报告里要说明这一点，不要假装它有子会话。
- 只读任务可以并行（`tasks[]`，默认 2–3 个）；写入永远串行。
- 写之前先 `git status` 记录基线；写之后再看一次，确认只改了声明的文件。

## 调研：唯一可以真并行的阶段

Explore 适合一次调用派 2–3 个**只读**任务，例如：

- 一个看后端入口与数据流；
- 一个看前端组件与状态；
- 一个看测试覆盖与 CI 命令。

不要为了「显得并行」把有依赖的步骤塞进同一个 `tasks[]`。

## 阶段交接包

每次交接只传最小集合，**不要贴整段对话**（V0.2-PLAN §6.4）：

```text
GOAL: 一句话目标
CONTRACT: 接口 / 数据格式 / 文件归属 / 验收命令
DONE: 已完成的改动与命令
EVIDENCE: 测试退出码 / diff 摘要 / 关键输出尾部
OPEN: 未决问题与风险
NEXT: 下一阶段要做什么
```

不传密钥，不传无关文件，不传历史闲聊。

## 前后端拆分（PR-4）

当一个任务同时有前端和后端时，**先定契约，再分道**。契约还在变的时候并行实现，只会得到两套互不兼容的代码。

```text
DSH 主控（唯一调度与验收者）
  确认需求 · 接口约定 · 文件归属 · 验收条件
        │
        ├── Shared Contract
        │     API schema · 数据格式 · 文件所有权 · 验收命令
        │
        ├── Frontend Lane
        │     组件 · 交互 · 状态 · UI 测试
        │
        ├── Backend Lane
        │     API · 数据层 · 逻辑 · 单元测试
        │
        └── Integration & Verification
              接口联调 · 集成测试 · 独立审查
```

拆分规则：

1. **先定契约，再并行。** 接口没定就并行实现，等于制造返工。
2. **并行只做调研 / 只读。** 两条泳道的**调研**可以并行；两条泳道的**写入**必须串行。
3. **文件所有权写清。** 「`files` 只是冲突警告，不是强制锁」——不要把它当锁，也不要让两条泳道改同一个文件。
4. **集成与验收由主控统一做。** 不让两个执行者互相验收；它们没有共同的判据。
5. **单侧可以先行。** 若契约已定而后端未就绪，前端可以对着 mock 开发，但要把 mock 标出来，并在集成阶段替换。

## 合并后的角色模型

- 内置角色（同一模型、可续接）用 `subagent_*`；外部后端角色是一次性、只读的同一个工具。
- 外部 Harness 的临时任务用 `coharness`。
- **同一个任务不要在两边各跑一次**。选一边，说清选它的理由。
- 只有一个主编排者：不要同时让主控和某个外部 CLI 各自调度。
- 外部角色报 `OMC/EXECUTION-*` 时，运行 `/coharness doctor`；不要静默改回 native 或重试。

## 什么时候不要用 ULW

- 单文件小改、纯问答、纯调研：直接做，别为了流程而流程。
- 用户只要一个方案而不是实现：停在 Plan。
- 需求本身还不可判定：先问清验收标准，再开始 Plan。

## 失败怎么写

- 每个阶段失败都要记录：哪个阶段、哪条证据、什么错误码。
- `OMC/CLI-TIMEOUT` → 缩小范围或调大 `timeoutMs`，不要原样重跑。
- `OMC/TOO-MANY-TASKS` → 拆成多次调用。
- `OMC/PARALLEL-WRITE` → 一次只派一个写入任务，其余改动串行排队。
- `OMC/BACKGROUND-UNSUPPORTED` → 改 `delivery: 'await'`（direct 路径没有后台完成通知）。
- 最终报告必须包含：改了什么、验证命令、退出码、未决风险。**没有退出码就是未完成。**
