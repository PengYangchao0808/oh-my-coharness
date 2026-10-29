# OMC / OMD / DSH 拓扑结构（v0.3.0）

> 这份图回答三个问题：**谁在哪个进程里、谁能调用谁、为什么有些工具只在某些会话里出现。**
> 相关：[`ROLE-ROUTING.zh-CN.md`](./ROLE-ROUTING.zh-CN.md) · [`ACCEPTANCE-V0.2.md`](./ACCEPTANCE-V0.2.md)

## 1. 一页总览

一个 DSH Desktop = **一个 Host 进程**。所有插件都装在这个进程里；agent preset 决定「一个会话能看见什么工具」。
外部 CLI 是**另起的进程**，由 provider 拉起来。

```text
+---------------------------------------------------------------------------------------------+
| DSH Desktop — ONE Host process (Cordis loader)                                              |
|                                                                                             |
| profile "desktop" = [dsh-base] + [dsh-web-app] + [oh-my-dsh-slim@0.8.6]                     |
|                                                   + [oh-my-coharness@0.3.0]  (link)         |
|                                                                                             |
| HOST SERVICES   tools | subagents | systemPrompt | skills | commands | subprocess | ...      |
|                                                                                             |
|   OMC host plugin  (oh-my-coharness)                                                        |
|     tool        coharness            dispatch / list / doctor                               |
|     command     /coharness doctor                                                           |
|     skills      coharness, -setup, -council, -ulw, -verify      (global, every session)      |
|     providers   omc:codex  omc:opencode  omc:kimi  omc:antigravity  omc:glm  omc:gemini     |
|                                                                                             |
|   SLIM host plugin  (oh-my-dsh-slim)                                                        |
|     preset      "Roles & Council"   (shown as 极简角色委派)                                  |
|     settings card, profile registry                                                         |
+---------------------------------------------------------------------------------------------+
        |                                |                                    |
        v                                v                                    v
  Session A (preset standard)   Session B (preset omc-harness)        Session C (preset slim)
  tools: read/write/bash/...    same coding surface +                 subagent_oracle/designer/
  delegation: subagent(spawn)   subagent_codex / _antigravity /       fixer/explorer/librarian,
            subagent_fork       _opencode / _kimi                     council
  provider: spawn/fork          provider: omc:<id>                   provider: spawn (hard-coded)
```

三句话记住：

1. **Host 层是共享的**：`coharness` 工具、`omc:*` provider、五个 Skill 在所有会话里都存在。
2. **preset 层是会话私有的**：`subagent_*`（slim）和 `subagent_<harness>`（OMC preset）只在选了这个 preset 的会话里出现。
3. **外部 CLI 是进程**：无论从哪个前门进来，最后都是 provider 在 WSL 里起一个 CLI 进程。

## 2. 两条委派通路

```text
model-facing call
       |
       +---------------------------+---------------------------+
       |                                                       |
coharness({action:'dispatch'})                       subagent_<harness>({prompt})
(any preset, host tool)                              (only in the omc-harness preset)
       |                                                       |
src/dispatch.js                                      host stock tool-subagent
       |                                                       |
       +---------------------------+---------------------------+
                                   |
                     ctx.subagents.startActivation({ provider })
                                   |
              +--------------------+--------------------+
              |                                         |
        omc:<id> provider                        spawn / fork provider
        (src/provider.js)                        (DSH built-in, in-process)
              |
     wsl.exe -e bash -lc "codex exec ..."
              |
     external CLI process  (WSL Ubuntu)
```

同一张图换个角度：

| 通路 | 前门 | provider | 子 Agent 在哪 | 能续接 | 写入 |
|---|---|---|---|---|---|
| 外部（显式） | `coharness` | `omc:<id>` | 独立 CLI 进程 | 否 | 只有显式 `mode:'in-place'` |
| 外部（角色） | `subagent_<harness>` | `omc:<id>` | 独立 CLI 进程 | 否 | **永远不能**（provider 固定只读） |
| 内部 | `subagent` / `subagent_fork` | `spawn` / `fork` | 本进程 | 是 | 受 DSH sandbox/approval |
| slim 角色 | `subagent_oracle…` | `spawn`（写死） | 本进程 | 是 | 角色策略限制 |

## 3. 谁能调用谁

| 调用方 | 被调用方 | 允许？ | 说明 |
|---|---|---|---|
| 主 Agent | `coharness` | ✅ | 宿主工具，任何 preset 可见（除非 preset 限制） |
| 主 Agent | `subagent_<harness>` | ✅ | 仅 `omc-harness` preset |
| 主 Agent | `subagent_oracle…` | ✅ | 仅 slim preset |
| 主 Agent | `subagent` / `subagent_fork` | ✅ | standard / omc-harness 都有 |
| slim 角色子 Agent | `coharness` | ❌ | 子角色工具白名单里没有它；外部 CLI 也无法回调 DSH |
| 外部 CLI | DSH / 其它 CLI | ❌ | one-shot，没有回传通道，也没有点对点网络 |
| SLIM 插件 | OMC provider | ❌ | 它把 `provider: 'spawn'` 写死在角色行里 |
| OMC 插件 | slim 角色 | ❌ | 不注册、不包装、不调用，避免两个编排者 |

