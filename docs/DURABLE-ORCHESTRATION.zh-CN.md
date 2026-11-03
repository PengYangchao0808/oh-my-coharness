# 持久化编排、工作图与 Agent 消息层

日期：2026-11-02。状态：Unreleased。本文描述本轮新增的跨进程状态、结果持久化、工作图、消息邮箱与任务复用契约。

## 1. 状态布局

所有持久状态都按 profile 分区，避免 Desktop 与 CLI/headless Host 共用一个可变文件：

```text
$DSH_HOME/omc/profiles/<profile>/
  sessions.json          # native CLI session 引用
  locks/session-<hash>    # 跨进程 Lane lease
  tasks/<parent>/         # 外部任务收据 + 结果体
  graph/<parent>.json     # 父会话工作图
  mailbox/<parent>.json   # 持久消息邮箱
```

旧路径 `$DSH_HOME/oh-my-coharness-sessions.json` 仍可读取用于迁移，但新写入不会落回那里。

### 跨进程会话 lease

`integration/file-lock.js` 用独占创建、token、PID 和心跳实现跨进程锁；进程崩溃后，其他 Host 可通过 PID/过期回收。

- 同一 Lane 同时只有一个 Host 持有 lease；第二个 Host 得到 `OMC/SESSION-BUSY`。
- 记录状态为 `running` 但 lease 已失效时，按“上一次运行未结算”恢复为 `failed`，不会把旧 native session 当成 idle 直接续接。
- 存储写入采用“锁内重读 → 只合并本进程 dirty 记录 → 原子替换”，避免两个 Host 互相覆盖。

## 2. 外部结果：completed 之外还有 unknown

`coharness({ action: "result", task_id })` 现在从 profile 分区读取持久收据：

- 结果体存在：返回原始 result。
- 结果体丢失但任务行存在：`status: "unknown"`、`unknown: true`，不伪造 completed。
- Host 重启后 `cancel`：记录 `cancelRequested` 并附 `cancelNote`，状态仍是 `running`；没有 live handle 就不谎报 cancelled。

## 3. 工作图（graph）

```js
coharness({
  action: "graph",
  graph_action: "plan",
  nodes: [
    { id: "explore", role: "explorer" },
    { id: "review", role: "oracle", deps: ["explore"], acceptance: ["names the failing line"] },
    { id: "fix", role: "fixer", deps: ["review"], write: true, writeScope: ["src/"] },
    { id: "verify", role: "oracle", deps: ["fix"], acceptance: ["tests pass"] }
  ]
})
```

运行时约束：

- `claim`：依赖必须 completed；两个 running 写节点的 `writeScope` 不得重叠，否则 `OMC/GRAPH-WRITE-CONFLICT`。
- `complete`：节点声明了 `acceptance` 就必须给 `evidence`，否则 `OMC/GRAPH-ACCEPTANCE`。
- 写节点完成必须给 `changed_files`；越出 `writeScope` 会把节点标为 `failed` 并返回 `OMC/GRAPH-WRITE-SCOPE`。
- `audit` 可单独复核文件列表；`status` 返回 ready/running/blocked/writes。

这不是第二个调度器：DSH 仍然创建和取消子 Agent；graph 只记录“谁依赖谁、谁有权写、什么证据算完成”。

## 4. 消息邮箱（mailbox）

```js
coharness({ action: "send", to: "child-or-task-id", text: "check the diff", task_id: "..." })
coharness({ action: "inbox", agent_id: "..." })
coharness({ action: "ack", message_id: "msg-000001" })
coharness({ action: "thread", task_id: "..." })
coharness({ action: "reuse", task_id: "..." })
```

语义：

- **原生 child**：`send` 先写 mailbox，再尝试调用宿主 `send_message`；成功则标记 `delivery: native`，失败则保留 `queued` 并返回原因。
- **外部 child**：没有 `prepareContinuable`，运行中无法实时 steer；消息进入 mailbox，下一次同 Lane 的 `reuse`/委派应把未读消息放进新 prompt。
- **广播**：`to: "*"` 对所有 agent 可见，不尝试原生投递。
- **task reuse**：`reuse` 返回持久任务、相关消息和“同 Lane 继续”的说明；不把 external child id 当 `send_message` 目标。

## 4.1 Native RoleResult

`subagent_result` 不再只返回一段文本，而是返回：

```json
{
  "kind": "result",
  "subagentId": "…",
  "roleId": "oracle",
  "state": "message-observed",
  "complete": false,
  "seq": 12,
  "text": "…",
  "capturedThroughSeq": 12,
  "readAt": "…"
}
```

