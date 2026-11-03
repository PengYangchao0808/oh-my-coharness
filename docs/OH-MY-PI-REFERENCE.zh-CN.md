# Oh-My-Pi 参考：OMC 后续完善方案

日期：2026-11-02。参考对象：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（MIT，Pi 的 coding-first fork，当前 main 分支）。本文只做**行为与架构参考**，不复制其代码；任何代码复用都要先核对当时版本的许可证与依赖。

为什么参考它：OMP 和 OMC 都在解决“一个主控 + 多个专业子 Agent + 每角色模型 + 后台生命周期 + 结果回收”。区别是 OMP 自己就是完整 harness（TUI、provider、工具、隔离全包），OMC 是 DSH 插件（runtime 归 DSH）。所以 OMP 值得学的是**任务/结果/生命周期契约**，不是它的终端或 Rust 工具层。

---

## 1. OMP 已经实现、而 OMC 还缺的六件事

### 1.1 Agent 定义是可发现的声明，不是硬编码角色表

OMP 的 task agent 由 frontmatter 定义，字段包括：

- 必填 `name / description / systemPrompt`；
- 可选 `tools / spawns / model（优先级列表）/ thinkingLevel / output / blocking / structured / autoloadSkills / prewalk / advisor`；
- 发现顺序 first-wins：项目 `.omp/agents` → 用户 `.omp/agent/agents` → 扩展包 → Claude marketplace → 内置；
- 同一目录按文件名字典序，坏文件只跳过自己，不拖垮全部；
- `main` / `sub` 是保留名；`spawns` 缺失但 `tools` 含 `task` 时自动变成 `*`；
- 模型优先级：`task.agentModelOverrides` → agent frontmatter → 父会话模型；per-call `model` 只在 `task.perCallModel` 允许时才可用。

参考： [task-agent-discovery.md](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md)、[`src/task/discovery.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/discovery.ts)、[`src/task/types.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/types.ts)。

**对 OMC 的含义**：角色表不能永远只有 9 个固定 id。但“项目级 agent 文件”会扩大执行面，必须先有信任边界和冲突校验，不能直接照搬发现顺序。

### 1.2 `task` 是一个批式、可后台、可结构化的委派契约

OMP 的 `task`：

- batch 形态 `{ context, tasks[] }`，一次 fan-out，共享背景；
- 每个 item 独立 `agent / model / effort / outputSchema / schemaMode`；
- `async.enabled=true` 时是后台 job，完成结果注入父会话；`wait` 等下一条后台结果；
- `proc://` 查/杀后台 job，`agent://` 读最终产物，`history://` 读会话；
- `outputSchema` 优先于 agent frontmatter `output`，再继承父会话 schema；
- 结果 `SingleResult` 带 `resolvedModel / usage / tokens / durationMs / structuredOutput / artifacts / error / aborted`。

参考： [task 工具文档](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md)、[`src/task/structured-subagent.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/structured-subagent.ts)、[`src/task/executor.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/executor.ts)。

**对 OMC 的含义**：现在的角色工具返回的是“子 Agent 的最后一段文本 + 一个 child id”。这不足以让主控判断“是否完成、用了哪个模型、产物在哪、验收条件是否满足”。下一步应先补**结果信封**，而不是加更多角色。

### 1.3 生命周期是显式状态机，不是“有 session id 就算成功”

OMP 的 agent registry 状态：`running | idle | parked | aborted`。

- 成功/失败都先进入 `idle`，挂 live session；
- idle TTL 到期后 `parked`（session 文件保留）；
- `write agent://<id>` 或 Agent Hub revive，重新打开 transcript；
- 显式 kill 写 tombstone；之后可 revive；
- 子 Agent 可以继续被 steer/follow-up，而不是每次新开；
- 冷恢复只恢复精确保存的 per-call route 和 thinking level，并重新校验授权。

参考： [Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md)、[`src/registry/agent-lifecycle.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/registry/agent-lifecycle.ts)、[`src/registry/agent-registry.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/registry/agent-registry.ts)。