## 4. 三个 preset 给什么

| | `standard`（内置） | `omc-harness`（OMC 0.3.0） | `极简角色委派`（slim） |
|---|---|---|---|
| 编码工具面 | 全套 | 与 standard 相同 | 全套 + 角色化 |
| 委派工具 | `subagent`、`subagent_fork` | 同左 **+** `subagent_codex / _antigravity / _opencode / _kimi` | `subagent_oracle / _designer / _fixer / _explorer / _librarian` |
| 子 Agent 后端 | `spawn` / `fork` | 外部 CLI（`omc:<id>`） | `spawn`（写死） |
| 角色人格 | 无 | 写在 persona 里的工具说明 | 每个角色一套 persona + 工具白名单 |
| 能否追问 | 能 | **不能** | 能（background-first、`send_message`） |
| 会话里能看到 `coharness` | ✅ | ✅ | ✅（宿主工具） |

> 选择规则：想「让 Codex 当 oracle」→ 用 `omc-harness`；想「同一模型分角色、能追问」→ 用 slim preset。
> 两个 preset 的角色工具**不会同时出现**，这是宿主的会话作用域，不是 bug。

## 5. 东西都在哪

| 东西 | 归属 | 作用域 |
|---|---|---|
| `coharness` 工具、`/coharness doctor` | OMC Host 插件 | 全局（所有会话） |
| 5 个 Skill | OMC Host 插件（`ctx.skills`） | 全局 |
| `omc:<id>` provider | OMC Host 插件（`ctx.subagents.registerProvider`） | 全局 |
| `subagent_<harness>` 工具 | OMC bundle patch 里的 preset 声明 | 仅 `omc-harness` 会话 |
| `subagent_oracle…` | slim 的 preset | 仅 slim 会话 |
| `subagent` / `subagent_fork` | 内置 preset 声明 | standard / omc-harness |
| CLI 探测与 argv | `src/transport.js` + `src/harnesses.js` | 进程内 |
| 配置（surface / dispatch / harnesses） | profile 的 `cordis.patch.yml` | profile |
| preset 声明 | 本仓库 `cordis.patch.yml` | bundle |

## 6. 一次运行的真实走向

**Council（两个外部 CLI 独立评审）**

```text
主 Agent → coharness({tasks:[codex, glm], mode:'read-only'})
        → dispatch.js 为每个 task 解析 harness
        → ctx.subagents.startActivation(provider:'omc:codex')   ─┐ 两个 child session
        → ctx.subagents.startActivation(provider:'omc:glm')     ─┘ 并行、各计容量
        → provider.start() 在 WSL 起两个 CLI 进程
        → 结果回到主 Agent，主控合成共识/分歧
```

**角色委派（`omc-harness` preset）**

```text
主 Agent → subagent_codex({prompt:'You are the oracle: …'})
        → 宿主 stock tool-subagent（不经过 coharness）
        → ctx.subagents.startActivation(provider:'omc:codex')
        → provider.start() 以只读模式起 codex exec
        → 结果作为该 child 的最终消息回到主 Agent
```

**唯一的写入路径**

```text
主 Agent → coharness({mode:'in-place', cwd, prompt})
        → provider 不可用（默认 mode 是 read-only）→ surface: direct
        → src/transport.js 直接 spawn CLI
        → 没有 childId / 容量 / 子会话面板；单写者（OMC/PARALLEL-WRITE）
```

## 7. 五个常见混淆

1. **「装了 slim，为什么 doctor 说 not detected？」**
   `subagent_*` 是 agent/preset 作用域的工具，host 作用域的 `ctx.tools.get()` 看不到。检测不到 ≠ 未安装，
   所以 doctor 永远只写 `not detected (may be scoped)`。

2. **「为什么 `coharness` 写文件时没有子会话？」**
   provider 的默认 mode 是 read-only，per-call 的 `in-place` 走不了 provider，只能 direct（`surface: direct`）。

3. **「为什么角色工具不能写文件？」**
   `subagent_<harness>` 没有 mode 参数，provider 固定用 `dispatch.defaultMode`。这是设计，不是遗漏。

4. **「为什么切了 preset 就看不到另一套角色工具？」**
   preset 决定会话的工具面；两套角色工具属于两套互斥的声明。

5. **「OMC 和 slim 会互相调用吗？」**
   不会。它们唯一的汇合点是主 Agent；外部 Agent 之间没有点对点通道。