`complete` 恒为 false：读到最新 assistant 消息不等于已结算。没有 own message 时返回 `state: "unknown"`。

外部 `coharness result` 也返回一个 `roleResult` 投影：`taskId/childId/roleId/surface/state/complete/error/readAt`，同时保留原始 `task`。外部的 `provider/model/structured/artifacts` 目前是 null/空数组，因为 CLI 不一定返回这些事实；不要把它们当成已确认。

## 4.1 会话状态

外部 provider 结果在 `diagnostics` 之外额外给出 `sessionOutcome: "new" | "resumed" | "unconfirmed"`（来自 CLI 回显与 resume 诊断）；`coharness` 的渲染行也会显示 `session …`。Session registry 记录 `lastSessionOutcome`，`stats.outcomes` 与 `/coharness sessions` 汇总 new/resumed/unconfirmed/unknown。direct 模式没有 native session，不伪造该字段。

## 4.2 Session preset snapshot

```js
coharness({ action: "preset", preset_action: "snapshot" })
coharness({ action: "preset", preset_action: "status" })
```

`snapshot` 记录这个父会话实际生效的 OMC 角色配置（source/preset/orchestrator/roles）；`status` 对比当前全局配置并列出变化。返回值固定 `hotSwitch: false`：DSH 在首轮后锁定 agent preset，保存设置不等于热切换，已创建的 child 也不会被改写。`clear` 删除快照。

> 仍未支持的 DSH 宿主能力（实时 steer、会话内 preset、native per-child worktree、动态 preset 装载）见 [DSH 契约边界](DSH-CONTRACT-LIMITS.zh-CN.md)。

## 5. CLI 结果分类

`integration/cli-result.js` 把退出码、JSON 合同、裁剪、空最后消息、resume 身份统一成一个结果：

| code | 含义 | 可重试 |
|---|---|---|
| `OMC/CLI-AUTH` | 401/登录失效 | 否 |
| `OMC/CLI-QUOTA` | 配额/余额 | 否 |
| `OMC/CLI-RATE-LIMIT` | 429/限流 | 是 |
| `OMC/CLI-CONTEXT` | 上下文超限 | 否 |
| `OMC/CLI-TRUNCATED` | 输出被裁剪 | 否 |
| `OMC/CLI-SEMANTIC-FAILURE` | 需要 JSON 但解析失败 | 否 |
| `OMC/CLI-EMPTY-OUTPUT` | 退出 0 但没有最终消息 | 否 |
| `OMC/CLI-ID-CHANGED` | resume 后换了 native session | 结果可完成但身份需报告 |
| `OMC/CLI-SESSION-UNCONFIRMED` | resume 未回显 id | 不可自动续接 |

## 6. 当前边界

- 外部运行中**实时** steer 仍不可用：DSH 外部 Provider 契约只有一次 `start()`；mailbox 提供的是排队/下次恢复，不是进程内注入。
- 设置卡已有 **Runtime** tab（会话复用、resumePolicy、maxTurns、allowUnverified、routing/计费、usage/lane 统计）；逐 Lane 清除仍走 `/coharness sessions --clear --lane=<id>`。
- **项目权限下限**：`<cwd>/.omc/project.json` 只能禁用 harness、降低并发/超时、强制 read-only、关闭 direct fallback/routing/计费授权；`dispatch` 自动套用，不能放宽。它不覆盖角色工具，也不是项目级角色/Prompt/Skill/MCP 绑定。
- **自定义外部角色模板**：`coharness role` 的 list/add/remove/run，存储 title/persona/harness/model + 可选 fallbacks；`<cwd>/.omc/roles.json` 可提供项目级模板。run 只允许 enforced read-only harness，fallbacks 里非 enforced 的会被跳过并在返回文本说明；走同一 dispatch/项目策略/分类器。项目里写 `readOnly:false` 也会被归一成只读；它不是 native role tool，不能写文件。
- **Worktree**：`dispatch mode:"worktree"` 给每个外部任务创建 disposable branch checkout，CLI 在 checkout 内写，结果返回 branch/path/files/diff；`coharness worktree` 创建 session-wide checkout，`merge:true` 可显式传 `branch`，做 clean-tree 预检、`git merge --no-ff` 和 diff check，冲突自动 abort。`require_acceptance:true` + `node_id` 会先检查 graph 节点已完成且有 acceptance evidence，再允许 merge。native child 仍没有 per-child cwd。
- 自定义角色、当前会话 preset 热切换、per-child worktree 仍未完成；原因见 [OMO-SLIM-PARITY](OMO-SLIM-PARITY.zh-CN.md#8-p0--p1-完成状态审计2026-11-02-晚第二次)。
