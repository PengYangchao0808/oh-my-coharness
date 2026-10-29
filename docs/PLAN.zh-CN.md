# Oh My CoHarness 开发方案 v2.1

> 面向 DSH 插件市场的跨 Harness 协作层
> 基于 2026-10-29 对本机安装（DSH Desktop 0.2.1-rc.3）与公开生态的实测核查编写。
> 文中「已验证」= 我在这台机器上读到或跑到的结果；「未验证」= 只有文档/README 依据，需要在实现前用 30 分钟确认。

---

## 0. 结论摘要

1. **方向成立，但 v2.0 有三处事实需要修正**，其中两处会直接改变架构决策：
   - DSH **没有官方插件市场索引**。Discover 只读取「用户自己添加的索引 URL」；市场是社区索引（`dsh-plugin-catalog` / dshbase / dsh-market），不是 npm 发布会自动出现的地方。
   - 本机 Desktop **不包含任何外部 subagent provider**（`dsh-subagent-acp`、codex、claude-code 三个包都不存在），只装了 `spawn` 和 `fork` 两个进程内 provider。所以「优先用官方 Provider，不可用时才回退 CLI」这句话**当前对 9 个外部 Harness 全都不成立** —— OMC 不是重复官方能力，而是在补一个真实空缺。
   - `oh-my-dsh-slim@0.8.5` 确实存在且声明兼容 0.2.x（`engines.dsh: >=0.2.0-rc.2 <0.3.0-0`），但它**测过的是 0.2.1-rc.2，本机是 rc.3**。可以装，但不能说「已验证」。

2. **OMC 的技术定位应改为：把每个外部 CLI 注册成 DSH 原生 `SubagentProvider`**，而不是自己造一个派发器。这样并发、取消、容量、子会话目录、完成通知、中断全部由宿主 `ctx.subagents` 管理，OMC 只写「把一个 CLI 变成一个 provider」的适配层。这是本方案与 v2.0 最大的差异，也是最大的工作量节省。

3. **形态**：一个 npm 包、零运行时依赖、零构建步骤（纯 ESM）、Host-only bundle。v0.1 对外只暴露**一个工具**（`coharness`）、**一个命令**（`/coharness doctor`）、**4 个 Skill**。不上客户端 UI。

4. **v0.1 只做三件事**：发现（doctor）、真实派发（provider）、诚实的失败报告。三件都能在没有任何模型费用的情况下验收。

5. **本机实测环境是 v0.1 最好的负向测试用例**：无 Codex/Gemini/Kimi，`wsl.exe` 存在但 `wsl -l -v` 返回 `Wsl/E_ACCESS_DENIED`，PATH 上没有 node/pnpm/dsh。一个「安装后立刻发现什么都没有，并说清楚下一步」的 doctor，比一个假成功的 doctor 有价值。

---

## 1. 事实核查

### 1.1 宿主与 profile（已验证）

