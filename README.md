# Oh My CoHarness

> 装一次，让你已经装好的 AI 编程 CLI 在 DeepSeek Harness 里一起干活。

**v0.3 目标（Roles on different CLIs）**：编排交给 DSH 原生能力，OMC 提供外部 Harness 通路、工作流纪律，以及一个「角色就是不同 CLI」的 agent preset。

- 一个 npm 包，零运行时依赖，零构建步骤（纯 ESM）
- Host bundle：**不写客户端代码**（一个 bundle patch 同时声明 Host 行与一个 agent preset）
- 对外只有一个工具 `coharness`、一个命令 `/coharness doctor`、五个 Skill
  （`coharness` / `coharness-setup` / `coharness-council` / `coharness-ulw` / `coharness-verify`）
- 新增 preset **`omc-harness`**：`subagent_codex` / `subagent_antigravity` / `subagent_opencode` / `subagent_kimi`
- `coharness` 的工具 Schema 仍然不变

> **状态：`0.3.0`，本机 Desktop 运行中（bundle 以 `link:` 指向本目录）。**
> DSH 0.2.1-rc.3 · WSL Ubuntu 24.04 · Node 24.21（Desktop 自带）
> 验收记录：[`docs/ACCEPTANCE-V0.2.md`](docs/ACCEPTANCE-V0.2.md) · 角色路由：[`docs/ROLE-ROUTING.zh-CN.md`](docs/ROLE-ROUTING.zh-CN.md) · 方案：[`docs/V0.2-PLAN.zh-CN.md`](docs/V0.2-PLAN.zh-CN.md)

### 实测记录（v0.1，2026-10-29，本机）

| 验收项 | 结果 | 证据 |
|---|---|---|
| Desktop 安装 / 卸载 / 重装 | ✅ | `application: applied`，卸载后 Skill 与工具立即消失 |
| 发现 native + WSL | ✅ | `opencode wsl:Ubuntu 2.1.4 auth:ok`；4 个 Windows 侧 CLI 正确报 `missing` |
| 真实只读委派 | ✅ | opencode 读 README 并给出三条要点，7.2s |
| 一次调用并行两个任务 | ✅ | 两个 child id，按输入顺序返回，4.0s / 3.1s（并发而非串行） |
| per-call 超时 | ✅ | `timeoutMs=1500` → `status: timeout` + `OMC/CLI-TIMEOUT`；部分输出保留。**返回比 deadline 晚约 3 秒**（进程退出与清理的真实成本，见下） |
| 认证诚实 | ✅ | `auth: ok` 仅在有稳定状态子命令时给出；其余保持 `unknown` |
| 缺 CLI 的指引 | ✅ | 每行附官方安装命令，不假装可用 |

### v0.2 实测（2026-10-29，本机）

运行中的 `0.2.0` 实例（不是 shim）。完整记录见 [`docs/ACCEPTANCE-V0.2.md`](docs/ACCEPTANCE-V0.2.md)。

