> **历史文档（v0.2 / v0.3）**：v0.4.0-alpha.1 已将 OMD v0.8.6 源码合并进 Oh My CoHarness，
> 文中“OMC 与 OMD 两个插件并存 / 两套角色入口”的前提不再成立。
> 当前架构、角色后端与迁移方式见 [`ARCHITECTURE.zh-CN.md`](./ARCHITECTURE.zh-CN.md)、
> [`MIGRATION.md`](./MIGRATION.md)。

# 适配层规范（ADAPTER）

> 配套 [`PLAN.zh-CN.md`](./PLAN.zh-CN.md)。本文回答一个问题：**怎样把一个外部 CLI 变成一个合格的 Harness，同时不重写宿主已经做好的事。**
> 文中代码是骨架，不是已编译产物；标 `// VERIFY` 的地方是开工第 0 天要确认的 API（见 PLAN 附录 B）。

---

## 1. 三层，一层一个决定

```
Harness（跑谁）   ← 纯数据：定义表 harnesses.js
   ↑
Transport（怎么跑）← 纯函数：argv 组装 + spawn/either-wsl，一个入口 runHarness()
   ↑
Surface（怎么进 DSH）← 薄包装：provider（推荐）/ direct（fallback）
```

规则的收益：

- 新增一个 CLI = 在定义表里加一条 + 写一段 `--help` 实测记录。**不改 provider，不改工具，不改 Skill。**
- 新增一个执行环境（比如以后接 SSH）= 加一个 transport 装饰器。不动 Harness 表。
- 新增一个入口（比如 v0.3 的 workflow 引擎）= 复用 `runHarness()`，不碰上游。

---

## 2. 宿主契约（已验证，逐字来自本机安装）

### 2.1 `SubagentProvider` / `SubagentRun` / `SubagentResult`

```ts
// @deepseek-ai/dsh-subagent 0.2.1-rc.3
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
export interface SubagentCapabilities {
  readonly agentOptions: boolean      // 能否给子 Agent 指定 provider/model
  readonly agentPreset: boolean       // 能否给子 Agent 指定 preset
  readonly outputSchema: boolean      // 能否要求结构化输出
  readonly depthLimit: boolean        // 深度是否由宿主按数字强制
}
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  readonly cwd: string                // 宿主已按父会话解析成绝对路径
}
export interface SubagentStartRequest {
  readonly cwd?: string
  readonly agentPreset?: string
  readonly label?: string
  readonly prompt: ContentBlock[]     // 注意：不是字符串
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number
}
export interface SubagentRun {
  readonly id: SessionId              // 外部 provider 自己铸（VERIFY B1）
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}
export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}
```

注册方式：`ctx.subagents.registerProvider(provider)`，返回 disposal。（已验证）

### 2.2 `ctx.subprocess`（已验证）

```ts
spawn(spec: {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe' | { data: string }
    stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
    stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
  }
  graceMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}): SubprocessHandle

interface SubprocessHandle {
  stdin?: Writable; stdout?: Readable; stderr?: Readable
  collected: { stdout?: { readFrom(byte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
               stderr?: { ... } }
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
resolveExecutable(command: string, env?, signal?): Promise<string>
```

三个必须利用的性质：

1. `resolveExecutable` 会**校验绝对路径**并拒绝含分隔符的相对路径 —— 探测阶段就用它，别自己拼 PATH。
2. 收集模式是**按偏移非消费式**读取，且带 `lossy` / `spillPath` —— 截断事实由它给，我们不猜。
3. `terminate()` 走 provider 自己的终止过程（Windows 上是 ACL 受限 token 下的整树终止）。**不要**自己 `taskkill`。

### 2.3 一次 `startActivation` 的真实语义（已验证）

- 父会话调用后立即拿到 `childId`（外部子会话 `mode: 'external'`，只执行一次，不接受后续消息）。
- `delivery: 'parent'` → 结算后父会话收到一条 completion notice（模型可见）；`delivery: 'caller'` → 不发通知，由调用方 `await run.result`。
- `result` 在**句柄清理、容量释放、通知发出之后**才结算。这就是「真实完成」，不需要轮询。
- 容量超限抛 `ACTIVATION_LIMIT_REACHED`；id 冲突抛 `DUPLICATE_CHILD`；未注册 provider 抛 `UNSUPPORTED_CAPABILITY`。