| 项 | 实测值 | 来源 |
|---|---|---|
| 桌面运行时 | `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.3`（内嵌 `@deepseek-ai/dsh@0.2.1-rc.3`） | `resources/app.asar/dsh/package.json` |
| Cordis | `@deepseek-ai/cordis@4.0.5` | 同上 |
| Profile | `desktop` → `C:/Users/<you>/.dsh\profiles\desktop` | `$env:DSH_PROFILE(_DIR)` |
| 已装 bundle | 仅 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` | profile `package.json` |
| 第三方插件 | **零**（`dependencies: {}`，`node_modules/` 为空） | 同上 |
| 活动配置行 | 194 条 | `Config.listConfigs` |
| subagent 栈 | `subagent` + `subagent-spawn-in-process` + `subagent-fork-in-process` 已挂载；`tool-subagent` 为 inactive（预设层） | 同上 |

**含义**：现在这个 profile 里**没有任何插件冲突**，也没有任何外部 Harness 通路。OMC 的第一次安装验证可以在干净环境完成；反过来，任何「和 slim/conductor 共存」的结论都不能靠这台机器得出，只能靠源码分析 + 命名空间隔离。

### 1.2 `oh-my-dsh-slim@0.8.5`（已验证）

- npm 上真实存在，`0.8.5` 是最新版本；`dist.unpackedSize ≈ 410 KB`；MIT。
- `engines.dsh: ">=0.2.0-rc.2 <0.3.0-0"`，`engines.node: ">=20"`。
- `dsh.bundle.patch: "./cordis.patch.yml"`，`dsh.client` 需要 locale / settings / plugin-manager / api-remotes 四个客户端包。
- `exports`：`.`、`./client`、`./preset`、`./profile-registry`。
- `keywords`：`deepseek, dsh, agent-preset, subagent, oh-my-opencode-slim` —— **没有 `dsh-plugin`**。
- 6 个角色（oracle/designer/fixer/explorer/librarian + council 三席 + 合成器），默认继承会话模型，后台优先委派，`maxDepth: 1`。
- README 明确：「tested hosts: DSH 0.2.0-rc.2 and 0.2.1-rc.2」。

**含义**：slim 已经覆盖「角色 / 模型继承 / 工具过滤 / 配置卡 / 后台委派」。OMC 不要重写这些。但 slim 的 provider 只有 `spawn`/`fork`（进程内 DSH 子 Agent），**它无法把一个任务交给 Codex**。这正是 OMC 的接口位置：给 slim 的角色加一个「Harness 维度」。

### 1.3 Desktop 没有外部 provider（已验证）

在 `resources/app.asar/dsh/node_modules/@deepseek-ai/` 内，与 subagent 相关的包只有：

```
dsh-subagent, dsh-subagent-fork-in-process, dsh-subagent-spawn-in-process,
dsh-tool-subagent, dsh-tool-subagent-control,
dsh-client-ui-subagent, dsh-client-ui-settings-subagent
```

`@deepseek-ai/dsh-subagent-acp` **不存在**（读 package.json 直接 not found）。`dsh-acp` / `dsh-acp-app` 存在，但它们是 **DSH 作为 ACP 服务端**（被编辑器连接），不是「连到别人的 agent」。

`dsh-subagent/README.md` 写的「ACP, DSH SDK, Codex, and Claude Code execute once」是**源码仓库**的能力描述，不是本安装的现实。

> **修正（同日，重要）**：上面「完全没有外部 provider」只对**预装**成立。
> `plugin_manager list_bundles` 里还有一条**官方按需目录项**：
> `@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3`，`availability: "missing"`，
> 但带 `installTarget` —— 也就是说 Desktop 0.2.1-rc.3 **提供** Claude Code 的官方
> subagent provider，只是默认没装，需要时能在插件管理器里装上。
>
> 对 OMC 的含义有两条：
> 1. 「OMC 是第一个外部 provider」应改成「OMC 是**默认可用**的外部 provider 通路」；
> 2. 运行期探测必须能识别它：`ctx.subagents.list()` 出现 `claude-code` / `acp` 时，
>    OMC 不该再注册 `omc:claude`，而应让位给官方实现（见 §4.6 第 3 条）。
>    v0.1.4 已按 provider 名匹配，但还没有「官方名 → harness」的映射，列入 v0.2 第一项。

**含义**：
- v2.0 的「优先使用 DSH 官方 Provider；在不可用时，才考虑 CLI」在 Desktop 预装状态下等于「永远走 CLI」；装了官方按需项之后才部分成立。
- 反过来说，OMC 若实现 provider 适配，它是**开箱即用**的那条外部 Harness 通路。这不是「重复注册」，而是扩展点本来的用法。
- 风险也随之明确：外部 provider 没有 DSH 的 sandbox / approval（见 3.8）。

### 1.4 市场机制（已验证）

- `@deepseek-ai/dsh-plugin-market` 的 README 原话：**"There is no official market; Discover lists only the index sources the user adds."**
- `dsh-experimental-plugin-market-bundle` 默认关闭；打开后 Plugins 页出现 Installed / Discover 两个 tab，Discover 里加「索引源」。
- 社区现有三条路径：
  - `awesome-dsh-plugin` 维护的列表**本身就是一个 format-1 索引**，地址 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，在 Discover 里直接添加；
  - `dshmarket`（`dsh plugin --profile web add dshmarket`）是装进 DSH 内部的插件市场 UI；
  - `dshbase-catalog`（中文社区，目录里有两万条条目）让 agent 自己找插件并安装。
- 收录门槛（awesome 列表）：能 `dsh plugin add` 装上、描述与行为一致、分类正确、持续维护；PR 评审会核对源码。**不是安全审计**。
- 索引格式为 format 1，由 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验；单个索引取回预算 **15 秒**。

**含义**：「发布 npm 包」和「出现在市场」是两件事，中间隔着一个 PR / 收录动作。方案第 6 节按这个现实来写。

### 1.5 命名与工具链（已验证）

| 项 | 结果 |
|---|---|
| npm `oh-my-coharness` | **404，名字可用** |
| `node` on PATH | 无 |
| `pnpm` / `npm` / `dsh` on PATH | 无 |
| 宿主自带 Node | `resources\runtime\primary-runtime\dependencies\node\bin\node.exe` → **v24.21.0**，可直接用于 `node --check` 与本地单测 |
| Codex / Claude / Gemini / Kimi / Qwen / copilot / grok / traecli | **Windows 侧全部未安装** |
| **opencode** | **已安装，但在 WSL Ubuntu 内**：`2.1.4`，认证 `ok`，由插件从宿主进程发现（`wsl:Ubuntu`）。Windows 侧 `where opencode` 找不到 |
| `wsl.exe` | 存在。**受限 token 的 shell 里 `wsl -l -v` → `Wsl/E_ACCESS_DENIED`；宿主进程里 `wsl -l -q` → `Ubuntu`（正常）** |
| `git` / `python` | 有 |

**含义**：

- 构建链路必须能在这台机器上跑 → **不要引入 TypeScript 编译 / bundler**。用纯 ESM + JSDoc，`node --check` 即可验证语法。
- Desktop 的 `plugin_manager` 自带包管理器（launcher 提供），所以**用户**不需要装 pnpm；但**开发者**本机没有 pnpm，这决定了 CI 必须在别的机器/容器里跑安装测试。
- **最重要的一条**：`wsl.exe` 在 DSH 的受限 token 下不可用，但在宿主进程里可用。因此「探测」必须发生在插件里，不能发生在 agent 的 shell 工具里；同时这也解释了为什么 GUI 应用经常「看不见」用户明明装好的 CLI —— 见 §11。

---

## 2. 复用矩阵：哪些模块最符合这个计划

排序依据：**能省掉多少 OMC 自己的代码**，而不是「功能多」。

| 排名 | 模块 | 给 OMC 的东西 | 依赖方式 | OMC 明确不做的事 |
|---|---|---|---|---|
| 1 | **DSH `ctx.subagents` + `SubagentProvider` 契约** | 并发容量、取消、树形释放、子会话目录、完成通知、中断、重复 id 保护 | **硬依赖（服务可选出现）**，不打包、不复制 | 不写自己的调度器 / 不写自己的结果总线 / 不建会话数据库 |
| 2 | **DSH `ctx.skills` + `register()`** | 免装目录、免重启、模型目录与按需加载、作用域分层 | 硬依赖（`register` 进全局层） | 不往 `~/.dsh/skills` 写文件、不做 skill 安装器 |
| 3 | **DSH `ctx.subprocess`** | 可执行解析（`resolveExecutable` 校验绝对路径）、`spawn` + 收集模式 + spill、树杀、grace | 硬依赖 | 不用 `node:child_process` 裸调、不自己实现截断 |
| 4 | **DSH `ctx.worktrees`** | 一条命令开出隔离 worktree 并把 session cwd 切过去 | 可选依赖（v0.2） | 不自己 `git worktree add` |
| 5 | **`dsh-wsl-tool`**（XINY11451，2.2.3） | WSL 语义的既有事实：`wsl.exe -e bash -lc`、路径翻译、`DSH_WSL_DISTRO` 约定、后台作业接 `ctx.jobs` | **可选同伴**：检测其存在并在 doctor 里引用，不 import、不依赖 | 不重复注册 `wsl` 系列工具、不做它的 bootstrap/terminal |
| 6 | **`dsh-agent-conductor`**（MJorgin） | 11 个 CLI 的 headless argv 形态、10 分钟超时 + 整树终止、20 KB head/tail 裁剪、doctor 思路 | **源码参考**（MIT，保留署名） | 不默认共存（同装两个 dispatch 工具会打架），见 4.8 |
| 7 | **`oh-my-dsh-slim`**（ninipa，0.8.5） | 角色语义、模型继承、配置卡体验、background-first 委派纪律、`maxDepth:1` | **可选同伴**：只在其预设之上加 Harness 维度，不注册角色 | 不重写角色管理器、不做 Agent Settings UI |
| 8 | **`oh-my-opencode-slim` / `oh-my-dsh`（Marshall-sng）** | Deepwork / Council / Worktree / 验收策略的流程设计 | **仅参考**（persona 文本是 MIT，若要复用必须署名） | 不移植其整套编排 |
| 9 | **`orchestmux`**（layl-labs） | 「派发/等待/收集/升级」四段式，以及「子 Agent 没真正完成就不许宣布成功」 | **仅参考**（原则），已由 `activation.result` 在 seam 层实现 | 不引入其 coordinator 进程 |
| 10 | **`multiagents`** | 跨 Agent 消息与会话桥接 | v0.3 参考 | 不移植 Orchestrator / Dashboard |
| 11 | `dsh-market` / `dshbase-catalog` / `awesome-dsh-plugin` | 分发与曝光 | **发布渠道** | 不 bundle 它们 |

### 2.1 三条必须遵守的隔离规则

1. **命名空间**：provider 名统一 `omc:<harness>`（`omc:codex`、`omc:gemini`、`omc:kimi`…）；工具名 `coharness`；命令 `coharness`；Skill 前缀 `coharness`。不占用 `subagent`、`subagent_fork`、`conductor_dispatch`、`wsl*`。
2. **不注册同名工具**：安装时用 `ctx.tools.get('conductor_dispatch')` / `ctx.tools.get('wsl')` **探测**同类插件，只在 doctor 里报告「检测到 X，建议二选一」，绝不覆盖。
3. **不改用户环境**：不写 `~/.codex`、`~/.claude`、`~/.gemini`，不读它们的 token 文件，不设置全局 env。

---

## 3. 架构

### 3.1 组件图

```
┌────────────────────────── DSH Desktop / Web / CLI ──────────────────────────┐
│  会话（主 Agent）                                                             │
│    ├─ 工具 coharness        ──┐                                              │
│    ├─ 命令 /coharness doctor ─┤                                              │
│    └─ Skill coharness*       ─┘                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Oh My CoHarness（单 bundle，Host-only，零依赖）                              │
│                                                                              │
│   Surface 层   tool:coharness │ command:doctor │ skills:4 │ provider:omc:*   │
│       │                                                                      │
│   Adapter 层   HarnessRegistry ── Doctor ── Dispatch ── (Handoff: v0.3)       │
│       │               │            │           │                             │
│   Transport 层   native(argv)   wsl 装饰器   provider 直连 / 自持运行         │
└───────┼──────────────────────────────────────────────────────────────────────┘
        │
        ├── ctx.subagents（容量/取消/目录/通知）──► SubagentRun
        ├── ctx.subprocess（spawn/collect/树杀）──► codex / gemini / kimi …
        └── ctx.worktrees（v0.2 隔离）────────────► git worktree
