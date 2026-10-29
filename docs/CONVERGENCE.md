# v0.1 收敛报告

**结论：v0.1 阶段冻结，交付包为 `oh-my-coharness@0.1.4`。**
剩下只有一个「需要你的凭证」的动作（GLM 端点接入），它不阻塞冻结，已被隔离成一步可执行操作。

冻结日期：2026-10-29 · 宿主：DSH Desktop `0.2.1-rc.3` · profile `desktop` · win32 x64

---

## 1. 冻结了什么

| 维度 | 冻结内容 |
|---|---|
| 对外接口 | 工具 `coharness`（3 个 action）、命令 `/coharness doctor`、Skill 2 个、provider `omc:<id>` |
| 数据契约 | `HarnessInfo` / `DispatchRequest` / `DispatchResult`（含 `nativeSessionId`/`artifacts`/`workspace` 三个预留字段） |
| 配置面 | `surface`、`transport`、`harnesses.<id>.{enabled,command,model,transport,distro,timeoutMs,env,envFile}`、`dispatch.*`、`wsl.distro`、`privacy.*` |
| Harness 表 | 7 条：opencode、glm、codex、claude、gemini、kimi、qwen（其中 opencode 已实测） |
| 发布物 | 1 个 npm 包，23 个文件，154.5 KiB unpacked，零依赖 |

**不再往 v0.1 里加东西。** 任何新需求进 v0.2 议题。

## 2. 明确不在 v0.1 范围内

> **2026-10-29 修订**：v0.2 已按复审收窄为 Skill-first 薄桥接（见 [`V0.2-PLAN.zh-CN.md`](./V0.2-PLAN.zh-CN.md)）。角色路由、worktree、配置卡移出 0.2.0（0.2.1+ 视需要）；council / ULW 以 Skill + 现有 `tasks[]` 实现；opencode server transport 延后。

- 角色路由 / 自动选 Harness（0.2.1+ 视需要；0.2.0 用 Skill 约束）
- worktree 隔离（0.2.1+）、`ulw` / `council` 工作流（0.2.0 用 Skill + `tasks[]`）
- opencode 的 HTTP server transport（后续版本）
- 原生会话续接、跨 Harness Handoff（v0.3）
- 配置卡 UI、客户端半（0.2.x，且只在需要时）
- 统一会话数据库 —— 永久不做

## 3. 验收门槛逐项状态