---

## 3. Harness 定义表（`src/harnesses.js`）

只写「确定的事实」，未实测的字段打 `verified: false`，doctor 里不会因此报 `ok`。

```js
{
  id: 'opencode',
  label: 'opencode',
  bin: 'opencode',
  argv: (task, o) => ['run', ...(o.model ? ['--model', o.model] : []), task],
  versionArgs: ['--version'],
  // 唯一有便宜、稳定、离线状态命令的 CLI
  authProbe: { argv: ['auth', 'list'], okExit: 0 },
  capabilities: { write: true, model: true, resume: false, json: true, stdin: false },
  install: 'curl -fsSL https://opencode.ai/install | bash   (inside WSL/Linux)',
  verified: true,   // 2026-10-29 实测 2.1.4：wsl:Ubuntu，auth ok，只读委派 7.2s
}
```

opencode 的三个特有事实（都来自实测）：

- 模型 id 是 `provider/model`（本机默认 `zai-coding-plan/glm-5.3`），所以配置项 `harnesses.opencode.model` 必须原样透传，不能拆开。
- 它常常装在 WSL 里且**不在 PATH**（本机在 WSL 的私有前缀下），Windows 侧 `where` 永远找不到 → 发现顺序里必须有 WSL 回退。
- `auth list` 让它是唯一能给出确定 `auth: ok` 的 Harness；其余保持 `unknown`。

其余条目：
```js
/** @typedef {import('./types.js').HarnessDef} HarnessDef */

export const HARNESSES = [
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // 已由 conductor 字段实测：codex exec "<task>"
    argv: (task, o) => ['exec', ...(o.model ? ['-m', o.model] : []), task],
    versionArgs: ['--version'],
    authProbe: { argv: ['login', 'status'], okExit: 0 }, // unverified: 版本差异大
    resume: 'unverified',                                  // v0.3
    capabilities: { write: true, model: true, resume: false, json: false, stdin: false },
    install: 'npm i -g @openai/codex',
    notes: '需要 trusted git repo 作为 cwd；sandbox_mode 默认 read-only',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    argv: (task, o) => ['-p', task, '--output-format', 'text', ...(o.model ? ['--model', o.model] : [])],
    versionArgs: ['--version'],
    authProbe: null,                                       // 无稳定 status 子命令 → unknown
    capabilities: { write: true, model: true, resume: false, json: true, stdin: false },
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    argv: (task, o) => ['-p', task, ...(o.model ? ['-m', o.model] : [])],
    versionArgs: ['--version'],
    authProbe: null,
    capabilities: { write: true, model: true, resume: false, json: true, stdin: false },
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    bin: 'kimi',
    argv: (task, o) => ['--prompt', task],
    versionArgs: ['--version'],
    authProbe: null,
    capabilities: { write: true, model: false, resume: false, json: false, stdin: false },
    install: 'npm i -g @moonshot-ai/kimi-code',
    notes: 'npm 包名不是 kimi-cli（那是空壳包）',
  },
  // qwen / opencode / cursor / copilot / grok：v0.1 只登记不默认启用，
  // argv 形态来自 conductor 的 registry，逐条实测后再标 verified。
]
```

约定：

- `argv(task, opts)` 返回**数组**，绝不拼字符串、绝不经过 shell —— 任务文本里的引号、`$`、反引号都不会变成命令。
- 每个 CLI 的 headless 形态在合入前必须有一条 `--help` 实测记录，写在 PR 描述里。
- `authProbe` 只在「有便宜且无副作用的子命令」时配置；否则 `auth: 'unknown'`。**默认 unknown 是正确行为，不是缺陷。**

---

## 4. Transport（`src/transport.js`）

### 4.1 一个入口

发现顺序（`planTransport`），**每一步都必须能被 doctor 看见**：

1. `harnesses.<id>.command` 显式路径（用户兜底，最高优先级）
2. `ctx.subprocess.resolveExecutable(bin)` —— PATH
3. `hostCandidates(bin)` —— GUI 进程拿不到的常见安装根目录（`%LOCALAPPDATA%\Programs`、`%APPDATA%\npm`、`~/.local/bin`、`~/.bun/bin`、scoop、WinGet Links…）
4. WSL：`wsl.exe -l -q` 拿发行版 → 每个发行版里 `command -v` → 已知前缀（`~/.<bin>/bin`、`/root/.<bin>/bin`、`/usr/local/bin`…）→ **有界 `find`**（`timeout 8`）

