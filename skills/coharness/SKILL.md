---
name: coharness
description: Route real work to an external AI coding CLI (Codex, Claude Code, Gemini, Kimi, opencode) through the coharness tool, or pin the native specialist roles to models DSH can already call; integrate the result honestly.
whenToUse: The user names a specific external CLI or agent ("让 codex 看下", "ask Claude Code", "用 Gemini 独立评审"), wants an independent second opinion from another agent, the work fits another toolchain better than this session, or asks for a native multi-model demo ("复用现有 DSH 模型", "先跑个 demo", "不要外部 CLI").
---

# CoHarness 派发纪律

你有两套入口，但它们属于**同一个插件、同一个 Orchestrator**：

- `subagent_*`：内置专业角色。默认是 DSH 原生子 Agent（可续接、可指定角色模型）；外部后端每次创建独立 CLI 运行，但同角色、cwd、Lane 的下一次委派可恢复受支持的 CLI 原生会话，仍然只读。
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

## 多阶段工作：先建图，再派发

多角色任务不要只靠对话记忆。先建一个父会话工作图：

```js
coharness({ action: "graph", graph_action: "plan", nodes: [
  { id: "explore", role: "explorer" },
  { id: "review", role: "oracle", deps: ["explore"], acceptance: ["names the failing line"] },
  { id: "fix", role: "fixer", deps: ["review"], write: true, writeScope: ["src/"] },
  { id: "verify", role: "oracle", deps: ["fix"], acceptance: ["tests pass"] }
]})
```

派发前 `graph claim`；完成后 `graph complete` 必须带 acceptance 的 evidence；写节点还必须给 `changed_files`，越出 `writeScope` 会被判 failed。不要用“子代理说完成了”代替 evidence。

## Agent 消息与任务复用

- 原生 child 优先用宿主 `send_message`；`coharness send` 是持久留言的补充，成功原生投递会标记 `delivery: native`，失败则留在 mailbox。
- `subagent_result` 返回 `roleId/state/complete=false/capturedThroughSeq/readAt`；读到最新消息不等于已结算，缺少 own message 时是 `state:"unknown"`。
- 外部 child 运行中不能实时 steer；`send` 会排队。下一次同 Lane 的委派前，用 `inbox`/`thread`/`reuse` 把未读消息放进新 prompt。
- `reuse` 返回持久任务、相关消息和继续方式；不要把 external child id 传给 `send_message`。
- 逐 Lane 清除引用：`/coharness sessions --clear --lane=<id>`。

## 会话预设快照

`coharness({action:"preset", preset_action:"snapshot"})` 记录当前父会话实际生效的 OMC 角色配置；`status` 对比当前全局配置，固定返回 `hotSwitch:false`。DSH 首轮后锁定 agent preset，保存设置不是热切换，已创建的 child 也不会被改写。

## 自定义外部角色模板

`coharness({action:"role", role_action:"add", role_id:"security-reviewer", title:"Security reviewer", persona:"…", role_harness:"codex"})` 可注册一个 named external read-only 模板；`<cwd>/.omc/roles.json` 可放项目级模板（数组或 `{roles:[]}`）。`role_action:"run"` 用 `text` 传任务。只允许 enforced read-only harness（codex/gemini/antigravity 等），advisory CLI 会被拒绝；可声明 `role_model` 和 `role_fallbacks`（最多 3 个），非 enforced 的 fallback 会被跳过并显示说明。项目里的 `readOnly:false` 会被归一成只读。它不是 native 角色，不会出现在 `subagent_*` 工具里，也不能写文件。

## 项目权限与 worktree

- 项目可以在 `<cwd>/.omc/project.json` 里**收紧**外部 dispatch：禁用 harness、降低并发/超时、强制 read-only、关闭 direct fallback/routing/计费授权。项目不能启用或放宽；`coharness({action:"project", cwd})` 查看实际生效策略。
- `coharness({action:"worktree", name})` 调用 DSH worktree 创建并进入 session-wide checkout；`dispatch` 的 `mode:"worktree"` 则给每个外部任务创建 disposable branch checkout，CLI 在那里写，结果返回 branch/path/files/diff，不自动合并。merge 时可加 `require_acceptance:true` + `node_id`，先要求 graph 节点 completed 且有 acceptance evidence。native child 仍没有 per-child cwd，外部 Fixer 仍禁止直接写用户工作树。

