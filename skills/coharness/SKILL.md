---
name: coharness
description: Route real work to an external AI coding CLI (Codex, Claude Code, Gemini, Kimi, opencode) through the coharness tool, and integrate its result honestly.
whenToUse: The user names a specific external CLI or agent ("让 codex 看下", "ask Claude Code", "用 Gemini 独立评审"), wants an independent second opinion from another agent, or the work fits another toolchain better than this session.
---

# CoHarness 派发纪律

你有两套入口，但它们属于**同一个插件、同一个 Orchestrator**：

- `subagent_*`：内置专业角色。默认是 DSH 原生子 Agent（可续接、同会话模型）；如果用户把某个角色配成外部后端，它会在同一次调用里启动 CLI，但变成一次性、只读。
- `coharness`：直接派发工具。用于点名某个 CLI、显式 `mode`、`tasks[]` 并行、或不属于任何内置角色的临时任务。

外部 CLI 都运行在独立进程里，看不到这段对话，用的是它们自己的模型和登录。

## 相关的 Skill（按需加载，不要一次全加载）

| 要做什么 | 加载 |
|---|---|
| 让两个不同模型独立评审同一件事，再由你合成 | `coharness-council` |
| 多阶段任务：计划、实现、审查、验证，带门禁 | `coharness-ulw` |
| 决定需要什么证据、收集真实退出码后再宣布完成 | `coharness-verify` |
| 一个都还没装、或 doctor 全是 `missing` | `coharness-setup` |

这个 Skill 讲派发本身；上面三个讲怎么把派发组织成一次可信的工作。

## 什么时候该派发

- 用户点名了某个 CLI 或 agent（用 `coharness`，`harness` 指定名字）。
- 用户要「另一个 agent 独立看一下」——独立性的价值在于**它没有你的上下文偏见**。
- 任务适合某个角色，且该角色的后端已配置：直接用 `subagent_oracle` / `subagent_explorer` / Council 席位。
- 任务的工具链更合适：目标仓库是 Rust 而你想让 Codex 做，或需要某个 CLI 自带的检索能力。
- 任务足够长，你想在后台跑完再整合。

## 什么时候不要派发

- 任务需要这段对话里的隐性上下文，而你无法用几句话说清。
- 用 DSH 自己的 `subagent` 就够（同一模型、能继承上下文、能续接）——外部 CLI 是一次性执行，不能追问。
- 只是「多跑几个 agent 显得更努力」。默认单 Agent，并行只在任务真的可以切分时用。

## 怎么派发

1. 不确定有什么可用时，先 `coharness({ action: "list" })`（免费，不花配额）；看角色后端用 `coharness({ action: "status" })`。
2. 写**自包含**的任务：背景、目标、工作目录、要读的文件、约束、验收标准。它看不到对话，也不会猜你的意图。
3. `mode` 默认 `read-only`。要它改文件必须显式 `in-place`，并且先告诉用户「这会用该 CLI 自己的权限写文件」；in-place 会走 `surface: direct`。
4. 多个**互不依赖**的任务放进一次调用的 `tasks[]`，那是真并行；有先后依赖的必须分次调用。
5. `delivery: "await"` 拿回结果再往下走；`delivery: "background"` 只拿回一个 child id。
6. 一次调用最多 `maxParallel` 个任务（默认 4，上限 8）。超过会抛 `OMC/TOO-MANY-TASKS`，**不会**静默丢弃——拆成多次调用。

## 只读到底有多强

`mode: 'read-only'` 不是同一种强度，报告里要说清：

| 强度 | Harness | 含义 |
|---|---|---|
| **强制沙箱（enforced）** | `codex`（`-s read-only`）、`gemini`（`--approval-mode plan` + `--skip-trust`）、`antigravity`（`--sandbox`） | CLI 自己拒绝写入 |
| **仅 advisory** | `opencode`、`kimi`、`glm`/`claude` | 我们只声明意图，CLI 仍可能按其默认权限写入 |
| **unsupported** | 未验证的 argv 形态 | 不能承担只读角色 |