第 3、4 步不是过度设计：本机的 opencode 是第 4 步第 3 条才找到的。少了它，doctor 会说「没装」，而用户明明装了。

```js
export async function launch(ctx, info, { task, cwd, timeoutMs, maxOutputBytes, signal }) {
  const argv = info.argv(task, { model: info.model })
  const spec = info.transport === 'wsl'
    ? wslSpec(ctx, info, argv, cwd, maxOutputBytes, signal, timeoutMs)
    : nativeSpec(ctx, info, argv, cwd, maxOutputBytes, signal, timeoutMs)
  const handle = ctx.subprocess.spawn(spec)
  return { handle, cwdUsed: spec.cwd, argvUsed: spec.argv }
}
```

### 4.2 native

```js
function nativeSpec(ctx, info, argv, cwd, maxOutputBytes, signal, timeoutMs) {
  return {
    argv: [info.exe, ...argv],          // info.exe 来自 resolveExecutable
    cwd,
    stdio: {
      stdin: { data: '' },              // 显式 EOF：交互式 CLI 不会卡住
      stdout: { maxBytes: maxOutputBytes, spill: { maxBytes: 64 * 1024 * 1024 } },
      stderr: { maxBytes: Math.min(8192, maxOutputBytes) },
    },
    graceMs: 3000,
    signal: withTimeout(signal, timeoutMs, ctx),   // 我们自己的 AbortSignal 组合
  }
}
```

### 4.3 wsl 装饰器

```js
function wslSpec(ctx, info, argv, winCwd, maxOutputBytes, signal, timeoutMs) {
  const linuxCwd = toWslPath(winCwd, info.distro)      // C:\a\b → /mnt/c/a/b
  const script = `cd ${shellQuote(linuxCwd)} && ${argv.map(shellQuote).join(' ')}`
  return {
    argv: ['wsl.exe', ...(info.distro ? ['-d', info.distro] : []), '-e', 'bash', '-lc', script],
    cwd: process.env.WINDIR ?? 'C:\\Windows',           // wsl.exe 本身在 Windows 侧运行
    stdio: { /* 同上 */ },
    graceMs: 3000,
    signal: withTimeout(signal, timeoutMs, ctx),
  }
}
```

注意三点（都是从 dsh-wsl 的既有事实里学到的，不复制代码）：

1. 必须 `-e`（`--exec`），否则默认 `--` 会破坏引号和变量。
2. 长脚本超过 Windows 命令行上限（32767）时要改走 stdin：`wsl.exe -e bash -ls`，把脚本写到 stdin。
3. `wsl.exe` 在 subprocess 之下 → **文件策略管不到**。文档必须写这句。

### 4.4 裁剪与事实

```js
function readOutput(handle, maxBytes) {
  const out = handle.collected.stdout?.readFrom(0)
  const err = handle.collected.stderr?.readFrom(0)
  return {
    stdout: clip(out?.text ?? '', maxBytes),          // head 40% + tail 60%
    stderr: clip(err?.text ?? '', 8192),
    truncated: Boolean(out?.lossy || err?.lossy),
    spillPath: out?.spillPath,
  }
}
```

`truncated` 只能来自 `lossy` 或长度比较，**不能靠猜**。

---

## 5. Provider（`src/provider.js`）

```js
import { mintRunId } from './ids.js'   // VERIFY B1：见 §9

/** 为某个 harness 造一个 SubagentProvider */
export function makeProvider(ctx, info, config) {
  return {
    name: `omc:${info.id}`,
    inheritsParentContext: false,                 // 外部 CLI 看不到父对话 → 宿主自动给正确措辞
    capabilities: {
      agentOptions: false,                        // 不把 DSH 的模型路由强加给 CLI
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,                          // 递归预算归 CLI 自己
    },
    async start(request) {
      const task = blocksToText(request.prompt)   // ContentBlock[] → string
      const { handle, cwdUsed, argvUsed } = await launch(ctx, info, {
        task,
        cwd: request.cwd,
        timeoutMs: config.timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: request.signal,
      })

      const result = (async () => {
        const outcome = await handle.done            // 真实退出，不是读一行 stdout
        const captured = readOutput(handle, config.maxOutputBytes)
        const ok = outcome.exitCode === 0
        return {
          output: [{ type: 'text', text: ok ? captured.stdout : renderFailure(info, outcome, captured) }],
          stopReason: request.signal.aborted ? 'aborted' : ok ? 'completed' : 'error',
          diagnostic: ok ? undefined : `${info.id}: exit ${outcome.exitCode ?? outcome.signal}`,
        }
      })()

      return {
        id: mintRunId(),
        result,
        dispose: async () => {
          handle.terminate()
          await handle.waitForExit()                 // 等真实退出，再交还容量
        },
      }
    },
  }
}
```

