# Coharness Agent Contract v1（1.X 输入/输出与能力边界草案）

> 状态：**1.X 设计草案，尚未实现为独立协议**。本文只冻结 0.X 已有的身份、状态和产物语义，供 1.X Adapter 对齐；不宣称外部 Harness 已具备实时 Agent 通信能力。
> 日期：2026-11-04。上位路线：[ROADMAP](ROADMAP.zh-CN.md) · 0.X 收官：[OMC-0X-CLOSEOUT](OMC-0X-CLOSEOUT.md)。

## 1. 原则

1. **能力协商，不做虚假对等。** 一个 CLI 只能再次启动并恢复原生会话时，不得声明支持进行中消息或实时 Steering。
2. **DSH 仍是唯一 Runtime。** Contract 统一任务、身份、状态与产物，不另建 Agent Loop、第二套 Provider 或第二套任务账本。
3. **执行完成不等于验收通过。** `execution` 与 `acceptance` 永远分开；只有可信 Runner/独立验收能给出 `acceptance=passed`。
4. **未知不是零。** 不可观测的 token、费用、存活状态与内部 CLI 轮次记 `null/unknown`，不能填 `0` 或假装确定。
5. **权限只能收窄。** 项目策略、父任务约束、预算、readOnly 和 writeScope 在每次派发与续接时重新校验，子 Agent 不得通过参数放宽。

## 2. 身份模型

```text
projectId
  → rootTaskId / ticketId
    → taskId (一次分配/Trial)
      → attemptId (一次执行或恢复)
        → sessionId (宿主或 CLI 会话)
      → claimId (一次 Graph 认领)
workerKey + generation（逻辑负责人与物理会话分离）
```

| 字段 | 含义 | 信任边界 |
|---|---|---|
| `projectId` | 工作区身份 | 由工作区路径哈希得出，不是用户文本 |
| `rootTaskId` / `ticketId` | 根任务/被授权工作单元 | 由宿主 lineage 与 Graph 记录共同校验 |
| `taskId` | 一次分配，可含多个 Attempt | OMC 分配；外部调用方不得伪造根归属 |
| `attemptId` | 一次执行/恢复 | 新 Attempt 不继承旧验收；旧 Attempt 证据不能结算新 Attempt |
| `sessionId` | Native/CLI 会话 | Native 来自宿主 session header；CLI 来自适配器输出，不混淆 DSH child id |
| `claimId` | 一次 Graph claim | complete/fail/release/recover 必须匹配当前 claim |
| `workerKey` / `generation` | 逻辑负责人及轮换代次 | 由项目、模块、角色、路由、权限和工作区共同决定 |

## 3. 统一执行与验收状态

```text
attempt: intent → launching → running → ended | unknown
execution: completed | failed | cancelled | unknown
acceptance: pending | passed | failed | unknown
```

- `unknown`：无法证明存活、结果或验收；**不是 failed，也不是 completed**，不得自动重放。
- 恢复可以新建 Attempt，但必须保留旧 Attempt、usage 和 recoveryOf；已通过项不得因恢复被重复计费。
- `cancelRequested` 只是请求标记，不等于 `cancelled`。

## 4. 原语与输入/输出

| 原语 | 输入 | 输出 | v1 要求 |
|---|---|---|---|
| `discover` | harness id / cwd | 二进制、版本、连接六态、readOnly 等级、resume/消息能力、billing、verified/unverified | **必须**；注册不等于可用 |
| `start` | prompt、cwd、role、mode、model、constraints、handoff、signal | child/task identity、surface、启动状态 | **必须**；副作用前先落 intent |
| `status` | task/child id | execution、acceptance、cancelRequested、attempt、错误分类 | **必须**；不能以进程退出码代替语义 |
| `result` | task/child id | RoleResult、文本/诊断、usage、route、sessionOutcome、receipt | **必须**；保留最近结果且有界 |
| `interrupt` | child/task id、reason | 请求回执；终态随后由真实事件确定 | 按后端能力；无宿主中断服务时明确 `CANCEL-UNAVAILABLE` |
| `resume` | 签名 handoff、lane、session key、attempt | 新 Attempt、实际 resume/new/restart 决策 | 可选；仅已验证适配器；直接 prompt 不获得角色会话续接权 |
| `message` | from/to、text、taskId、attemptId、idempotency key | queued/delivered/consumed、错误 | 可选；不支持实时消息的 Harness 在下一次合法续派时注入 |
| `events` | task/session id、游标 | request/usage/terminal/progress 事件 | 可选；没有事件源时只能标 `unsupported`，不能伪造进度 |
| `artifacts` | task/attempt id、artifact id | WorkPacket、Artifact、Evidence、changedFiles、tree fingerprint | **必须提供统一表示**；产物有来源、哈希与大小边界 |