| 验收项 | 结果 | 证据 |
|---|---|---|
| 五个 Skill 全部注册且可解析 | ✅ | `check ok … 5 skills`；单测逐个校验 frontmatter 与目录名 |
| Provider 面（`omc:<id>`） | ✅ | `doctor` 列出 6 个 `omc:*`；派发返回 `surface: provider` + 真实 `childId` |
| 两个不同 Harness 一次调用 | ✅ | `codex + opencode`：12.1 s / 4.4 s，两个 child id，同一调用返回 |
| 真并行（不是伪并行） | ✅ | 墙钟 ≈ 最慢席位，而非两席之和（12.1 s vs 16.5 s） |
| 只读真的没写工作区 | ✅ | 运行前后 `git status --porcelain` 都是 22 项，一致 |
| 显式 `in-place` 才写 | ✅ | codex 在临时目录写出 `OMC_LIVE_PROOF.txt`（内容 `OK`），`surface: direct` + 降级原因 |
| 并行写被拒 | ✅ | 两个 `in-place` 任务 → `OMC/PARALLEL-WRITE` |
| 部分失败隔离 | ✅ | 未知 harness `failed`，另一席照常 `completed` |
| Council（两席独立 + 主控合成） | ✅ | `codex + antigravity`，两席各自给出两条风险；合成本文见验收记录 |
| ULW 闭环 | ✅ | Build `STATUS: done` → Review `VERDICT: approve` → Verify `node test.mjs` exit 0 |
| auto 选择 | ✅ | `ok` 优先于 `unknown`；`signed-out` 被排除；全部不可用时逐行给原因 |
| 超限不丢任务 | ✅ | 5 任务 / `maxParallel=4` → `OMC/TOO-MANY-TASKS` + 拆分建议 |
| 完整卸载 / 重装 | ✅ | 卸载后工具、5 个 Skill、6 个 provider 全部消失；重装（`link:`）后恢复且不重复，profile 的 glm/envFile 配置保留 |
| Companion 检测 | ✅ | 装/不装 Slim 都报 `not detected (may be scoped)`：宿主作用域看不到 preset 作用域的角色工具，这正是不能断言「未安装」的原因 |
| Slim 共存（安装侧） | ✅ | `oh-my-dsh-slim@0.8.6` 已装，bundle/settings/preset 行都在运行中的树里；调用级验证需一个使用其 preset 的会话 |

> 未覆盖：Slim preset 会话里的调用级共存（需新建会话）、真实前后端双泳道、`npm publish`。见验收记录的「仍未覆盖」。

### v0.3 实测（2026-10-29，本机）

| 验收项 | 结果 | 证据 |
|---|---|---|
| preset 声明可解析 | ✅ | 用宿主自带的 `js-yaml`（含 `!!js` 标签）解析 `cordis.patch.yml`：2 个 patch、preset 20 个插件行 |
| preset 行已挂载 | ✅ | `Config.listConfigs` 出现 `include:preset-omc-harness`，与 4 个内置 preset 同级 |
| 四个角色绑定正确 | ✅ | 结构断言：`provider: 'omc:codex|antigravity|opencode|kimi'`、对应 `toolName`、`maxDepth: provider-managed` |
| 能力位不越界 | ✅ | 未写 `agentOptions` / `agentPreset` / `modelSelectionSettings`（外部 provider 不支持） |
| 新会话里调用 | ⏳ | 需要一个使用「OMC · 外部 Harness 角色」preset 的会话；本会话用的是默认 preset |

---

## 它做什么

```
你说：用 codex 读一下 README，给三条改进建议
  ↓
coharness 工具 → ctx.subagents.startActivation({ provider: 'omc:codex' })
  ↓
真实进程：codex exec "…"（用 Codex 自己的模型、自己的登录、自己的配额）
  ↓
结果回到会话；子会话面板里有一条 external 记录；可中断、计容量、有完成通知
```

三件事分开：

| 层 | 负责 | 不负责 |
|---|---|---|
| **Harness** | 认识哪个 CLI、怎么调它 | 调度 |
| **Transport** | native / WSL 的执行与输出事实 | 任务语义 |
| **Surface** | 把它变成 DSH 的 child session、工具、Skill | 进程管理 |

调度、容量、取消、完成判定都在宿主 `ctx.subagents` 里 —— OMC 不重写。

## 五个 Skill，一套派发语义

0.2.0 的全部「编排」都写进 Skill，而不是新代码。Skill 只在需要时才被模型加载：

| Skill | 什么时候加载 |
|---|---|
| `coharness` | 任何一次外部派发的纪律：写自包含任务、读结果、报失败 |
| `coharness-setup` | doctor 全是 `missing`，或用户问「怎么让它工作」 |
| `coharness-council` | 要两个**不同**模型独立评审，再由主控合成共识/分歧 |
| `coharness-ulw` | 多阶段：Plan → Explore → Build → Review → Verify，带门禁与单写者 |
| `coharness-verify` | 决定需要什么证据、拿到真实退出码后再宣布完成 |

