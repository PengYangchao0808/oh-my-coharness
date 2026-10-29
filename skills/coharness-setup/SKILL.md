---
name: coharness-setup
description: Walk a user from "coharness found nothing" to a first successful dispatch, using the diagnostic report and each CLI's own official install and login steps.
whenToUse: coharness reports a missing CLI, an unknown auth state, an unavailable WSL, or the user asks how to make Oh My CoHarness work.
---

# CoHarness 安装与登录引导

目标：让用户在一次对话里从「什么都没发现」走到「跑通一次只读任务」。不要跳步，不要替用户跑会要凭证的命令。

## 第一步：先看诊断（免费）

```
/coharness doctor
```

或 `coharness({ action: "doctor" })`。报告里的每一行是一个 harness：

```
harness     transport  version   auth         state
codex       native     0.151.0   unknown      usable
kimi        -          -         missing      missing
wsl         -          -         -            unavailable (Wsl/E_ACCESS_DENIED)
```

- `state: missing` → 没装，给安装命令。
- `state: usable` 但 `auth: unknown` → 装了，但认证状态未知。**不要**说「已登录」。
- `state: degraded` → 能跑但有附加条件，读括号里的原因。
- `wsl: unavailable` → WSL 这一层不可用；有 native 就先用 native。

## 第二步：安装（不花模型费用）

一个就够，两个才能「独立评审」：

```
npm i -g @openai/codex
npm i -g @anthropic-ai/claude-code
npm i -g @google/gemini-cli
npm i -g @moonshot-ai/kimi-code
npm i -g opencode-ai
```

装完**重启 DSH**，再跑一次 doctor。不要在这台机器上替用户装，除非用户明确要求；也不要顺手装 pnpm / nvm 之类无关的东西。

## 第三步：登录

登录必须由 CLI 自己完成，且必须在用户自己的终端里：

- 告诉用户「在你的终端里运行 `codex login`（或该 CLI 的登录命令），按提示完成」。
- **绝不要**让用户把 token、API key、cookie 贴进对话。
- **绝不要**去读 `~/.codex`、`~/.claude`、`~/.gemini` 里的凭证文件。
- 登录完成后 doctor 的 `auth` 可能仍然是 `unknown`（很多 CLI 没有稳定的状态子命令）。这是正常的：以「能不能跑通一个只读任务」作为最终判据。

## 第四步：验证

派一个真正无害、能立刻判定对错的任务：

> 用 `coharness` 让 codex 读 `README.md`，用三句话概括它，不要修改任何文件。

成功标准：返回了针对这个仓库的真实内容，而不是「我需要更多信息」。

## WSL 场景

- 先确认整体可用：`wsl -l -v` 能列出发行版。若返回 `Wsl/E_ACCESS_DENIED`，说明 WSL 这一层没配好，先解决系统的 WSL，不要继续。
- 装发行版：`wsl --install -d Ubuntu`。
- 在发行版里装 CLI，并确认 `command -v codex` 有输出。
- 需要固定发行版时设 `DSH_WSL_DISTRO`（与 dsh-wsl 插件同一约定）。
- 注意：WSL 里的路径与 Windows 路径不同，任务是相对路径时以 `cd` 后的位置为准。

## 收尾

- 说明改了什么：只写了插件自己的配置，没有动用户的 CLI 或认证。
- 说明下一步：在任意会话里直接说「用 codex 读一下 X」。
- 如果用户装不下某个 CLI，明确说「这个 harness 不可用」，并给出其余可用选项，**不要**用假的成功结果收尾。
