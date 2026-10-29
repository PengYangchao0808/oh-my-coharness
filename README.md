# Oh My CoHarness

> 装一次，让你已经装好的 AI 编程 CLI 在 DeepSeek Harness 里一起干活。

**v0.1 目标（Connect）**：安装即发现本机有什么、把真实任务交给其中一个、失败时说清楚为什么。

- 一个 npm 包，零运行时依赖，零构建步骤（纯 ESM）
- Host-only bundle：**不碰 Web UI**
- 对外只有一个工具 `coharness`、一个命令 `/coharness doctor`、两个 Skill

> **状态：`0.1.7`，本机 Desktop 运行中。5 个外部 Harness 已全部装进 WSL 并被发现。**
> DSH 0.2.1-rc.3 · WSL Ubuntu 24.04 · Node 22.23.4（`/usr/local`，不动系统 node）
> 收敛报告：[`docs/CONVERGENCE.md`](docs/CONVERGENCE.md) · 设计与验收清单：[`docs/PLAN.zh-CN.md`](docs/PLAN.zh-CN.md) · 发布与收录：[`docs/MARKET.md`](docs/MARKET.md)

### 实测记录（2026-10-29，本机）

| 验收项 | 结果 | 证据 |
|---|---|---|
| Desktop 安装 / 卸载 / 重装 | ✅ | `application: applied`，卸载后 Skill 与工具立即消失 |
| 发现 native + WSL | ✅ | `opencode wsl:Ubuntu 2.1.4 auth:ok`；4 个 Windows 侧 CLI 正确报 `missing` |
| 真实只读委派 | ✅ | opencode 读 README 并给出三条要点，7.2s |
| 一次调用并行两个任务 | ✅ | 两个 child id，按输入顺序返回，4.0s / 3.1s（并发而非串行） |
| per-call 超时 | ✅ | `timeoutMs=1500` → `status: timeout` + `OMC/CLI-TIMEOUT`；部分输出保留。**返回比 deadline 晚约 3 秒**（进程退出与清理的真实成本，见下） |
| 认证诚实 | ✅ | `auth: ok` 仅在有稳定状态子命令时给出；其余保持 `unknown` |
| 缺 CLI 的指引 | ✅ | 每行附官方安装命令，不假装可用 |

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

## 安装（三种方式）

| 场景 | 做法 |
|---|---|
| Desktop | Plugins 界面安装包名 `oh-my-coharness`（或用本目录做本地安装） |
| 有 dsh CLI | `dsh plugin --profile <profile> add oh-my-coharness@0.1.0` |
| 本地开发 | 用 `plugin_manager` 的 `install_bundle`，`target` = 本目录绝对路径 |

装完**必须重启 DSH**：插件代码每个宿主进程只加载一次。

## 第一次使用

```
/coharness doctor
```

它不联网、不调模型、不花配额。本机真实输出：

```
Oh My CoHarness doctor — 2026-10-29T04:00:50.187Z
host: DSH 0.2.1-rc.3 · active profile · win32 x64 · node v24.21.0
subagents: spawn, fork, omc:opencode, omc:codex, omc:claude, omc:gemini, omc:kimi
capacity: omc maxParallel=4

harness     exec              version           auth        state
opencode    wsl:Ubuntu        2.1.4             ok          usable
codex       native:probe      -                 missing     missing (OMC/CLI-MISSING)
claude      native:probe      -                 missing     missing (OMC/CLI-MISSING)
gemini      native:probe      -                 missing     missing (OMC/CLI-MISSING)
kimi        native:probe      -                 missing     missing (OMC/CLI-MISSING)

wsl: ok · Ubuntu
plugins: no same-class plugin detected

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
- 因此 `mode` 默认 `read-only`；写入必须显式 `in-place`，v0.2 起默认走隔离 worktree。
- 任务文本会发给该 CLI 自己的服务商。不要把密钥或无关私有内容放进 prompt。
- OMC 不读 `~/.codex`、`~/.claude`、`~/.gemini` 的凭证，也不写它们。

## 能力与限制（v0.1）

| 已有 | 还没有 |
|---|---|
| 发现 native / WSL、版本、认证状态（诚实的 unknown） | 角色路由、自动选 Harness（v0.2） |
| 单任务派发 + `tasks[]` 并行 | worktree 隔离（v0.2） |
| 真实退出判定、超时、整树终止、输出裁剪 | council / ulw 工作流（v0.2） |
| 外部 CLI 作为 external child session | 原生会话续接、跨 Harness Handoff（v0.3） |
| 脱敏诊断报告 | 配置 UI（v0.2 起） |

## 开发

本机没有 `node`/`pnpm`/`dsh` 在 PATH 上，但 DSH Desktop 自带 Node：

```powershell
$node = 'C:/Users/<you>/AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

& $node scripts/check.mjs        # manifest + patch + locale + icon + 模块加载 + skill 前言
& $node test/smoke.test.mjs      # 11 个用例，全部 shim 掉 ctx，不需要真实 CLI
```

不要用 `node --test test/`：它会 spawn 子进程，在本机受限 token 下报 `EPERM`（这是沙箱边界，不是代码错误）。

目录：

```
src/index.js       入口：注册 provider / tool / command / skills
src/harnesses.js   定义表（新增 CLI 只改这里）
src/transport.js   argv、native/WSL 执行、裁剪、超时
src/provider.js    SubagentProvider 工厂
src/dispatch.js    DispatchRequest → DispatchResult[]
src/doctor.js      探测 + 脱敏报告
src/skills.js      把 skills/ 注册进 ctx.skills
```

想加一个 CLI？在 `harnesses.js` 加一条，并在 PR 里附上该 CLI 的 `--help` 实测记录。不要改 provider。

## 文档

- [`docs/PLAN.zh-CN.md`](docs/PLAN.zh-CN.md) — 完整开发方案：事实核查、复用矩阵、三阶段计划、发布路径、风险
- [`docs/ADAPTER.zh-CN.md`](docs/ADAPTER.zh-CN.md) — 适配层规范：宿主契约、provider 实现、并发语义、待确认 API
- [`docs/UPSTREAM.md`](docs/UPSTREAM.md) — 借鉴来源与署名

## 许可证

MIT。