Council 就是一次调用里的两个 task（不是两次串行调用，也不是同一个 CLI 跑两遍）：

```js
coharness({
  action: 'dispatch', mode: 'read-only', delivery: 'await',
  tasks: [
    { harness: 'codex', prompt: 'Independently review this design… <design>…</design>' },
    { harness: 'glm',   prompt: 'Independently review this design… <design>…</design>' },
  ],
})
```

主控不拼接两段输出，而是合成「共识 / 分歧 / 未验证 / 建议 / 置信度」，每条结论标来源。
只有一席成功时，必须说「这次不是完整 council」。

### 每个结果都说明自己从哪来

| 字段 | 含义 |
|---|---|
| `surface: provider` | 走宿主 `ctx.subagents`：有 `childId`、容量、子会话、完成通知 |
| `surface: direct` | 直接起进程的降级路径：**没有** `childId` / 容量 / 子会话 |
| `downgradeReason` | 为什么降级，例如 `mode in-place differs from the provider default read-only` |

### 0.2.0 明确的四个拒绝

| 情形 | 结果 |
|---|---|
| `tasks[]` 超过 `maxParallel` | `OMC/TOO-MANY-TASKS`，给拆分建议，**不丢任务** |
| 一次调用里多个 `in-place` 任务 | `OMC/PARALLEL-WRITE`，单写者，逐个调用 |
| direct 路径 + `delivery: 'background'` | `OMC/BACKGROUND-UNSUPPORTED`，建议改 `await` |
| `mode: 'worktree'` | 文本拒绝：0.2.0 未实现隔离工作区 |

auto 选择也变了：优先 `auth: ok`，再看定义表里 argv 是否实测过，**排除 `signed-out`**；一个都不可用时逐行说明原因（不是一句「没装 CLI」）。

### 原生 UI：不新增客户端半

0.2.0 没有一行前端代码，能复用的都复用：

| 状态 | 复用 |
|---|---|
| 子 Agent 执行与结果 | DSH 子会话面板（`surface: provider` 时） |
| 阶段进度 | `todo_write` |
| 原生 Workflow 阶段 | Workflow UI（走官方 `workflow` 时） |
| 配置 | Companion 用 Slim 设置卡；Standalone 用 `cordis.patch.yml` |
| 失败 / 取消 | 宿主工具结果与停止按钮 |

`surface: direct` 是唯一没有原生 UI 可复用的路径：它没有 `childId`，结果只出现在工具卡片与对话里。这是已知边界，不假装它有子会话。

## 角色就是不同 CLI（0.3.0 preset）

0.2.0 之前，「角色」和「外部 harness」是两条平行线：slim 的 `subagent_oracle` 永远跑在进程内子 Agent 上
（它的角色行把 `provider` 写死为 `spawn`），`coharness` 才是外部 CLI。0.3.0 用一个 preset 把两者接上：

```
Settings → Agent Presets → 「OMC · 外部 Harness 角色」
   ├─ subagent_codex        → omc:codex        架构 / 硬调试 / 实现评审
   ├─ subagent_antigravity  → omc:antigravity  UI / 视觉 / 前端
   ├─ subagent_opencode     → omc:opencode     代码库侦察
   ├─ subagent_kimi         → omc:kimi         长上下文阅读
   ├─ subagent / subagent_fork                 本地、可续接（需要追问时用）
   └─ coharness                                显式 mode / council / 未挂载的 harness
```

每个都是宿主原生的委派工具：真子会话、有 `childId`、计容量、有完成通知。硬约束：

- **只读**：工具没有 mode 参数，provider 固定用配置里的 `dispatch.defaultMode`（默认 read-only）。
  要写文件必须走 `coharness({ mode: 'in-place' })`。
- **一次性**：外部 CLI 不能追问、不能续接；要拿同一上下文继续，用 `subagent`。
- **缺 CLI 就不挂载**：工具在等 `subagent/provider-added`，不会给你一个必然失败的入口。
- **与 slim 并列**：选了这个 preset 就没有 slim 的 `subagent_*`；选了 slim 的就没有这四个工具。