```

### 3.2 为什么「Provider 优先」而不是「自己派发」

| 维度 | 注册 `SubagentProvider`（推荐） | 自持 dispatch 工具 |
|---|---|---|
| 并发上限 | 宿主 `maxActiveSubagents`（默认 8）统一管 | 自己数 |
| 取消 | `activation.dispose()` / `subagents.interrupt()` | 自己接 `AbortSignal` |
| 完成判定 | `activation.result` 在**清理完成后**才结算 | 自己解析 stdout 猜 |
| UI | 子会话面板可见（`mode: 'external'`） | 只能看工具卡片 |
| 目录/审计 | 父会话写入 `subagent/catalog` 事实 | 无 |
| 重复启动保护 | `DUPLICATE_CHILD` | 无 |
| 代码量 | provider ≈ 120 行/个 + 一个通用 runner | 调度 + 生命周期 + 取消 ≈ 800 行起 |

结论：**provider 是主路径，自持运行只作为 fallback**（`ctx.subagents` 缺失、或需要把进度流式落到 job 里）。

### 3.3 冻结的内部数据契约

v0.1 就冻结，v0.3 只填字段不改形状。

```ts
export interface HarnessInfo {
  id: string                  // 'codex' | 'claude' | 'gemini' | 'kimi' | 'qwen' | 'opencode' | 'cursor' | 'copilot' | 'grok'
  label: string               // 'Codex'
  surface: 'provider' | 'direct'
  transport: 'native' | 'wsl'
  command: string             // 解析后的绝对路径，或 wsl 内的命令名
  version?: string
  auth: 'ok' | 'signed-out' | 'unknown' | 'missing'
  capabilities: {
    write: boolean            // CLI 支持工作区写入（决定默认 mode）
    model: boolean            // 支持 --model
    resume: boolean           // 支持原生会话续接（v0.3 用）
    json: boolean             // 支持结构化输出
    stdin: boolean
  }
  distro?: string             // transport==='wsl' 时
  source: 'path' | 'wsl' | 'config' | 'probe'
  detail?: string             // 失败原因，已脱敏
}

export interface DispatchRequest {
  harness: string | 'auto'
  role?: 'builder' | 'reviewer' | 'explorer' | 'oracle' | 'librarian'
  prompt: string
  cwd?: string                // 缺省 = 当前会话工作目录（ctx.workingDirectory）
  mode: 'read-only' | 'in-place' | 'worktree'
  delivery: 'await' | 'background'
  timeoutMs?: number
  maxOutputBytes?: number
  outputSchema?: object       // 预留：要求 CLI 输出 JSON
  trace?: { correlationId?: string }
}

export interface DispatchResult {
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'started'
  harnessId: string
  childId?: string            // 宿主的 subagent session id（background 模式必填）
  output: string              // 已裁剪
  exitCode?: number | null
  signal?: string | null
  truncated?: boolean
  spillPath?: string
  stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  // —— v0.1 预留，v0.3 填充 ——
  nativeSessionId?: string
  artifacts?: Array<{ kind: 'diff' | 'commit' | 'test' | 'file'; ref: string; detail?: string }>
  workspace?: { path: string; branch?: string; baseCommit?: string }
  diagnostics?: string[]       // 稳定错误码 + 一句话，绝不带 token/env 明文
  elapsedMs: number
}
```

**为什么这三个字段现在就要留**：v0.3 的会话复用、产物校验、worktree 归属都要落在 `DispatchResult` 上。先留空字段，后面只加填充逻辑，Skill 与工具 schema 都不用改版本。

### 3.4 模块清单

```
oh-my-coharness/
├── package.json                # dsh.bundle.patch + engines.dsh + keywords
├── cordis.patch.yml            # 一行 host 插件
├── src/
│   ├── index.js                # 入口：读配置、注册 provider / tool / command / skills
│   ├── harnesses.js            # HarnessRegistry：定义表（argv/auth/capabilities）+ 探测
│   ├── doctor.js               # 探测 → HarnessInfo[] → 可复制报告（脱敏）
│   ├── transport.js            # argv 组装、native spawn、wsl 装饰器、输出裁剪
│   ├── dispatch.js             # DispatchRequest → SubagentRun / 直跑 → DispatchResult
│   ├── provider.js             # SubagentProvider 工厂（omc:<harness>）
│   └── skills.js               # 把 skills/ 注册进 ctx.skills
├── skills/
│   ├── coharness/SKILL.md      # 路由与纪律（模型自动触发）
│   ├── coharness-setup/SKILL.md# 安装/登录/排错引导
│   ├── coharness-ulw/SKILL.md  # v0.2
│   └── coharness-council/SKILL.md # v0.2
├── test/                       # node --test，shim 掉 ctx
└── docs/
    ├── PLAN.zh-CN.md           # 本文
    ├── ADAPTER.zh-CN.md        # 适配层规范（含代码骨架）
    └── UPSTREAM.md             # 借鉴清单与署名
```

「为什么不能复用」的减法原则：**任何新模块必须能回答它替代了哪个 DSH seam**。答不上来就不写。

### 3.5 配置模型

v0.1 用插件 `Config`（profile patch 里可编辑），字段刻意少：

```yaml
# cordis.patch.yml 片段（用户可改）
- id: oh-my-coharness
  name: oh-my-coharness
  config:
    harnesses:
      codex:  { enabled: true, transport: auto, timeoutMs: 600000 }
      gemini: { enabled: true }
      kimi:   { enabled: true }
    wsl: { distro: '', enabled: auto }
    dispatch:
      maxParallel: 4            # 小于宿主 maxActiveSubagents(8)，留余量
      defaultMode: read-only
      maxOutputBytes: 20000
    privacy:
      reportBinaryPaths: false  # doctor 默认不打印绝对路径