**对 OMC 的含义**：DSH 已经有 `send_message / interrupt_agent / subagent_result` 和完成通知；OMC 不该再建状态机，而应把 DSH 的状态**投影**成 `RoleResult.state`，并补上持久化与“重启后未知就是未知”。

### 1.4 并行写入用隔离工作区，不靠 prompt 约束

OMP 的 `isolated: true`：

- 每个 task 一个隔离 workspace（APFS clone / btrfs / ZFS / reflink / overlayfs / ProjFS / rcopy）；
- 完成时捕获 root/nested patch 或 branch，按 `task.isolation.merge` 合并；
- 失败保留 recovery artifacts；
- 嵌套仓库分别 diff / merge；
- 超过 1 GiB 的 baseline 直接拒绝，不无界缓冲。

参考： [task 文档 Isolation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md)、[`src/task/isolation-runner.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/isolation-runner.ts)、[`src/task/worktree.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/worktree.ts)。

**对 OMC 的含义**：不要自己写一套 worktree/overlay。DSH 已有 `dsh-experimental-worktree`，先审计它是否满足“创建 → 写入范围 → 测试 → 合并 → 冲突/取消收尾”，再决定是复用还是只写 OMC 的验收层。

### 1.5 模型是“角色 + 回退链”，不是一次选择

OMP 的 `modelRoles` 把 `default / smol / slow / plan / commit / vision / task / advisor / tiny` 映射到具体模型；支持：

- 每角色 fallback chain（429/配额墙后切换，冷却后恢复）；
- path-scoped models（按仓库路径固定不同模型集）；
- 多 key 轮转与会话亲和；
- per-call model 需要 operator 授权，项目配置只能收紧不能放宽。