细节与「为什么不能直接改 slim」见 [`docs/ROLE-ROUTING.zh-CN.md`](docs/ROLE-ROUTING.zh-CN.md)。

## 安装（三种方式）

| 场景 | 做法 |
|---|---|
| Desktop | Plugins 界面安装包名 `oh-my-coharness`（或用本目录做本地安装） |
| 有 dsh CLI | `dsh plugin --profile <profile> add oh-my-coharness@0.3.0` |
| 本地开发 | 用 `plugin_manager` 的 `install_bundle`，`target` = 本目录绝对路径 |

装完**必须重启 DSH**：插件代码每个宿主进程只加载一次。

## 第一次使用

```
/coharness doctor
```

它不联网、不调模型、不花配额。本机真实输出（2026-10-29，`0.2.0`）：

```
Oh My CoHarness doctor — 2026-10-29T13:25:55.612Z
host: DSH 0.2.1-rc.3 · active profile · win32 x64 · node v24.21.0
subagents: spawn, fork, omc:opencode, omc:codex, omc:antigravity, omc:glm, omc:gemini, omc:kimi
providers: omc:opencode, omc:codex, omc:antigravity, omc:glm, omc:gemini, omc:kimi
capacity: omc maxParallel=4

harness     exec              version           auth        state
opencode    wsl:Ubuntu        2.1.4             ok          usable
codex       wsl:Ubuntu        0.165.0           ok          usable
antigravity wsl:Ubuntu        1.4.10            ok          usable
glm         wsl:Ubuntu        2.1.312           unknown     usable
gemini      wsl:Ubuntu        0.66.0            unknown     usable
kimi        wsl:Ubuntu        2.4.0             unknown     usable

wsl: ok · Ubuntu
plugins: no same-class plugin detected
companion: not detected (may be scoped)
coharness: registered (preset visibility unverified)
recommended: Standalone 路径仍可用；若已装 Slim，检查 preset 的工具列表

next: 在任意会话里说「用 opencode 读一下 README 并给三条建议」，或调用 coharness({action:'dispatch'})。
redaction: 未包含 token / env / prompt / 对话内容
```

`auth: unknown` 是**正常**的：大多数 CLI 没有稳定的状态子命令。OMC 不会因为文件存在就断言「已登录」。
opencode 是例外 —— `opencode auth list` 便宜、稳定、离线，所以它能给出确定的 `ok`。

### Harness 支持矩阵（2026-10-29 实测）

适配层的风险不在「支持多少个品牌」，而在**argv 形态 + 环境前置 + 认证**。五个 CLI 已全部装进 WSL 并逐个核对过 `--help`：

| Harness | 形态 | 版本 | doctor 状态 | 缺什么才能真跑 |
|---|---|---|---|---|
| **opencode** | `run "<task>"` | 2.1.4 | `auth: ok` | — 已真实委派 |
| **codex** | `exec --skip-git-repo-check -s <sandbox> "<task>"` | 0.165.0 | `auth: ok` | — 已真实委派（16.6 s） |
| **kimi** | `-p "<task>" [-m model]` | 2.4.0 | `auth: unknown`（已登录） | — 已真实委派（7.8 s） |
| **antigravity** | `-p "<task>" [--model slug] [--sandbox]`（`agy`） | 1.4.10 | `auth: ok` | — 已真实委派（10.9 s；沙箱内读文件 13.2 s） |
| **gemini** | `-p "<task>" --skip-trust --approval-mode plan` | 0.66.0 | `auth: unknown` | **已被 Google 弃用**：免费 OAuth 返回 `UNSUPPORTED_CLIENT`，官方指向 Antigravity |
| **glm** | 同上（`claude` 二进制 + Z.ai 端点） | 2.1.312 | `auth: unknown`（端点连通） | — 已真实委派（3.9 s） |
| **claude** | `-p "<task>" --output-format text` | 2.1.312 | 关闭 | 无 Anthropic 号；已由 `glm` 接管 |
| qwen | `--prompt` | — | 未安装 | 多一个 npm 包 |