设计要点：

- **不 catch 全部错误当 success**。非 0 退出 → `stopReason: 'error'`，让宿主把它标成失败。
- `dispose()` 必须 `await waitForExit()`：容量槽在清理完成后才归还，否则并发时会「幽灵占位」。
- `result` 里只放**给模型看的文本**；完整 stdout 在 spill 文件里，路径写进 `diagnostic` 而不是正文（避免撑爆上下文）。

---

## 6. Dispatch（`src/dispatch.js`）

### 6.1 `await` 模式（council / ulw 需要同步拿结果）

```
tool.execute
  └─ for each task (≤ maxParallel):
        activation = ctx.subagents.startActivation({ provider:`omc:${id}`, label, request:{ cwd, prompt, parent }, signal, delivery:'caller' })
        results[i] = await activation.result            // 结算 = 清理完成
        await activation.dispose()
  └─ 返回 DispatchResult[]（顺序与 tasks 对齐，失败也占位）
```

要点：`delivery:'caller'` 不发父通知，工具自己渲染结果 —— council 要的正是「拿到全部再合成」。失败的任务**不打断其它任务**，各自落 `status`。

### 6.2 `background` 模式（长任务）

```
tool.execute
  └─ activation = startActivation({..., delivery:'parent'})
  └─ 立即返回 { status:'started', childId }
（之后）宿主 settlement notice 到达父会话 → 模型整合
```

模型侧的纪律（写进工具描述 + Skill，两处都要）：

> 收到 `started subagent <id>` 不等于任务完成。在 completion notice 到达之前，不要声称该任务已完成，也不要用轮询去等它 —— 继续做别的事，或者结束这一轮。

### 6.3 fallback：`direct` surface

仅当 `ctx.get('subagents') === undefined`（老宿主 / 精简 composition）时启用：
工具自己 `launch()` → `await handle.done` → 自己渲染。行为对齐，但没有 catalog / 容量 / 面板可见性，doctor 里要标 `surface: direct (degraded)`。

### 6.4 错误码表（稳定字符串，用户可搜索）

| code | 触发 | 给模型的建议 |
|---|---|---|
| `OMC/CLI-MISSING` | `resolveExecutable` 抛错 | 给出官方安装命令，不要重试 |
| `OMC/CLI-TIMEOUT` | 自己的 signal 触发 | 缩小任务或调大 `timeoutMs` |
| `OMC/CLI-EXIT` | 退出码非 0 | 读 stderr 尾部，不要原样重跑 |
| `OMC/CAPACITY` | `ACTIVATION_LIMIT_REACHED` | 等一个完成或减少 `tasks` |
| `OMC/DUPLICATE` | `DUPLICATE_CHILD` | 内部错误，重试一次 |
| `OMC/WSL-UNAVAILABLE` | `wsl -l -v` 非 0 | 装发行版或换 native |
| `OMC/NO-PROVIDER` | 未注册（配置禁用） | 提示启用哪个 harness |

---

## 7. Doctor（`src/doctor.js`）

```js
export async function doctor(ctx, config, { signal } = {}) {
  const rows = []
  for (const def of HARNESSES) {
    if (!enabled(def, config)) continue
    let exe, version, auth = 'missing'
    try {
      exe = await ctx.subprocess.resolveExecutable(def.bin, undefined, signal)
      version = await probeVersion(ctx, def, exe, signal)          // 3s 上限
      auth = await probeAuth(ctx, def, exe, signal)                 // 没有 probe → 'unknown'
    } catch (e) {
      rows.push({ ...base(def), auth: 'missing', detail: codeOf(e) })
      continue
    }
    rows.push({ ...base(def), command: exe, version, auth })
  }
  // WSL 单独一段（可能整段不可用）
  const wsl = await probeWsl(ctx, config, signal)
  return renderReport({ host: hostFacts(ctx), rows, wsl, plugins: probePlugins(ctx) })
}
```