## 原生多模型 demo（先走这条，别用外部 CLI 代替）

用户说“先用现有 DSH 模型跑个 demo”“不要外部 CLI”“复用 OMD 的配置”时：

1. `coharness({action:"fleet"})` 预览角色 → provider/model；它读实时 DSH 目录，并优先继承仍挂载的 OMD-Slim 配置。没有写配置。
2. `coharness({action:"fleet", apply:true})` 才写入；只改 `provider/model/execution`。不要手写角色模型配置。
3. `coharness({action:"demo"})` 生成确定性工作区并返回可粘贴的 prompt；它不自动调模型。
4. 让用户在 Oh My CoHarness 会话里执行 prompt；结束后用 `status` 核对实际路由。

不要把“demo 已生成”说成“多模型协作已通过”。通过标准是：三条测试通过 + `status` 显示预期路由 + 报告里有 Explorer/Oracle/Fixer 的实际输出。

## 什么时候不要派发

- 任务需要这段对话里的隐性上下文，而你无法用几句话说清。
- 用 DSH 原生角色就足够，或任务必须实时来回沟通：外部 CLI 不能接收运行中的 send_message，完成后才能再次按 Lane 委派。
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

- 内部角色（可配置不同模型、可续接、有角色 prompt）→ 用 `subagent_oracle` / `subagent_explorer` / `subagent_fixer` / `subagent_designer` / `subagent_librarian` / `subagent_council`。
- 外部后端：同一个角色工具启动 CLI，仍然只读，不能向外部 child id 发送 `send_message`。后续任务再次调用相同工具、相同 cwd/lane、新 prompt；以结果中的 session new/resumed 为准，不能预先承诺恢复成功。
- 不属于内置角色的临时外部任务 → 用 `coharness`。
- **同一个任务不要在内置角色和 `coharness` 两边各跑一次。** 选一边，说清理由。
- 外部 Agent 之间没有点对点通道；所有结果回到主控，由主控判断依赖再决定下一步。
- 外部角色工具报 `OMC/EXECUTION-*` 时，不要重试或改回 native：运行 `/coharness doctor`，让用户启用 Harness、修配置，或明确选择 native。
- `coharness` 的 `list` / `status` / `doctor` 都是免费的；`status` 最适合回答「这个角色现在跑在哪」。

## 外部工作方向与结果控制

- 外部角色可传 `lane`、`context_summary`、`changed_files`、`artifact_refs`、`acceptance`。只交接已验证事实；路径必须相对工作区，不能用 `..`。过大的交接会失败，应缩小范围。
- 同一工作方向再次使用相同 Lane；独立任务使用不同 Lane。默认 Lane 是角色 × 项目，不按父聊天隔离；需要聊天独立时在 Lane 中带上聊天标签。
- `coharness({action:"tasks"})` 找回本父会话的外部 Provider child id；`result` 配 `task_id` 重读结果，不唤醒模型；`cancel` 配 `task_id` 通过宿主请求中断。它们是工具 action，不是新的斜杠命令。
- cancelled 请求不等于完成；等待真实结算再启动替代或依赖任务。Host 重启后内存结果索引消失，持久 CLI 会话引用仍可复用；`surface:direct` 没有 child receipt。
- 原生孩子继续使用 `list_agents/send_message/subagent_result/interrupt_agent`；`subagent_result` 的最新消息本身也不等于结算。

## 隐私

任务文本会发给那个 CLI 自己的服务商，按它自己的条款处理。不要把密钥、内部凭证、与任务无关的私有内容放进 prompt。派发前如果任务里要贴代码，只贴必要的部分。