参考： [README Providers](https://github.com/can1357/oh-my-pi#sixty-plus-providers-a-thousand-models-one-model-away)、[task-agent-discovery.md 的 Model precedence](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md#model-and-structured-output-precedence)。

**对 OMC 的含义**：`fleet` 只解决“初始分配”；下一步是**失败分类 + 显式回退**。外部 dispatch 已支持显式 `fallbacks`，但角色工具仍没有模型级自动回退。DSH `llm-retry` 负责重试，OMC 负责“是否换角色模型”的策略。

### 1.6 Agent Hub 是观察面，不是第二个 runtime

OMP 的 Agent Hub 做：

- roster：状态、父/子、模型、耗时、cost、tokens、当前工具；
- 选中后可读 transcript、steer、revive、kill；
- 活动日志按响应/工具/错误过滤；
- 持久化 session 的 subagent 变成 parked 行；
- `/jobs` 与 Hub 分离：jobs 是后台任务，Hub 是 agent 视图。

参考： [Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md)。

**对 OMC 的含义**：不要做新的 Dashboard。DSH 已有子 Agent 面板和会话视图；OMC 只需要在 `status` / `doctor` 里给出**角色 → surface → provider/model → 状态 → 结果引用**，并把用户导向 DSH 已有的 transcript/中断入口。

---

## 2. 借鉴 / 不借鉴清单

| OMP 能力 | OMC 应该怎么做 | 判定 |
|---|---|---|
| Agent frontmatter 定义 + 发现优先级 | 先做项目/用户角色定义，但必须加信任边界、冲突校验、卸载清理 | 借鉴，延后 |
| `task` batch + 共享 context | 保留 DSH 现有角色工具；补“同一条消息并行调用多个角色”的编排 Skill/模板 | 借鉴 |
| `SingleResult` 结果信封 | **优先做**：角色工具结果统一带 surface/model/state/usage/artifacts/structured | 借鉴 |
| `running/idle/parked/aborted` | 映射 DSH 状态；持久化 parent-scoped 结果目录；不新建消息总线 | 借鉴，投影 |
| `agent://` / `history://` | 用 DSH session artifact + `subagent_result`；外部结果用 durable tasks，补持久化 | 部分借鉴 |
| `wait` / `proc://` | 用 DSH 完成通知 + `subagent_result`；不新增 job 管理器 | 不照搬 |
| 隔离 workspace | 审计并复用 DSH worktree 插件；OMC 只做写范围与合并验收 | 借鉴，复用 |
| `modelRoles` + fallback | 扩展到显式 `fallbacks`，但必须显式、可解释、计费门控 | 借鉴 |
| Agent Hub TUI | 复用 DSH UI；OMC 只提供 roster 数据和深链 | 不做 |
| IRC / peer messaging | DSH 没有点对点总线；不引入 | 不做 |
| Rust 工具 / TUI / provider 栈 / browser / desktop | DSH 已有对应能力 | 不做 |
| 自动从 `.claude/.codex` 导入 agent | 先做格式/权限审计，不默认开启 | 延后 |

---

## 3. 分阶段方案

### P0（已完成）

- `/coharness fleet`：从实时 DSH 目录 + 已挂载 OMD-Slim 配置生成 Native 角色路由；
- `/coharness fleet --apply`：只写 provider/model/execution，保留 tools/deny/MCP/persona，写入前备份；
- `/coharness status`：native 行显示实际 `provider/model`，并对照目录标出不可用；
- `/coharness demo`：确定性工作区 + 可粘贴 prompt；
- profile 分区、跨进程 Lane 锁、持久结果/unknown、工作图、邮箱、CLI 分类；
- Runtime 设置卡、逐 Lane 清除、项目权限下限、dispatch fallback、worktree action。

### P1：结果契约 + 生命周期（下一批优先）

目标：主控能回答“这个角色做完了吗、用了什么模型、产物在哪、验收过了吗”，并且在 Host 重启后不撒谎。

1. **`RoleResult` 信封**（不新增 runtime）：
   ```json
   {
     "taskId": "…",
     "roleId": "oracle",
     "surface": "native | provider:codex",
     "provider": "zai-coding-cn",
     "model": "glm-5.3",
     "resolvedModel": "glm-5.3",
     "state": "running | idle | completed | failed | cancelled | unknown",
     "startedAt": "…",
     "endedAt": "…",
     "usage": { "inputTokens": 0, "outputTokens": 0 },
     "artifacts": ["docs/report.md"],
     "structured": { "schema": "…", "valid": true, "data": {} },
     "error": { "code": "…", "message": "…" }
   }
   ```
   Native 角色从 DSH child 的 session/事件里取；外部角色从 provider receipt 取。JSON 写进 session artifact，工具结果只放摘要 + 引用。
2. **状态投影**：`running / completed / failed / cancelled / unknown`。`unknown` 是合法结果：Host 重启后找不到 receipt 就显示 unknown，不补造 completed。
3. **取回与继续**：`subagent_result` 读结果；`send_message` 继续；`interrupt_agent` 取消；外部 child 仍不能 `send_message`。不新增 `wait` 工具，依赖宿主完成通知。
4. **验收门禁**：角色结果必须带 `acceptance` 证据；主控不能在没有 verifier 结果时把任务标完成。
5. **持久化**：外部结果索引已迁到 parent session 的 durable catalog；崩溃/重启后能恢复或明确 unknown。
6. **测试**：重启恢复、并发 Lane、取消后状态、结果信封字段、未知不伪装。

**P1 建议的文件级拆分：**

| 文件 | 改动 |
|---|---|
| `integration/role-result.js`（新增，纯函数） | `createRoleResult()` / `mergeResultEvent()` / `validateRoleResult()` |
| `integration/result-store.js`（新增） | 挂在父 session 的 append-only 结果目录；重启后返回 unknown |
| `integration/status.js` | 把 DSH child 状态投影成五态 |
| `src/index.js` | `coharness` 新增 `result` 读取与 `graph` 查询 |
| `vendor/omd/npm-package/preset/subagent-result.js` | 把 child session 的 `resolvedModel/usage/artifacts` 映射进信封 |
| `test/integration/role-result.test.mjs`（新增） | 五态投影、重启 unknown、跨父会话拒绝 |

> 关键约束：**不要**在 `integration/` 里再造一个 subagent runtime。所有状态来自 DSH 的 `agent/*` 事件或 session 日志；OMC 只做投影和持久化。

### P2：任务图 + 写入隔离

1. **Work graph**：节点 `{id, roleId, deps[], writeScope[], acceptance[], state}`；已由 `integration/graph.js` 实现，存进 profile 状态，不另建调度器。
2. **写入互斥**：同一时刻只允许一个写节点；写范围是路径前缀 + DSH sandbox/approval 双重检查；外部 Fixer 继续禁止。
3. **Worktree**：已提供 `coharness worktree` + 显式 merge；仍是 session-wide，per-child worktree 依赖 DSH。
4. **Council**：席位是图节点，合成器永远 native；每个席位产出结构化意见，失败席位进入报告。

### P3：角色定义 + 模型回退 + 观察面

1. **项目/用户角色定义**：frontmatter 风格，字段子集；优先级明确；项目配置不能扩大执行权限；卸载清理；冲突校验。
2. **模型回退**：角色级显式链；错误分类；跨计费通道必须显式授权；不静默把订阅切到 API。当前 dispatch 已有显式 fallback，角色工具还没有。
3. **观察面**：DSH 现有子 Agent 面板 + OMC roster；不做第二套 TUI。
4. **Advisor / Observer**：等附件转发与视觉模型目录就绪。

### P4：多 Harness 协同（下一阶段）

前置条件：P1 的 `RoleResult` 与状态投影稳定，P2 的写隔离可用，外部 Harness 至少两个完成真实验收。

- 外部 Harness 只作为**结果生产者**，不成为第二个调度器；
- 所有外部结果进入同一 `RoleResult` 信封；
- 只读等级（enforced / advisory）与计费授权继续强制；
- 跨 Harness 不共享对话，只通过主控交接事实；
- 先做“同一任务两个只读席位并行”，再做“外部只读 → 原生 Fixer”的固定管道。

---

## 4. 不要做的事

1. **不要复制 OMP 的运行时**（TUI、Rust 工具、provider 栈、隔离 PAL）。DSH 已经拥有这些。
2. **不要引入 Agent 间点对点总线**。DSH 的模型是“主控交接”，OMC 应保持这一点；持久 mailbox 只是跨重启补充。
3. **不要把“结果文本”当结构化结果**。先有 schema/valid/artifacts，再谈自动验收。
4. **不要让项目配置默认扩大权限**。项目可以收紧 spawn/model/write scope，不能悄悄放宽。
5. **不要用功能百分比汇报**。用“可执行验收”作为发布门槛。

---

## 5. 验收矩阵（后续版本）

| # | 能力 | 通过条件 | 证据 |
|---|---|---|---|
| 1 | Native fleet | 每个启用角色有唯一/可解释路由；目录缺失有明确提示 | `fleet` 输出 + `status` |
| 2 | RoleResult | native/external 都返回统一信封；字段可被 JSON 校验 | 单测 + 真会话 |
| 3 | 生命周期 | running/completed/failed/cancelled/unknown 五态；重启后 unknown 不伪装 | 重启测试 |
| 4 | 结果取回 | 同一父会话可重读；别的父会话不可见 | 权限测试 |
| 5 | 验收门禁 | 无 verifier 证据不能标完成 | 负例测试 |
| 6 | 任务图 | 依赖顺序、写互斥、失败传播可见 | 两节点/三节点场景 |
| 7 | 写入隔离 | 两个 worktree 独立写入后合并；冲突保留 | git 前后哈希 |
| 8 | 模型回退 | 429/配额/认证失败分类正确；计费门控不被绕过 | 失败注入 |
| 9 | 外部 Harness | 至少两个 CLI 真实验收；只读 enforced | 脱敏 argv/输出 |
| 10 | 多 Harness | 两个只读席位并行 + 原生 Fixer 管道 | 全链路会话 |

---

## 6. 一句话结论

OMP 证明了一件事：**多 Agent 产品的护城河不是角色 Prompt，而是结果契约、生命周期和隔离**。OMC 已经有 DSH 提供的 runtime，下一步不该继续堆角色或接更多 CLI，而应把“角色执行”变成可验证、可恢复、可合并的结果对象；多 Harness 等这条链路稳定后再回来做。