```

v0.2 才考虑用 `configForms` + `settings.section` 做配置卡（slim 已经证明这条路可行，直接照抄形态，不重写）。

### 3.6 Skill 装配

`ctx.skills.register({ name, description, content, invocation })` —— 内容在 mount 时从包内 `skills/<name>/SKILL.md` 读取，注册进**全局层**（host 行 = unscoped）。

- `coharness`：`modelInvocable: true`，`userInvocable: true`。这是模型唯一需要常备的入口知识（什么时候该把活交给别人）。
- `coharness-setup`：`modelInvocable: true`，用于「装了但没登录」的引导。
- `coharness-ulw` / `coharness-council`：v0.2 才注册，避免 v0.1 的目录噪音。

**不要**把 skill 写进 `~/.dsh/skills`：那样卸载后留垃圾，且和用户的 skill 目录抢名字。

### 3.7 完成 / 取消 / 超时语义

| 场景 | 行为 |
|---|---|
| `delivery: 'await'` | 工具内 `await activation.result`；该 promise 在**清理完成后**结算，因此「完成」是真实退出，不是读到一行 stdout |
| `delivery: 'background'` | 立即返回 `{ status:'started', childId }`；结果经宿主 settlement notice 回来；模型被 Skill 明确要求「不要在通知到达前宣布完成」 |
| 用户取消 / Ctrl+C | `exec.signal` → `activation.dispose()` → 宿主终止进程树 |
| 超时 | 双重：CLI 参数超时（若支持）+ `spawn.spec.graceMs` + 我们自己的 `AbortSignal`；超时后仍走 dispose，`status: 'timeout'` |
| 输出爆炸 | 收集模式 `maxBytes` + 头部/尾部裁剪（默认 20 KB，`head 8K + tail 12K`），完整流写 spill，`DispatchResult.spillPath` 指回去 |
| CLI 退出码非 0 | `status: 'failed'`，保留 stderr 尾部；**不**把非 0 当成功 |
| CLI 只是打印了「完成了」 | 仍然 `status: 'completed'`，但 `artifacts` 为空 → v0.3 的验收策略据此判定「未验证的完成」 |

### 3.8 安全边界（必须写进 README 和 Skill）

- 由 OMC 启动的外部 CLI **运行在 DSH 的 sandbox 与 approval 之外**。`workspace-write` 策略不约束它们（这与 `dsh-wsl` 的既有结论一致：`wsl.exe` 在 subprocess 之下，文件策略管不到）。
- 因此默认 `mode: 'read-only'`，写入必须显式 `mode: 'in-place' | 'worktree'`，且 Skill 要求先向用户说明「这会用该 CLI 自己的权限写文件」。
- v0.2 起写入默认走 `ctx.worktrees.create()` 的隔离工作树，产出以 diff 形式回到主工作区，由主 Agent 决定是否合并。
- doctor 报告永不含：token、环境变量明文、私有 prompt、对话内容、绝对用户路径（除非用户显式 `reportBinaryPaths: true`）。

---

## 4. 适配层设计（核心）

详细代码骨架与逐字段说明见 [`ADAPTER.zh-CN.md`](./ADAPTER.zh-CN.md)，这里只给决策。

### 4.1 三个正交维度

| 层 | 选项 | 谁决定 |
|---|---|---|
| **Surface**（怎么进 DSH） | `provider`（推荐）/ `direct`（fallback）/ `skill-only`（无宿主代码，最弱） | 安装形态 |
| **Transport**（怎么跑） | `native`（Windows/Linux 直接 spawn）/ `wsl`（`wsl.exe -d <distro> -e bash -lc`） | 环境探测 |
| **Harness**（跑谁） | codex / claude / gemini / kimi / qwen / opencode / cursor / copilot / grok | 定义表 |

**不要**把三者组合成 3×2×9 个适配器。写一个 `runHarness(info, request)`，argv 由「定义表 + transport 装饰器」拼出来，provider 只是它的一个包装。

### 4.2 Provider 形状（与宿主契约逐字对齐）

宿主的契约（`ctx.subagents` 的 `SubagentProvider`，已验证）：

```ts
interface SubagentProvider {
  name: string
  capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean }
  inheritsParentContext: boolean
  agentRouteDefaults?: { provider: string; model: string }
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
interface SubagentRun { id: SessionId; result: Promise<SubagentResult>; dispose(): Promise<void> }
interface SubagentResult { output: ContentBlock[]; structured?: unknown; diagnostic?: string;
                           stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal' }
```

OMC 的 provider：

- `name: 'omc:codex'`
- `capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }`
  （外部 CLI 没有 DSH 的模型路由；`depthLimit:false` 表示深度由 CLI 自己管，别让宿主按数字判）
- `inheritsParentContext: false` → 宿主给模型的工具描述会自动变成「它看不到这段对话」，**免费得到正确的提示词**。
- 只实现 `start()`；**不实现 `prepareContinuable()`** —— 外部 provider 契约上就只执行一次，别假装可续接。
- `start()` 内：组装 argv → `ctx.subprocess.spawn` → 返回 `{ id, result, dispose }`，`result` 在 `done` 之后把 stdout 转成 `ContentBlock[]`。

**唯一需要确认的 API**：外部 run 的 `id` 由 provider 铸造（README 原文 "External providers mint a fresh SubagentRun.id"）。铸造 helper 的具体导出名未验证；候选是 `@deepseek-ai/dsh-session` 的 id 工具，或用 `crypto.randomUUID()` 加品牌。**这是开工第 0 天要花 30 分钟查清的唯一阻塞项。**

### 4.3 一个工具，三种模式

`coharness` 是唯一模型可见工具：

```
coharness({
  action: 'dispatch' | 'doctor' | 'list',
  harness?, role?, prompt?, tasks?[], cwd?, mode?, delivery?
})
```

- `list`：返回 `HarnessInfo[]` 的紧凑表（id/label/transport/auth/version），**不花模型钱**。
- `doctor`：返回完整诊断报告（也可用 `/coharness doctor` 直接看，不走模型）。
- `dispatch`：`tasks[]` 支持一次调用内真正的并行 fan-out（受 `dispatch.maxParallel` 限制），单任务时等价于 `tasks: [一个]`。
- `isConcurrencySafe() { return true }`，让模型并行调用多个工具调用时不被串行化。

为什么不做 3 个工具：token 是按 schema 常驻的；三个工具 ≈ 3 倍常驻成本，而 `action` 枚举的边际成本接近 0。为什么不做「每个 harness 一个工具」（像 `dsh-tool-subagent` 那样一个 provider 一个工具）：9 个 harness = 9 个常驻 schema。

### 4.4 并发模型（多 Harness 同步运行）

「同步运行」在 DSH 里不是新能力，是 `ctx.subagents` 的既有能力，OMC 要做的是**把外部 CLI 接进这个池子**：

1. 一次 `coharness` 调用里 `tasks=[codex, gemini, kimi]` → 三次 `startActivation`（各自 `omc:*` provider）→ 并行。
2. 宿主 `maxActiveSubagents` 默认 **8**，OMC 自己再设 `maxParallel: 4`（留余量给 slim 的角色）。
3. 达到容量时宿主抛 `ACTIVATION_LIMIT_REACHED`。OMC 必须把它翻译成「当前并发已满，等一个完成或减少任务数」，**不能静默丢弃、不能排队假等**。
4. `delivery:'background'` 时工具返回 `started subagent <id>`，模型继续干别的；结算通知到达后才允许整合。这条纪律写进 Skill，并在 `coharness` 的描述里重复一次。
5. 用户中断：面板上的停止 → `subagents.interrupt()` → 我们的 `dispose()` → 进程树终止。

**不做**：OMC 自己的任务队列、重试风暴、轮询。等待由 `activation.result` 提供，不是 `while(true) sleep`。

### 4.5 v0.3 的会话复用（关键澄清）

宿主的对外 provider 契约是「执行一次」，**不支持续接**（`External children execute once`）。所以：

- 「同 Harness 恢复原生 Session」**不能**通过 provider seam 实现，只能由 OMC 在 adapter 里保存 `nativeSessionId`，下次派发时把它变成 CLI 的 resume 参数（例如 Codex 的 `exec resume`、Claude 的 `--resume`）。具体 flag 必须在 v0.3 逐个实测。
- 「跨 Harness 交接」是 OMC 自己的 `Handoff` 结构（结构化摘要 + 产物引用 + 决策清单），写入下一个 prompt 的文件/片段，不依赖任何宿主的会话机制。
- 因此 v0.3 的 `sessions.ts` 只维护一张轻量映射表：`omcTaskId → { harnessId, nativeSessionId, workspace, artifacts, lastUsedAt }`。放在 profile 的插件配置域或 `<DSH_HOME>/coharness/sessions.json`，**不建数据库**。
- 验收标准必须先证明收益：端到端耗时 / 成本 / 重复读取量下降，且质量不降，才默认开启。

### 4.6 与同类插件的运行期兼容探测

安装后立即执行一次（不花模型钱）：

| 探测 | 命中动作 |
|---|---|
| `ctx.tools.get('conductor_dispatch')` | doctor 提示「检测到 dsh-agent-conductor，两者功能重叠；建议只保留一个」 |
| `ctx.tools.get('wsl')` | doctor 记录「WSL 能力由 dsh-wsl 提供」；OMC 仍用自己的 2 行 launcher，但沿用 `DSH_WSL_DISTRO` 约定 |
| `ctx.subagents.list()` 含 `acp` / `codex` / `claude-code` | 该 Harness 自动切换到 `surface: 'provider'`（用官方的），OMC 不再注册同名 `omc:*` |
| `ctx.skills.list()` 含 `omc:*` 之外的 `coharness` | 名字冲突：OMC 降级为 `coharness2` 前缀并在 doctor 说明（极罕见，但要处理） |

第 3 条是真正的「优先官方、其次自己」——而且它在**运行期**判断，不是写死在代码里。

---

## 5. 分阶段计划

### 5.1 v0.1 — Connect（预计 2–3 周，2 人）

**目标**：装完就能诚实回答「这台机器上有什么、能不能用、下一步做什么」，并能真的把一次只读任务交给 Codex / Gemini / Kimi 之一。

| # | 工作包 | 产出 | 负责人 |
|---|---|---|---|
| 1.1 | 包骨架 + bundle patch + 安装/卸载 | `install_bundle` 成功、`application: applied`、卸载后无残留 | A |
| 1.2 | HarnessRegistry + 定义表（3 个首发 CLI） | `harnesses.js`，含 argv/auth/capabilities | A |
| 1.3 | Doctor（native + wsl 探测、脱敏报告） | `/coharness doctor` 文本 | A |
| 1.4 | Transport（native spawn、收集、裁剪、树杀、超时） | `transport.js` | A |
| 1.5 | Provider 工厂 + `coharness` 工具（dispatch/list） | `provider.js` / `dispatch.js` / `index.js` | A |
| 1.6 | 4 个 Skill（v0.1 先 2 个）+ 路由纪律 | `skills/` | B |
| 1.7 | 安装体验与错误文案（缺 CLI、未登录、超时、容量满） | 文案表 + 实测截图 | B |
| 1.8 | 测试（单测 shim + 契约 + 安装宿主 smoke 清单） | `test/` | B |

**v0.1 验收门槛**（对应 v2.0 的 0/6，我把不可测的项改写成了可判定项）

- [ ] Desktop `install_bundle` 成功、重启后仍加载、卸载后 profile 无残留行
- [ ] `doctor` 在「无任何 CLI」的机器上 3 秒内返回，0 个可用、0 次外网请求、0 模型调用
- [ ] `doctor` 在 WSL 不可用时输出 `wsl: unavailable (Wsl/E_ACCESS_DENIED)` 而不是崩溃或假装可用
- [ ] Codex 完成一次真实只读委派（`delivery: await` 与 `background` 各一次）
- [ ] 同一次调用里 Codex + Gemini 并行，两个 `childId` 都出现在子会话目录
- [ ] 取消：面板停止后进程树 5 秒内消失（`Get-Process` 验证，无孤儿）
- [ ] 超时：`timeoutMs=5000` 的假 CLI 返回 `status: timeout`，不挂起工具调用
- [ ] 认证未知时显示 `unknown`；未安装时显示官方安装命令
- [ ] 安装前后 profile `cordis.patch.yml` 只多出 OMC 自己的行
- [ ] Desktop 端到端回归（不是只测 CLI）

**不做**：角色路由、council、worktree、会话复用、配置 UI、客户端代码。

### 5.2 v0.2 — Orchestrate（3–4 周）

**目标**：在 slim 的角色之上加一个「Harness」维度，并把两个工作流做稳。

> **细化方案（2026-10-29 修订）**：v0.2 已按复审建议收窄为 **Skill-first 薄桥接**，详见 [`V0.2-PLAN.zh-CN.md`](./V0.2-PLAN.zh-CN.md)。与下表的关系：
>
> - 2.1 / 2.2 角色路由与自动路由：0.2.0 不写独立 Router；角色由 Skill 契约 + `coharness` 的 `harness` 选择实现；0.2.1 视需要。
> - 2.3 / 2.4 ulw 与 council：0.2.0 用 Skill + 现有 `tasks[]` 实现，不新增工具 action。
> - 2.5 worktree：0.2.0 不启用；写只走显式 `in-place`；0.2.1+ 再评估。
> - 2.8 配置卡：0.2.0 不做；Companion 优先用 Slim 的设置卡。
>
> 下表保留为历史范围摘要，不再作为实现依据。

| # | 工作包 | 说明 |
|---|---|---|
| 2.1 | Harness 维度进角色 | 角色 → `harness: auto` 或 `<id>`；默认 auto，由能力表选 |
| 2.2 | 自动路由 | 依据：`mode`（读写）、语言/仓库类型、可用性、上次成功率；不做「模型自己挑」 |
| 2.3 | `ulw` 工作流 | 拆分 → 并行实现 → 独立审查 → 修复 → 测试确认，每步都落 `DispatchResult` |
| 2.4 | `council` 工作流 | N 个 Harness 独立给方案 → 交叉审查 → 合成；N 默认 2（成本） |
| 2.5 | worktree 隔离 | `ctx.worktrees.create(agent)` → 写入型任务默认进隔离树 |
| 2.6 | 验收策略 | 只有 `artifacts` 里有测试/commit/diff 证据才算完成 |
| 2.7 | 并发护栏 | `ACTIVATION_LIMIT_REACHED` 的翻译与退避（一次，不重试风暴） |
| 2.8 | 配置卡（可选） | 复用 `configForms` + `settings.section`，不重写 UI 框架 |

**v0.2 固定验收任务（历史记录，已被 V0.2-PLAN §7 取代）**：Codex 实现一个 Rust 小功能 → Gemini 独立审查 → 按审查修复 → 测试工具确认。要求：每一步都能追溯到「哪个真实 Harness、哪个 childId、哪条命令」。

> V0.2 的实际验收以 [`V0.2-PLAN.zh-CN.md`](./V0.2-PLAN.zh-CN.md) §7 的 A–H 为准。Gemini 个人免费层不可用，Council 的第二个 Harness 用 `glm` / `codex` 等可用项；原 Rust / Gemini 固定任务不再适用。

**纪律**：不为了演示多 Agent 而默认起 5 个。并行只在任务可切分时触发，默认单 Agent。

### 5.3 v0.3 — Remember（2–3 周，谨慎扩规模）

| # | 工作包 | 说明 |
|---|---|---|
| 3.1 | Session 映射表 | `omcTaskId → nativeSessionId + workspace + artifacts`，JSON 文件 + 原子写 |
| 3.2 | 同 Harness 续接 | 每个 CLI 的 resume flag 实测表；不支持则自动降级为「新会话 + 必要上下文」 |
| 3.3 | Handoff 结构 | `{ goal, decisions[], artifacts[], openQuestions[], constraints[] }`，序列化成 prompt 片段 |
| 3.4 | 上下文裁剪策略 | 只传「下一个 agent 需要知道的最小集合」，用 token 计数验证 |
| 3.5 | Benchmark | 端到端耗时、token、重复读取行数；A/B：有/无复用 |
| 3.6 | 默认开关 | 只有 3.5 证明「更快或更省且质量不降」才对默认开启 |

**明确不做**：统一会话数据库、跨进程续接、把外部 CLI 的中间步骤同步进 DSH 会话。

---

## 6. 发布方案

### 6.1 包元数据（照抄即可用的清单）

```json
{
  "name": "oh-my-coharness",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.js",
  "exports": { ".": "./src/index.js", "./package.json": "./package.json" },
  "files": ["src", "skills", "cordis.patch.yml", "README.md", "docs/UPSTREAM.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0", "node": ">=20" },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "coharness", "multi-harness", "codex", "claude-code", "gemini-cli", "kimi", "wsl", "orchestration"],
  "license": "MIT"
}
```

要点：

- **没有 `dsh.client`** → Web UI 完全不受影响，也不引入客户端包注入。v0.2 若加配置卡才补 `dsh.client`。
- **零 dependencies、零 peerDependencies**（v0.1）。服务全部从 `ctx` 取，不 import `@deepseek-ai/*`，因此不会被宿主版本卡住；唯一的版本约束是 `engines.dsh`。
- `engines.dsh` 写「测过的下界」，不写 `*`。0.2.1-rc.4 发布后先在 CI 跑再放宽。
- `keywords` 必带 `dsh-plugin`（slim 没带，会影响部分索引的检索）。

### 6.2 三条安装路径

| 场景 | 命令 | 备注 |
|---|---|---|
| Desktop | Plugins 界面 → 安装（包名或本地目录） | Desktop 自己管 `desktop` profile，**不要**用 `dsh plugin --profile desktop` |
| 有 dsh CLI 的 profile | `dsh plugin --profile <p> add oh-my-coharness@0.1.0` | 精确版本，不用 `latest` |
| 本地开发 | `plugin_manager` → `install_bundle`，target = 绝对目录 | 装完必须重启宿主（插件代码每进程只加载一次） |

### 6.3 进入市场的现实路径（三步，不能省）

1. **发 npm**：`npm publish`（首次 `--access public`）。名字已验证可用。
2. **提交社区索引**：给 `awesome-dsh-plugin` 提 PR，加一条条目（分类建议 `Tools & Capabilities` 或 `Workflow & Automation`），描述必须和实际行为一致（评审会数工具个数）。合并后自动进 `dsh-plugin-catalog/index.json`，用户在 Discover 里加这个索引就能看到。
3. **中文生态**：dshbase 目录页提交（它有自己的安装实测 CI，会跑 `dsh plugin add` + 启动）、可选进 `dsh-market`（`dshmarket` 自带目录）。

自建索引（可选，v0.2 以后）：按 format 1 生成 JSON，用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 在 CI 校验后发布到静态托管；注意 Discover 取回预算是 15 秒，别放 CDN 冷启动慢的地方。

### 6.4 版本与兼容矩阵

| DSH | 状态 | 谁测 |
|---|---|---|
| 0.2.1-rc.3 | 当前开发基线（本机） | 每次 PR + 发布前 |
| 0.2.1-rc.2 | 与 slim 共同基线 | 发布前 |
| 0.2.0 系列 | 只做「能装能跑」冒烟 | 发布前 |
| 0.3.x | **不支持**，`engines` 显式排除 | — |

不宣称支持未测版本。用户强行安装时，`plugin_manager` 会用 `engines` 拒绝；确需覆盖要走 exemption（会有风险提示），OMC 的文档不引导这条路。

### 6.5 卸载与更新

- 只删：自己那一条 `cordis.patch.yml` 行、`<DSH_HOME>/coharness/`（v0.3 起才有）。
- 绝不删：用户装的 Codex/Gemini/Kimi、它们的认证文件、用户的 skill、其他插件。
- 更新：Desktop 的插件管理器在 rc 系列可能要求先卸载再装；文档先把「备份配置 → 卸载 → 装新版 → 重启」写成流程。

### 6.6 诊断与隐私

`/coharness doctor` 输出（这是本机当前的真实形态，可直接当 fixture）：

```text
Oh My CoHarness doctor — 2026-10-29T11:52:00+08:00
host: DSH 0.2.1-rc.3 · desktop profile · win32 x64
subagents: spawn, fork (no external provider)
capacity: maxActiveSubagents=8 → omc maxParallel=4

harness        transport  version   auth       state
codex          -          -         -          missing    install: npm i -g @openai/codex
gemini         -          -         -          missing    install: npm i -g @google/gemini-cli
kimi           -          -         -          missing    install: npm i -g @moonshot-ai/kimi-code
wsl            -          -         -          unavailable  Wsl/E_ACCESS_DENIED (wsl -l -v exited 1)

plugins  conductor_dispatch: absent · wsl: absent
next: 先装一个 CLI，然后在任意会话里说「用 codex 读一下 README 并总结」；或运行 setup skill。
redaction: 未包含 token / env / prompt / 对话内容
```

规则：无网络请求、无模型调用；错误码用稳定字符串（`Wsl/E_ACCESS_DENIED`、`ENOENT`、`ACTIVATION_LIMIT_REACHED`）而不是自由文本，便于用户搜索。

---

## 7. 工程与协作

### 7.1 两个开发者只有一个接口面

冻结三个接口（写进 `docs/ADAPTER.zh-CN.md`，改它们要双方 review）：

| 接口 | 谁拥有 | 对方能用 |
|---|---|---|
| `HarnessRegistry`（有什么、在哪、能不能用） | A | B 的 Skill 只用 `id` 与 `capabilities` |
| `Dispatch`（任务 → 真实执行 → `DispatchResult`） | A | B 的工作流只消费 `DispatchResult` |
| `Skill/Workflow`（何时派发、如何收尾） | B | A 不改 Skill 文案，只保证工具语义 |

文件所有权：A 拥有 `src/{harnesses,doctor,transport,dispatch,provider}.js`；B 拥有 `skills/**`、`test/**` 的体验用例、`README`。`src/index.js` 双方都碰 → 改动必须小而频繁地合。

### 7.2 PR 序列（建议按此顺序，每个都能单独合并）

1. 骨架 + patch + 安装验证（空插件，能装能卸）
2. `node --check` + 一个 `node --test` 空套件 + CI
3. HarnessRegistry 定义表（纯数据，3 个 CLI）
4. transport: `resolveExecutable` + `--version` 探测
5. doctor: 报告渲染 + 脱敏 + 本机 fixture
6. transport: spawn + collect + 裁剪 + 树杀
7. provider 工厂（单 harness，mock 掉 subprocess）
8. `coharness` 工具（list + dispatch 单任务）
9. `action: doctor` + `/coharness` 命令
10. `tasks[]` 并行 + 容量错误翻译
11. Skill: coharness + coharness-setup
12. 安装宿主 smoke 清单 + 手动 E2E 记录
13. README（中文优先）+ UPSTREAM 署名
14. npm 打包演练（`npm pack` 后检查 tarball 内容）
15. 首次发布 + awesome PR

### 7.3 测试金字塔

| 层 | 做法 | 是否需要真实 CLI |
|---|---|---|
| 单测 | shim 掉 `ctx`（`subprocess`/`tools`/`subagents`），跑 `node --test` | 否 |
| 契约 | 用宿主自带 Node 加载真实 `dsh-*` 类型？→ 不需要；改为**断言我们调用的方法签名**（字符串快照） | 否 |
| 安装宿主 smoke | 干净 profile `install_bundle` → 断言 `application: applied` → 断言工具/命令/skill/provider 都在 | 否 |
| 真实 CLI | 手动 + 可选 CI job（有凭证的 runner） | 是 |

本机现实：**没有 dsh CLI、没有 pnpm、没有真实 CLI**。所以「安装宿主 smoke」这条必须在另一台机器或容器里跑；本机只能做 1、2 层 + 手工 `install_bundle`（通过 `plugin_manager`）。

### 7.4 许可证与署名

- 参考实现里只搬「事实」（argv 形态、超时数值、裁剪比例），不复制代码；若复制超过 ~20 行，在 `docs/UPSTREAM.md` 记录来源文件、许可证（conductor/dsh-wsl/slim 均为 MIT）与版权行。
- persona 文本若来自 `oh-my-opencode-slim`（MIT © 2025 alvinunreal），必须保留署名——slim 的 README 就是这么做的。

---

## 8. 风险登记册

| # | 风险 | 触发条件 | 影响 | 处置 |
|---|---|---|---|---|
| R1 | 外部 provider 的 SessionId 铸造方式未知 | 开工第一天 | 阻塞 provider | 先查 `@deepseek-ai/dsh-session` 导出；不行就先做 `direct` surface 验证链路，provider 后补 |
| R2 | 外部 CLI 在 sandbox 外 | 任何写入任务 | 数据风险 | 默认只读；写入走 worktree；Skill 强制告知 |
| R3 | `maxActiveSubagents=8` 被 slim 角色占满 | 双插件同用 | 派发被拒 | `maxParallel=4`；把拒绝翻译成可读建议 |
| R4 | 两个 dispatch 工具同时存在 | 与 conductor 同装 | 模型选错工具 / 重复执行 | 运行期探测 + doctor 警告 + README 明说 |
| R5 | 输出爆炸打爆上下文 | Codex 详细日志 | 会话不可用 | 收集模式 `maxBytes` + head/tail 裁剪 + spill |
| R6 | Windows 进程树残留 | 取消/超时 | 后台孤儿 CLI 继续吃额度 | 依赖 `subprocess` 的 terminate 语义 + 真机 `Get-Process` 验收 |
| R7 | WSL 不可用（本机就是） | 用户环境 | 功能缺失 | doctor 报错码，不 fallback 假装可用 |
| R8 | 本机无工具链导致「装不上」 | 开发期 | 交付延误 | 零构建 ESM；用宿主自带 Node v24.21.0 做检查 |
| R9 | 索引收录延迟 | 发布后 | 用户找不到 | 首发同时提 awesome PR + dshbase；README 给「直接安装命令」兜底 |
| R10 | 宿主小版本漂移（rc.4+） | 上游更新 | 契约变化 | `engines` 收窄 + CI 矩阵 + 每次宿主升级跑 smoke |

---

## 9. 现在就能开工的顺序（按天）

**第 0 天（半天）—— 把唯一阻塞项查清**

```powershell
# 宿主自带 node，可直接用
$node = 'C:/Users/<you>/AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node --version                     # v24.21.0
```

要查清的 6 件事（都在 `resources/app.asar/dsh/node_modules/@deepseek-ai/` 里）：

1. `dsh-session` 是否导出 SessionId 铸造 helper（R1）。
2. `dsh-subprocess-local` 的 `terminate()` 是否整树（R6）。
3. `dsh-tool-subagent` 的 `provider` 是否允许 `omc:*`（应当允许，注册表按名字）。
4. `dsh-subagent` 的 `agentRouteDefaults` 缺失时是否影响外部 provider 装载。
5. `dsh-skills.register` 对 `content` 的长度/格式有无上限。
6. `dsh-plugin-manager` 对本地目录 `install_bundle` 的最小 manifest 要求（`files` 是否必须包含 `cordis.patch.yml`）。

**第 1 周**：PR 1–5（能装、能探测、能出报告）。此时已经可以给用户看「OMC 认识你的机器」。
**第 2 周**：PR 6–10（真派发、并行、取消）。
**第 3 周**：PR 11–15（Skill、E2E、打包、发布、收录）。

---

## 10. 与 v2.0 的差异清单（便于你直接改原文档）

| v2.0 说法 | 修正 |
|---|---|
| 「优先使用 DSH 官方 Provider；在不可用时才考虑 CLI」 | Desktop 0.2.1-rc.3 **没有任何外部 provider**，所以对 9 个外部 Harness 全部走 OMC 自己的 provider 适配；「优先官方」改为运行期探测（4.6） |
| 「官方 DSH 已支持可续接的本地子 Agent，外部 ACP Provider 每次新进程」 | 本地子 Agent 可续接 ✔；外部 ACP provider **在本安装中不存在**（只有源码仓库有） |
| 「按 DSH 官方文档发布 npm Bundle，再确认市场目录收录」 | 没有官方市场；Discover 只读用户添加的索引。必须走 awesome/dshbase/dsh-market 三条收录路径（6.3） |
| 「dsh-wsl 优先作为可选依赖」 | 改为**可选同伴**：不 import、不依赖；只沿用其环境约定，避免 10 个工具重复注册 |
| 单包结构里 `sessions.ts` 在 v0.3 | 保留，但明确它只存 `nativeSessionId` 映射，**不建数据库**，且续接由 adapter 做（4.5） |
| 「借鉴 Conductor 的检测与启动代码」 | 借鉴**事实**（argv/超时/裁剪），代码不复制；同装需二选一（R4） |

---

## 11. v0.1 验收记录（2026-10-29，本机）

环境：DSH Desktop `0.2.1-rc.3` · profile `desktop` · win32 x64 · Node v24.21.0 · 插件 `oh-my-coharness@0.1.0`。

| # | 验收项 | 结果 | 实测证据 |
|---|---|---|---|
| 1 | Desktop `install_bundle` / `remove_bundle` / 重装 | ✅ | 三次 `application: applied`；卸载后工具与 Skill 立即从目录消失 |
| 2 | 工具 / 命令 / Skill / provider 注册 | ✅ | 工具 `coharness` 可调用；`subagents: spawn, fork, omc:opencode, omc:codex, omc:claude, omc:gemini, omc:kimi` |
| 3 | 发现 native + WSL | ✅ | `opencode wsl:Ubuntu 2.1.4 ok`；其余 4 个 Windows 侧 CLI 正确 `missing` |
| 4 | 真实只读委派 | ✅ | opencode 读 `README.md` 并给三条要点，**7.2 s**，真实 child id |
| 5 | 一次调用并行 | ✅ | `tasks[]` 两个任务 → 两个 child id，**4.0 s / 3.1 s**（并发，总耗时≈max 而非 sum） |
| 6 | per-call 超时 | ✅ | `timeoutMs=1500` → `status: timeout` + `OMC/CLI-TIMEOUT`；部分输出保留 |
| 7 | 缺 CLI 的指引 | ✅ | 每行附官方安装命令 |
| 8 | 认证诚实 | ✅ | 只有 opencode（有 `auth list`）给 `ok`；其余保持 `unknown`/`missing` |
| 9 | 宿主自带 Node 上跑单测 | ✅ | `16/16`，含超时映射、env 注入、argv、路径转换、脱敏报告 |
| 10 | 环境变量注入（GLM 路径的机制） | ✅ | `OMC_ENV_PROBE` 在 WSL 子进程里读到 `coharness-env-ok` |
| 11 | 打包清单自检 | ✅ | `pack-check`：23 文件 / 154.5 KiB，导出目标全部命中 |

**本轮发现并修掉的两个真问题**

1. **per-call `timeoutMs` 在 provider 路径上被静默忽略。** 工具把超时放在 `DispatchRequest` 里，而 provider 只看得到 prompt —— 第一次实测 `timeoutMs=1500` 跑了 3.9 s 并报 `completed`。修法：把 per-call deadline 变成传给 `startActivation` 的 `AbortSignal`，结算后再用 `deadline.timedOut()` 把状态改判成 `timeout`。**这是 v0.1 唯一的架构性 bug**，也说明「同一个参数要能穿过 surface 边界」必须在测试里钉住。
2. **超时返回比 deadline 晚约 3 秒。** 1500 ms 的 deadline 实际 4.5 s 返回：1.5 s 到点 + 约 3 s 的进程退出与清理。把 `graceMs` 从 3000 降到 1500 **几乎没有改变这个数字**，说明主要成本在 WSL 侧进程退出与宿主结算，而不在宽限期。结论：这是真实退出成本，不该用「假装立刻返回」掩盖；改为在 README 里写清语义（*deadline 是任务截止，返回还要加进程退出时间*），并在 v0.2 用 server transport 的 `/interrupt` 消除它。

**仍未验证（不阻塞 v0.1 发布，但必须在 README 里写明）**

- 面板「停止」触发的取消路径（需要交互式操作，未做）。
- 跨**不同** Harness 的并行（本机只有一个可用 CLI；同 Harness 并行已验）。
- DSH 进程**重启后**插件仍加载（本轮全部走 HMR；重启验证留给发布前那次）。
- 0.2.1-rc.2 / 0.2.0 矩阵（本机只有 rc.3）。

## 12. 关于「参考 OpenCode 的 API」

结论：**值得参考，但 v0.1 不应该依赖它。** 详见 [`ADAPTER.zh-CN.md`](./ADAPTER.zh-CN.md) §12。三句话版本：

1. OpenCode 有一套完整的本地 HTTP API（本机残留的 `openapi.json` 是 3.1 规范、118 个路径），能力上比 CLI 强：会话可复用、`/wait` 有真实完成、`/diff` 提供产物、`/interrupt` 提供中断。
2. 但它要求 `opencode serve` 在跑、要处理端口/口令/生命周期，而 v0.1 的价值是「装完就能用」。把 CLI 作为默认 transport、HTTP 作为 v0.2 的可选 transport，是唯一能今天交付的顺序。
3. 真正应该从 OpenCode 抄的不是接口，而是**三个概念**：`provider/model` 字符串、`session id` 作为一等公民、`wait` 而不是轮询。

## 13. v0.1 收敛

v0.1 已在 `0.1.4` 冻结。范围、逐项门槛、残余风险与唯一的外部依赖（GLM 凭证）见
[`CONVERGENCE.md`](./CONVERGENCE.md)；发布与市场收录步骤见 [`MARKET.md`](./MARKET.md)。

冻结后不再向 v0.1 添加功能；任何新需求进入本文件 §5.2（v0.2）。

## 附录 A：本机探测原始结果

```text
DSH_PROFILE=desktop
DSH_PROFILE_DIR=C:/Users/<you>/.dsh\profiles\desktop
profile bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app
profile dependencies: {}   node_modules: (empty)

codex      -        claude     -        gemini     -        kimi   -
qwen       -        opencode   -        cursor-agent -      copilot -
grok       -        traecli    -        node       -        pnpm   -
npm        -        dsh        -
wsl        C:\WINDOWS\system32\wsl.exe   (wsl -l -v → Wsl/E_ACCESS_DENIED, exit 1)
git        \Git\cmd\git.exe              python  \Anaconda\python.exe
bundled node: v24.21.0 (win32 x64)

npm registry: oh-my-coharness → 404 (available)
npm registry: oh-my-dsh-slim@0.8.5 → engines.dsh >=0.2.0-rc.2 <0.3.0-0
npm registry: dsh-wsl-tool@2.2.3  → engines.dsh >=0.2.1-rc.2, keywords includes dsh-plugin
```

## 附录 B：待确认 API（开工前 30 分钟，逐条给验证方法）

| # | 问题 | 验证方法 |
|---|---|---|
| B1 | 外部 `SubagentRun.id` 怎么铸 | 读 `dsh-session` 的 `lib/types/index.d.ts` 导出列表 |
| B2 | `terminate()` 是否整树 | 读 `dsh-subprocess-local` README 的 signalling 段 |
| B3 | provider 名是否有保留字 | `ctx.subagents.list()` + `registerProvider` 抛错行为 |
| B4 | `delivery:'caller'` 时父会话是否仍写 catalog | `dsh-subagent` README 已写「caller 模式不写 catalog」，需确认对 UI 的影响 |
| B5 | `skills.register` 的 content 上限 | `dsh-skill` 校验逻辑 |
| B6 | 本地目录安装的最小 manifest | `dsh-plugin-manager` 的 `not-a-bundle` 判定条件 |
```