| # | 门槛 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | Desktop 安装 / 卸载 / 重装 | ✅ 实测 | 5 轮 `application: applied`，卸载后工具与 Skill 立即消失 |
| 2 | 工具 / 命令 / Skill / provider 注册 | ✅ 实测 | `subagents` 列表含 5 个 `omc:*` |
| 3 | native + WSL 发现（含非 PATH 路径） | ✅ 实测 | opencode 2.1.4 由 WSL 的有界 `find` 找回 |
| 4 | 真实只读委派 | ✅ 实测 | opencode 读 README，7.2 s；回归 4.1 s |
| 5 | 一次调用并行 | ✅ 实测 | 两个 child id，4.0 / 3.1 s |
| 6 | per-call 超时 | ✅ 实测 | `timeoutMs=1500` → `timeout` + `OMC/CLI-TIMEOUT` |
| 7 | 环境变量注入（GLM 路径的机制） | ✅ 实测 | `OMC_ENV_PROBE` 在 WSL 子进程里读到 `coharness-env-ok` |
| 8 | 缺 CLI 的指引 / 认证诚实 | ✅ 实测 | 每行附安装命令；codex/claude 给出 `signed-out`，gemini/kimi 保持 `unknown` |
| 9 | 单测 | ✅ 17/17 | 全部 shim 掉 `ctx`，不需要真实 CLI |
| 10 | 打包清单 | ✅ 自检 | `pack-check` 24 文件，导出目标全部命中 |
| 11 | 面板「停止」的取消路径 | ⚠️ 未实测 | 需要交互式操作；`dispose()` 路径已有单测覆盖 |
| 12 | 跨**不同** Harness 并行 | ✅ 实测 | gemini 2140 ms 与 kimi 2079 ms；另一次 codex 16.6 s 与 kimi 7.8 s 真模型并发 |
| 13 | DSH 进程重启后仍加载 | ✅ 实测 | 用户重启后（GUI 端口 64346 → 50600）插件仍加载，doctor 正常 |
| 14 | 0.2.1-rc.2 / 0.2.0 矩阵 | ⚠️ 未实测 | 本机只有 rc.3 |
| 15 | GLM 端点真实委派 | ⛔ 阻塞 | 需要你的 z.ai key（见 §4.1） |
| 16 | 五个外部 CLI 的安装与发现 | ✅ 实测 | codex 0.165.0 / claude 2.1.312 / gemini 0.66.0 / kimi 2.4.0 / opencode 2.1.4，全部 `wsl:Ubuntu` |
| 17 | argv 适配（对真实 `--help` 核对） | ✅ 实测 | 改出 3 个真问题：codex git 信任、gemini 只读被覆盖、kimi 缺 `-m` |
| 18 | 认证失败的报告质量 | ✅ 实测 | codex 401、gemini exit 41、kimi exit 1，原文保留且指向下一步 |
| 19 | 有模型的真实委派（非 opencode） | ✅ 实测 | codex `CODEX-LIVE` 16.6 s、kimi `KIMI-LIVE` 7.8 s；doctor 中 codex 转 `auth: ok` |
| 20 | Antigravity 能否复用 Google 登录 | ✅ 已否证 | 无 `gemini` 二进制；GCA 模式仍要求重新授权并阻塞等 TTY |
| 21 | Antigravity CLI 安装与真实委派 | ✅ 实测 | `agy` 1.4.10 → `AGY-LIVE` 10.9 s；`--sandbox` 下读 README 13.2 s；doctor 由 `signed-out` 转 `ok` |
| 22 | GLM（Claude Code + Z.ai 端点）真实委派 | ✅ 实测 | `GLM-LIVE` 3.9 s；env 文件在 Windows 侧、由宿主注入 WSL `export`，整条链路打通 |

> **运行态 vs 磁盘态。** profile 里记的是 `link:<workspace>`，
> 磁盘上的交付当前是 **0.1.7**，运行中的进程也是 0.1.7（每轮改动都走了一遍
> `remove_bundle` → `install_bundle`，并已做过一次整机重启验证）。
> 规则不变：**热加载能换插件行，换不了已加载的模块代**；改完代码要么重装、要么重启。

## 4. 剩下的凭证类动作

### 4.1 GLM（无 Anthropic 账号时的 Claude Code 形态）

Node 22 与 Claude Code 已经装好（见 §6 基线），只差一个 key。

**密钥文件必须放 Windows 侧** —— `envFile` 由宿主进程（Windows）读取，写到 WSL 的
`~/.dsh/` 里插件是读不到的：

```powershell
# Windows 侧（PowerShell）
$dir = "$env:USERPROFILE\.dsh"; New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content -Path "$dir\coharness.env" -Value "ANTHROPIC_AUTH_TOKEN=YOUR_ZAI_KEY" -NoNewline
icacls "$dir\coharness.env" /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
```

```bash
# 先在 WSL 里单独验证端点（读同一个文件，走 /mnt/c）
export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
export ANTHROPIC_AUTH_TOKEN=$(grep -oP '(?<=^ANTHROPIC_AUTH_TOKEN=).*' /mnt/c/Users/<you>/.dsh/coharness.env)
claude -p "reply with exactly: GLM-OK" --output-format text
```

然后在 `cordis.patch.yml` 打开条目：

```yaml
- id: oh-my-coharness
  name: oh-my-coharness
  config:
    harnesses:
      glm: { enabled: true, envFile: "C:/Users/<you>/.dsh/coharness.env" }
      claude: { enabled: false }   # 没有 Anthropic 账号就别让它一直红着
```