**适配层为此改了三处**（都是真跑之后才发现的）：

1. **codex 的 git 信任**：headless 下无法回答交互式提示，必须 `--skip-git-repo-check`，否则直接失败。
2. **gemini 的只读被静默覆盖**：目录不可信时 CLI 会把 `--approval-mode plan` 改回 `default` —— 必须同时给 `--skip-trust`，否则「只读」只是纸面承诺。
3. **`mode` 不再是 advisory**：codex 映射到 `-s read-only|workspace-write`，gemini 映射到 `--approval-mode plan|auto_edit`；没有沙箱开关的 CLI（opencode/claude/kimi）保持自己的默认，工具输出里会明说。

认证状态现在也尽量给确定值：`codex login status` 与 `claude auth status` 都有稳定退出码（未登录 = 1），所以 doctor 能显示 `signed-out` 而不是 `unknown`。gemini/kimi 没有状态子命令，保持 `unknown` —— 这是诚实，不是缺陷。

### 没有 CLI 的模型也能当 Harness

GLM 没有自己的命令行。它提供的是**协议端点**（Anthropic Messages 协议），所以任何 Anthropic 客户端都能驱动它：

```yaml
- id: oh-my-coharness
  name: oh-my-coharness
  config:
    harnesses:
      glm:                                   # bin 是 claude，端点换成 Z.ai
        enabled: true
        envFile: "C:/Users/<you>/.dsh/coharness.env"
```

`~/.dsh/coharness.env`（`chmod 600`，不进 profile patch）：

```
ANTHROPIC_AUTH_TOKEN=<你的 GLM Coding Plan key>
```

于是 **Harness = 二进制 × 端点 × 模型**，不是厂商。同一个 `claude` 二进制指向不同端点就是不同 Harness。这条链路的环境注入已实测（`OMC_ENV_PROBE` 在 WSL 子进程里读到了预期值），只差你的 key 就能把 `glm` 从 `missing` 变成 `usable`。

`env` 与 `envFile` 的优先级：**定义默认** < **行配置 `env`** < **`envFile`**。WSL 走 `export` 注入（保留 login PATH），native 走合并后的进程环境。

这是 v0.1 里最容易被忽略、也最容易让用户觉得「坏了」的一环：

1. **GUI 启动的进程继承的是系统 PATH，不是 shell profile 的 PATH。** 从开始菜单打开的 DSH Desktop 看不到你在终端里 `export` 的路径。
2. **Linux 侧的 CLI 根本不在 Windows PATH 里。** 本机的 opencode 装在 WSL Ubuntu 中（`/root/.opencode/bin` 一类不在 PATH 的位置），Windows 侧任何 `where` 都不可能找到它。

所以发现顺序是：**配置里写死的路径 → PATH → 常见安装根目录 → WSL 各发行版（PATH → 已知前缀 → 有界 `find`）**。
`exec` 列会显示它到底从哪来（`native:path` / `native:search` / `wsl:Ubuntu`），出问题时不用猜。

## 安全边界（请先读这段）

- 由 OMC 启动的外部 CLI **运行在 DSH 的 sandbox 与 approval 之外**。文件策略管不到它们，这与 `dsh-wsl` 的既有结论一致。
- 因此 `mode` 默认 `read-only`；写入必须显式 `in-place`。0.2.0 不做隔离 worktree，也不开放并行写入；0.2.1+ 再评估。
- 任务文本会发给该 CLI 自己的服务商。不要把密钥或无关私有内容放进 prompt。
- OMC 不读 `~/.codex`、`~/.claude`、`~/.gemini` 的凭证，也不写它们。

## 能力与限制（v0.3.0）