规则：

- 全部探测都有 3 秒硬上限，汇总上限 10 秒；**任何一项失败只让该项变红**。
- `probePlugins` 用 `ctx.tools.get('conductor_dispatch')` / `ctx.tools.get('wsl')` 判断同类插件。
- `renderReport` 里所有路径经 `redactPath()`；默认只输出二进制名，不输出绝对路径。
- 报告末尾固定一行：`redaction: 未包含 token / env / prompt / 对话内容`。

---

## 8. 并发时序（多 Harness）

```
时间 →
父 Agent   ── coharness(tasks:[codex,gemini,kimi]) ──┐
                                                     ├─ startActivation(omc:codex)  → childId A
                                                     ├─ startActivation(omc:gemini) → childId B
                                                     └─ startActivation(omc:kimi)   → childId C
宿主容量    [A:1][B:2][C:3]                    （上限 8，OMC 自限 4）
进程        codex.exe ─┐  gemini.exe ─┐  kimi.exe ─┐
退出        ───────────┘（各自 done）──┘───────────┘
结算        result A / B / C 依次结算（清理完成后）
工具        组装 DispatchResult[]，按 tasks 顺序返回
```

关键点：

- 顺序按输入对齐，不按完成顺序 —— 否则模型会把结果错配到任务上。
- 一个失败不取消其它（除非用户中断）。
- 用户中断 → 每个 `activation.dispose()` 并发执行，等全部 `waitForExit()` 再返回。

---

## 9. 待确认 API 的兜底写法

| 项 | 兜底 |
|---|---|
| `mintRunId()`（B1） | 优先用宿主导出的铸造函数；否则 `crypto.randomUUID()` 加品牌断言（TS）或直接字符串（JS）。外部 run 的 id 只要在宿主 id 命名空间内唯一即可。 |
| `blocksToText()` | `ContentBlock[]` 里只取 `type:'text'`；遇到 `image`/`file` 时在 prompt 里留一行 `[attachment omitted: image]`，**不要**假装 CLI 能看到图。 |
| `withTimeout()` | 用 `AbortSignal.any([signal, AbortSignal.timeout(ms)])`（Node 20+ 原生），再包一层把 `TimeoutError` 映射成 `OMC/CLI-TIMEOUT`。 |
| v0.3 resume flag | 每个 CLI 现查现测，写在 `harness.resume = { args: (id)=>[...], verifiedOn: '0.151.0' }`；没有实测就保持 `false`，`DispatchResult.nativeSessionId` 留空。 |

---

## 10. 建议的 `Handoff` 结构（v0.3，先设计不实现）

```ts
export interface Handoff {
  goal: string
  decisions: Array<{ what: string; why: string; evidence?: string }>
  artifacts: Array<{ kind: 'file' | 'diff' | 'commit' | 'test'; ref: string; note?: string }>
  openQuestions: string[]
  constraints: string[]
  nextHarness: string
  budget: { maxOutputBytes: number }
}
```

序列化后作为**下一个 prompt 的前缀**，而不是塞进 DSH 的会话历史。理由：外部 CLI 拿不到 DSH 的 history，硬塞会把 token 花在无关上下文上；`Handoff` 的全部价值就是「取舍后剩下的最小集合」。

---

## 11. 验收脚本（手工，v0.1）

```powershell
# 1) 安装后立刻：不花钱的诊断
/coharness doctor

# 2) 真实只读派发（await）
#    在会话里说：用 coharness 让 codex 读 README 并给三条改进建议，只读

# 3) 并行 + 目录可见
#    让 coharness 同时派 codex 与 gemini，然后看子会话面板是否有两条 external 记录

# 4) 取消
#    派一个长任务 → 面板停止 → 验证没有孤儿进程
Get-Process codex,gemini,kimi -ErrorAction SilentlyContinue

# 5) 超时
#    coharness({ action:'dispatch', harness:'codex', prompt:'...', timeoutMs: 5000 })
#    期望 status: timeout，工具 5–8 秒内返回
```

以上 5 条全绿，才算 v0.1 的 Connect 目标达成。

（2026-10-29 实测：1 / 2 / 3 / 5 已通过，4 待做。见 PLAN §11。）