### 4.2 Gemini（OAuth 已走不通，只剩 API key）

**2026-10-29 实测结论：个人免费版 OAuth 登录成功，但请求被拒。**

用户在自己的终端里完成 `gemini` 的 Google 登录（"Authentication succeeded" ×2），
随后的一次派发返回：

```
Exit 1 · IneligibleTierError
reasonCode: UNSUPPORTED_CLIENT
tierName:  Gemini Code Assist for individuals
message:   This client is no longer supported for Gemini Code Assist for individuals.
           To continue using Gemini, please migrate to the Antigravity suite of products
```

也就是说：**身份层成功、授权层被 Google 关掉了**。Gemini CLI 不再允许个人免费版走
Code Assist，官方把用户往 Antigravity 赶。

| 方式 | 现状 | 说明 |
|---|---|---|
| Google 账号 OAuth（个人免费） | ❌ 不可用 | 登录能过，请求被 `UNSUPPORTED_CLIENT` 拒绝 |
| Google 账号 OAuth（**付费** Code Assist 席位） | 未知，可能可用 | 有 Workspace/Code Assist 许可证的账号不受这条限制 |
| **API key（AI Studio）** | ✅ 推荐 | 走 Gemini API 自己的配额，完全绕开 Code Assist 的层级校验 |

API key 的接法（key 放 Windows 侧，因为 `envFile` 由宿主进程读取）：

```powershell
Add-Content -Path "$env:USERPROFILE\.dsh\coharness.env" -Value "GEMINI_API_KEY=你的key"
```

```yaml
    harnesses:
      gemini: { envFile: "C:/Users/<you>/.dsh/coharness.env" }
```

> ⚠️ **不要设 `GOOGLE_GENAI_USE_GCA=true`。** 实测它会打印
> "Opening authentication page in your browser. Do you want to continue? [Y/n]"
> 然后**阻塞等 TTY**（75 s 后被我们的超时杀掉）。在派发场景里这就是一次挂起。

> 这条错误本身是 OMC 的正面证据：CLI 的真实拒绝原因被原样带了回来，
> 而不是被折叠成「失败了」。用户照着 `reasonMessage` 就能找到下一步。

### 4.3 Antigravity：IDE 不能替代 Gemini CLI，但 **Antigravity CLI 可以**

先说否证：`E:\Antigravity` 里只有 IDE 启动器，**没有 `gemini` 二进制**；它确实共用
`~/.gemini` 目录，但那是命名空间共用、不是凭证共用；打开 GCA 模式后 Gemini CLI 仍然
要求重新授权（Antigravity 的 `jetski-standalone-oauth-token` 它不读）。

但这不代表 Antigravity 没法用 —— 它有**官方 CLI**（`agy`），而且正是 Google 在
`UNSUPPORTED_CLIENT` 里指向的东西：

| 项 | 值 |
|---|---|
| 官方安装 | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| 二进制 | `~/.local/bin/agy`（归档里叫 `antigravity`，安装器改名） |
| 版本 | **1.4.10**（本机已装，222 MB） |
| headless | `agy -p "<task>"`，`--output-format text\|json\|stream-json` |
| 结构化 | `--json-schema` → `structured_output`；`json` 信封带 `conversation_id`/`usage` |
| 续接 | `--continue` / `--conversation <id>` |
| 限制 | `--sandbox`、`--print-timeout`（默认 5m）、`--model`（`agy models` 列 slug） |
| 认证 | headless **只用缓存凭证**：必须先跑一次交互式 `agy`（需要 TTY） |

**本机安装的现实**：WSL 直连 `storage.googleapis.com` 只有 **19 KiB/s**（63.7 MiB 要
一小时），同一文件在 Windows 上是 30–107 KiB/s。所以最终做法是：Windows 用 `curl`
下完 → 送进 WSL → `tar` 解包 → `install -m 755` 到 `~/.local/bin/agy`，再补一个
`/etc/profile.d/omc-local-bin.sh` 让登录 shell 也能找到它。

