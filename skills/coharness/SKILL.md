---
name: coharness
description: Route real work to an external AI coding CLI (Codex, Claude Code, Gemini, Kimi, opencode) through the coharness tool, and integrate its result honestly.
whenToUse: The user names a specific external CLI or agent ("让 codex 看下", "ask Claude Code", "用 Gemini 独立评审"), wants an independent second opinion from another agent, or the work fits another toolchain better than this session.
---

# CoHarness 派发纪律

你有一个工具 `coharness`，可以把任务交给**本机已安装的外部 AI 编程 CLI**。它们运行在独立进程里，看不到这段对话，用的是它们自己的模型和登录。

## 什么时候该派发

- 用户点名了某个 CLI 或 agent。
- 用户要「另一个 agent 独立看一下」——独立性的价值在于**它没有你的上下文偏见**。
- 任务的工具链更合适：目标仓库是 Rust 而你想让 Codex 做，或需要某个 CLI 自带的检索能力。
- 任务足够长，你想在后台跑完再整合。

## 什么时候不要派发

- 任务需要这段对话里的隐性上下文，而你无法用几句话说清。
- 用 DSH 自己的 `subagent` 就够（同一模型、能继承上下文、能续接）——外部 CLI 是一次性执行，不能追问。
- 只是「多跑几个 agent 显得更努力」。默认单 Agent，并行只在任务真的可以切分时用。

## 怎么派发

1. 不确定有什么可用时，先 `coharness({ action: "list" })`（免费，不花配额）。
2. 写**自包含**的任务：背景、目标、工作目录、要读的文件、约束、验收标准。它看不到对话，也不会猜你的意图。
3. `mode` 默认 `read-only`。要它改文件必须显式 `in-place`，并且先告诉用户「这会用该 CLI 自己的权限写文件」。
4. 多个**互不依赖**的任务放进一次调用的 `tasks[]`，那是真并行；有先后依赖的必须分次调用。
5. `delivery: "await"` 拿回结果再往下走；`delivery: "background"` 只拿回一个 child id。

## 完成后怎么写

- 说明是谁做的：`Codex` 做的就不要写成你做的。
- 退出码非 0、超时、输出被裁剪，都要说出来。
- **只有拿到真实结果或完成通知，才能说「完成」。** `started subagent <id>` 不是完成，是开始。
- 没有测试、没有 diff、没有 commit 的「我做完了」只是被派发方的声明，转述时必须标明这是它的说法。

## 失败怎么办

| 现象 | 处理 |
|---|---|
| `OMC/CLI-MISSING` | 这个 CLI 没装。加载 `coharness-setup`，给出官方安装命令，不要重试 |
| `OMC/CLI-TIMEOUT` | 任务太大或 CLI 卡住。缩小范围或调大 `timeoutMs`，不要原样重跑 |
| `OMC/CAPACITY` | 并发满了。减少 `tasks` 数量，或等一个完成 |
| 退出码非 0 | 读 stderr 尾部判断是环境问题还是任务失败，不要直接重试 |
| `auth: unknown` | 认证状态未确认。不要断言「已登录」，让用户自己跑一次 CLI 验证 |

## 隐私

任务文本会发给那个 CLI 自己的服务商，按它自己的条款处理。不要把密钥、内部凭证、与任务无关的私有内容放进 prompt。派发前如果任务里要贴代码，只贴必要的部分。