## 5. 能力矩阵（0.X 可证明的基线）

| 能力 | DSH Native | 外部 Provider（如 Codex） | Direct CLI |
|---|---|---|---|
| discover/start/status/result | 支持 | 支持，连接六态决定可否路由 | 支持，缺 CLI/认证如实报错 |
| read-only | 宿主 sandbox + 角色工具裁剪 | Provider 固定 read-only | 按显式 mode；不得由全局默认放宽 |
| interrupt | 宿主中断服务 | 宿主 child interrupt（可用时） | 进程 signal/超时 |
| resume | 同 session followup；真实 prior 驱动 | 仅支持的 CLI 原生 session resume；Codex 已验证 | 无签名 handoff 不得续接角色会话 |
| 进行中 message | `send_message` 仅直系 continuable child | **不支持**；只能 queued 后下次注入 | **不支持** |
| events | 宿主 request/usage/turn/end | 仅进程终态和 CLI 输出中可解析部分 | 仅进程终态 |
| usage | 逐步四桶，缺值 unknown | 每次 dispatch，CLI 内部轮次不可见 | 仅 CLI 自报，缺失 unknown |
| write | Native writer + 项目 Writer Lease | 外部角色不写；Designer 仅 patch | 仅显式高级模式；受项目策略/Lease 限制 |

这张表描述**当前能力边界**，不是 1.X 已完成的协议实现。任何新 Harness 都必须通过 `discover` 单独声明，不能照抄 Codex 行。

## 6. Handoff / WorkPacket / Artifact

Handoff 至少携带：

```text
taskId / projectId / laneId / workspace
context_summary / changed_files / artifact_refs / acceptance / constraints
```

WorkPacket 至少携带：

```text
goal / acceptance / read+write scopes / baseline
facts + provenance / open questions / artifacts / budget
```

约束：

- 产物引用必须是工作区相对路径，绝对路径与 `..` 在签名前拒绝。
- 超限内容外置为 Artifact；权限、验收、预算和基线不得因裁剪被删除。
- `Evidence` 绑定 `attemptId + baselineId + specDigest + treeFingerprint`；树指纹有截断边界，不能作绝对防篡改承诺。
- 直接 dispatch 的无签名 prompt 不能命名或续接角色会话。

## 7. 错误与费用

- 错误使用稳定 `OMC/<DOMAIN-CODE>`，例如 `OMC/BUDGET-EXHAUSTED`、`OMC/WRITER-BUSY`、`OMC/ACCEPTANCE-UNTRUSTED`、`OMC/HOST-EXECUTOR-UNAVAILABLE`。
- 费用字段：`costUsd: number|null`、`costBasis`、`costVersion`、`coverage: complete|partial|unknown`。
- 订阅 CLI 无法折算美元时，必须报告真实激活次数、可观测请求、时长与并发，`costUsd=null`；不得把 `spentUsd=0` 当免费。
- 自动路由只消费 `routable + billing 已授权` 的连接；未验证、signed-out、unknown billing 不得自动选择。

## 8. 1.X 最小验收

1. 两种不同 Harness 的 `discover/start/status/result/artifacts` 在真实任务中完成，且能力声明与实际行为一致。
2. 一种支持 resume 的 Harness 完成两轮真实续接；一种不支持进行中消息的 Harness 明确显示为“下次续派注入”，不能伪称实时。
3. 消息去重、取消、崩溃恢复、旧 Attempt 隔离、预算与权限不可绕过均有故障注入证据。
4. 一个跨 Harness 产出的 WorkPacket/Artifact/Evidence 能被另一 Harness 的任务消费，最终由独立验收决定，而非 CLI 退出码。
5. 任一失败、未知费用或缺失事件均可在结果中解释，且不阻碍已声明能力的最低子集使用。

## 9. 版本化

- `contractVersion: 1`。
- 新能力先出现在 `discover.capabilities` 中；不支持时返回 `unsupported`，不能通过空实现返回成功。
- 新增可选字段必须向后兼容；改变身份、终态、验收权威或权限语义时提升主版本。
- 1.X Alpha/RC 仍使用内部安装与测试，首次 npm 发布门槛见 [OMC-0X-CLOSEOUT §9](OMC-0X-CLOSEOUT.md)。