---

## 12. OpenCode 作为参考实现（后续版本的 server transport）

> **2026-10-29 修订**：0.2.0 不实现 server transport；本节保留为后续版本的设计参考，标题里的 `v0.2` 读作「后续版本」。

### 12.1 手上有什么

本机残留了一份 OpenCode 的接口快照（2026-10-15 恢复时导出）：`openapi.json` = **OpenAPI 3.1，`opencode HttpApi`，118 个路径**，服务版本 `2.0.29`；现装 CLI 为 `2.1.4`。`model_catalog.json` 里有 130 个模型 / 10 个 provider。

对 OMC 直接用得上的端点：

| 端点 | 用途 | 对 OMC 的价值 |
|---|---|---|
| `POST /api/session` | 建会话 | **v0.3 的 `nativeSessionId`** 天然存在 |
| `POST /api/session/{id}/prompt` | 发任务 | 与 CLI 的 `run` 等价，但可复用会话 |
| `GET /api/session/{id}/wait`（实验） | **等这一轮真的结束** | 完成判定不靠抓 stdout |
| `POST /api/session/{id}/interrupt` | 中断 | 取消不需要杀进程树 |
| `GET /api/session/{id}/diff` | 产出 diff | 直接填 `DispatchResult.artifacts` |
| `GET /api/session/{id}/context` | 上下文用量 | 成本可见 |
| `POST /api/session/{id}/model` | 切模型 | 角色 → 模型映射 |
| `POST /api/session/{id}/shell` | 在会话里跑 shell | 给未来的验证步骤用 |

### 12.2 真正该抄的是三个概念

1. **`provider/model` 字符串**：一个字段同时表达「用谁的模型」，不需要两级选择器。OMC 的 `harnesses.<id>.model` 直接沿用它。
2. **session id 是一等公民**：建会话先拿 id，任务挂在 id 上，恢复用 id。DSH 的外部 provider 是一次性执行，所以这个 id 只能由 OMC 自己保管 —— 这正是 v0.3 `sessions.json` 的形状。
3. **`wait` 而不是轮询**：调用方等一个「真的结束了」的承诺，而不是每 500 ms 读一次输出猜。

### 12.3 CLI vs server：为什么 v0.1 只能是 CLI

| 维度 | CLI `opencode run` | HTTP `opencode serve` |
|---|---|---|
| 安装后可用 | ✅ 直接 | ❌ 要先起服务 |
| 会话复用 | 仅 `--continue/--session`（待实测） | ✅ 原生 |
| 完成判定 | 进程退出 | ✅ `/wait` |
| 产物 | 自己解析 diff | ✅ `/diff` |
| 中断 | 杀进程树 | ✅ `/interrupt` |
| 失败模式 | 简单（exit code） | 端口、口令、常驻进程、崩溃重启 |
| 依赖 | 无 | 要管一个子进程的生命周期 |

v0.1 的承诺是「装完就能用」，所以默认 CLI；server 作为 v0.2 的可选 transport，配置 `harnesses.opencode.transport: 'server'` 才启用。**两条路共用同一个 `DispatchResult`，Skill 不用改。**

### 12.4 v0.2 的 server transport 形状（设计，不实现）

```
ensureServer():
  argv = ['opencode','serve','--port','0']        // 0 让系统分配，具体 flag 待实测
  从 stdout 解析实际端口 → cache { port, pid, startedAt }
  禁止复用历史 service.json 里的固定端口与口令

dispatch():
  sid  = POST /api/session
  POST /api/session/{sid}/prompt { model, parts }
  await GET /api/session/{sid}/wait        // 真实完成
  artifacts = GET /api/session/{sid}/diff  // 填 DispatchResult.artifacts
  return DispatchResult{ nativeSessionId: sid, ... }

abort():
  POST /api/session/{sid}/interrupt         // 优先
  超时后仍走进程树终止                       // 兜底
```

### 12.5 不要做的事

- **不内嵌 `@opencode-ai/sdk`**：会把 OMC 的版本生命週期绑到别人的 SDK 上，也违背「零依赖」。
- **不把它的 `service.json` 当配置源**：那个文件里是固定端口 + 口令，属于运行时状态，不是接口契约。
- **不假定服务常驻**：任何一次失败都要能退回 CLI transport，并在 `diagnostics` 里说明退回了。