`agy` 与 gemini-cli 的关系：**接替，不是同一个**。gemini-cli 的个人免费层被关，
`agy` 是同一个 Google 账号体系下的新客户端；两者凭证目录不同
（`~/.gemini/oauth_creds.json` vs `~/.gemini/antigravity-cli/`），不能互用。

结论：**Gemini 这条线应当改走 `agy`**，而不是继续修 gemini-cli 的 OAuth。
`agy` 未登录前 doctor 显示 `auth: signed-out`（探测用 `agy models` 的退出码），
登录后即可派发。

最后 `/coharness doctor` + 一次只读派发，把 `glm.verified` 翻成 true。

## 5. 残余风险（已知且已记录）

| 风险 | 影响 | 处置 |
|---|---|---|
| 第三方 Anthropic 端点不是官方支持 | `--output-format text` 可能被忽略、输出带 ANSI | 头部/尾部裁剪兜住体积；`glm` 保持 `verified: false` 直到跑通 |
| 超时后返回晚约 3 秒 | 用户感知为「慢」 | 已在 README 写明语义：deadline 是任务截止，返回还要加退出时间 |
| `mode` 只对有沙箱开关的 CLI 生效 | codex/gemini 已映射；opencode/claude/kimi 用各自默认 | 工具输出固定说明；0.2.0 在 Skill 里声明限制，worktree 0.2.1+ 再评估 |
| WSL 侧进程退出成本 | 取消/超时延迟 | 后续版本的 server transport 用 `/interrupt` 消除 |
| 四个 CLI 未登录 | 派发会以 401 / exit 41 / exit 1 失败（信息清晰） | 各自跑一次登录；`docs/CONVERGENCE.md` §7 给了命令 |

## 6. 环境基线（2026-10-29，`0.1.7`）

装这些东西没有改动系统 Node，也没有改动任何现有配置：

| 项 | 值 | 说明 |
|---|---|---|
| WSL | Ubuntu 24.04.2 LTS · kernel 5.15.167.4 · 用户 `root` | 唯一发行版 |
| Node | **v22.23.4**（`/usr/local/lib/nodejs/…` + `/usr/local/bin` 软链） | 遮蔽而非替换 `/usr/bin/node`（v18.19.1）；删软链即回退 |
| npm | **10.9.9**，`prefix=/usr/local` | 否则 global bin 会落进 node 自己的目录、不在 PATH |
| codex | 0.165.0 | `npm i -g @openai/codex` |
| claude | 2.1.312 | `npm i -g @anthropic-ai/claude-code` |
| gemini | 0.66.0 | `npm i -g @google/gemini-cli` |
| kimi | 2.4.0 | `npm i -g @moonshot-ai/kimi-code` |
| opencode | 2.1.4 | 既有的自包含二进制，未改动 |

安装脚本与日志留在 `.ops/`（`node-setup.sh`、`cli-fix.sh`、`probe2.sh` 及各 `.log`），可复现、不进 npm 包。

## 7. 交接一句话

> 五个 CLI 已装好并被正确发现，argv 已对着真实 `--help` 校准；现在缺的只是**四个登录**和**一个 key**，不是代码。

登录命令（各自在 WSL 里跑一次即可，OMC 不接触凭证）：

```bash
codex login                 # ChatGPT 账号
claude auth login           # 有 Anthropic 账号才需要；没有就走 glm
kimi login                  # 设备码流程
# gemini：设置 GEMINI_API_KEY，或在 ~/.gemini/settings.json 里选认证方式
```

GLM 那条线见 §4，放一个 key 就能把 `glm` 从 `missing` 变成 `usable`。

后续按 `docs/MARKET.md` 发布，按 `docs/PLAN.zh-CN.md` §5 进入 v0.2。