| 已有 | 还没有 |
|---|---|
| 发现 native / WSL、版本、认证状态（诚实的 unknown） | `coharness` 上的 `role` 字段 / 路由表（B 方案，未做） |
| 单任务派发 + `tasks[]` 并行（超限显式失败，不再丢任务） | worktree 隔离（0.2.1+；默认只读 + 显式 in-place） |
| 真实退出判定、超时、整树终止、输出裁剪 | 并行写入（不开放） |
| `surface` / `downgradeReason` 明示降级 | 新增 action（council / verify 都是 Skill） |
| 外部 CLI 作为 external child session | 原生会话续接、跨 Harness Handoff（v0.4） |
| `omc-harness` preset：`subagent_<harness>` 原生委派（只读、一次性） | 外部子 Agent 的追问 / 续接（provider 层不支持） |
| 脱敏诊断报告 + Companion 检测（detected，不是 verified） | 配置 UI（Companion 优先用 Slim 的设置卡） |
| council / ULW / verify 三个 Skill | 代码级门禁（若 Skill 被证明不够稳，再加字段） |

## 开发

本机没有 `node`/`pnpm`/`dsh` 在 PATH 上，但 DSH Desktop 自带 Node：

```powershell
$node = 'C:/Users/<you>/AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

& $node scripts/check.mjs        # manifest + patch + locale + icon + 模块加载 + 5 个 skill 前言
& $node test/smoke.test.mjs      # 36 个用例，全部 shim 掉 ctx，不需要真实 CLI
& $node scripts/live-check.mjs   # 真实 CLI 冒烟：两个 Harness、只读、并行、工作区不变
& $node scripts/pack-check.mjs   # npm pack 会真的带走哪些文件
```

不要用 `node --test test/`：它会 spawn 子进程，在本机受限 token 下报 `EPERM`（这是沙箱边界，不是代码错误）。

目录：

```
src/index.js       入口：注册 provider / tool / command / skills
src/harnesses.js   定义表（新增 CLI 只改这里）
src/transport.js   argv、native/WSL 执行、裁剪、超时
src/provider.js    SubagentProvider 工厂
src/dispatch.js    DispatchRequest → DispatchResult[]（auto、隔离、surface）
src/doctor.js      探测 + 脱敏报告 + Companion 检测
src/skills.js      五个 Skill 的注册表（导出 SKILLS 供自检复用）
scripts/live-check.mjs  真实 CLI 冒烟（不随包发布）
```

想加一个 CLI？在 `harnesses.js` 加一条，并在 PR 里附上该 CLI 的 `--help` 实测记录。不要改 provider。
想加一个 Skill？在 `src/skills.js` 的 `SKILLS` 加一行，再建同名目录；`check.mjs` 与 `pack-check.mjs` 会自动发现。

## 文档

- [`docs/PLAN.zh-CN.md`](docs/PLAN.zh-CN.md) — 完整开发方案：事实核查、复用矩阵、三阶段计划、发布路径、风险
- [`docs/V0.2-PLAN.zh-CN.md`](docs/V0.2-PLAN.zh-CN.md) — v0.2 极薄桥接方案：三个 Skill、dispatch 可靠性、Slim Companion、A–H 验收、五 PR / 三检查点
- [`docs/ACCEPTANCE-V0.2.md`](docs/ACCEPTANCE-V0.2.md) — v0.2 验收记录：A–H 每一条的证据与未完成项
- [`docs/ROLE-ROUTING.zh-CN.md`](docs/ROLE-ROUTING.zh-CN.md) — 「角色 → 不同 harness」的现状、差距与两条落地路线（0.2.1 / 0.3）
- [`docs/ARCHITECTURE.zh-CN.md`](docs/ARCHITECTURE.zh-CN.md) — OMC / OMD / DSH 的拓扑：三个 preset、两条委派通路、谁能调用谁
- [`docs/ADAPTER.zh-CN.md`](docs/ADAPTER.zh-CN.md) — 适配层规范：宿主契约、provider 实现、并发语义、待确认 API
- [`docs/UPSTREAM.md`](docs/UPSTREAM.md) — 借鉴来源与署名

## 许可证

MIT。