评审优先用强制沙箱的三个。用 advisory 的 CLI 做「只读」评审时，要提醒用户「它可能仍会写文件」。

**内置角色的 `omc:*` Provider 固定只读**，不受全局 `dispatch.defaultMode` 影响。`coharness` 的 in-place 只走 direct surface。

## 完成后怎么写

- 说明是谁做的：`Codex` 做的就不要写成你做的。
- 退出码非 0、超时、输出被裁剪，都要说出来。
- **只有拿到真实结果或完成通知，才能说「完成」。** `started subagent <id>` 不是完成，是开始。
- 没有测试、没有 diff、没有 commit 的「我做完了」只是被派发方的声明，转述时必须标明这是它的说法。

### surface：结果从哪条路径回来

每个结果都带 `surface`，它决定你能向用户承诺什么：

| surface | 含义 | 你能说什么 |
|---|---|---|
| `provider` | 走宿主 `ctx.subagents`，有 `childId` | 有子会话、有容量、有完成通知；取消由宿主负责 |
| `direct` | 直接起进程的降级路径 | **没有 childId、没有宿主容量、没有子会话面板**；取消靠进程信号 |

走 `direct` 时结果里还会有 `downgradeReason`（例如「`mode: in-place` needs the direct surface: omc providers are fixed read-only」）。报告里要原样说明降级原因，不要把 direct 当成完整能力。

## 失败怎么办

| 现象 | 处理 |
|---|---|
| `OMC/CLI-MISSING` | 这个 CLI 没装。加载 `coharness-setup`，给出官方安装命令，不要重试 |
| `OMC/CLI-TIMEOUT` | 任务太大或 CLI 卡住。缩小范围或调大 `timeoutMs`，不要原样重跑 |
| 宿主报容量已满 / `capacity` | 并发满了。减少 `tasks` 数量，或等一个完成 |
| `OMC/TOO-MANY-TASKS` | 一次调用超过 `maxParallel`。按错误里给的数字**拆成多次调用**，不要删掉任务 |
| `OMC/PARALLEL-WRITE` | 一次调用里有多个 `in-place` 任务。单写者限制：**逐个调用**，不要并行写 |
| `OMC/BACKGROUND-UNSUPPORTED` | direct 路径没有后台完成通知。改成 `delivery: 'await'`，或改为只读 + 同步 |
| 退出码非 0 | 读 stderr 尾部判断是环境问题还是任务失败，不要直接重试 |
| `auth: unknown` | 认证状态未确认。不要断言「已登录」，让用户自己跑一次 CLI 验证 |

## 内置角色与外部执行（同一个插件）

Oh My CoHarness 自带 OMD 的完整角色系统。**只有一个主编排者**：本会话的 Orchestrator。

- 内部角色（同模型、可续接、有角色 prompt）→ 用 `subagent_oracle` / `subagent_explorer` / `subagent_fixer` / `subagent_designer` / `subagent_librarian` / `subagent_council`。
- 某个角色被用户配成外部后端时，同一个工具会启动 CLI：**一次性、只读、不能 `send_message` 追问**。工具描述会写明后端和只读等级。
- 不属于内置角色的临时外部任务 → 用 `coharness`。
- **同一个任务不要在内置角色和 `coharness` 两边各跑一次。** 选一边，说清理由。
- 外部 Agent 之间没有点对点通道；所有结果回到主控，由主控判断依赖再决定下一步。
- 外部角色工具报 `OMC/EXECUTION-*` 时，不要重试或改回 native：运行 `/coharness doctor`，让用户启用 Harness、修配置，或明确选择 native。
- `coharness` 的 `list` / `status` / `doctor` 都是免费的；`status` 最适合回答「这个角色现在跑在哪」。

## 隐私

任务文本会发给那个 CLI 自己的服务商，按它自己的条款处理。不要把密钥、内部凭证、与任务无关的私有内容放进 prompt。派发前如果任务里要贴代码，只贴必要的部分。
