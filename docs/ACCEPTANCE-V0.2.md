# Oh My CoHarness v0.2 验收记录

> 对应 [`V0.2-PLAN.zh-CN.md`](./V0.2-PLAN.zh-CN.md) §7 的 A–H 矩阵 · 2026-10-29
> 环境：DSH Desktop `0.2.1-rc.3` · win32 x64 · WSL Ubuntu 24.04 · Node `v24.21.0`（Desktop 自带）
> bundle 以 `link:E:\Calculations\Plugins\Oh-My-CoHarness` 安装，**本目录就是被加载的插件**

**这份记录只写跑过的东西。** 没跑的一律标 ⏳，不用「应该没问题」代替证据。

## 本轮怎么验的

| 手段 | 命令 / 动作 | 覆盖 |
|---|---|---|
| 单元 / 结构测试 | `node --test test/smoke.test.mjs` | 35 个用例，全部用 `ctx` shim |
| 包自检 | `node scripts/check.mjs` | manifest、patch、locale、icon、9 模块、5 个 skill 前言 |
| 打包清单 | `node scripts/pack-check.mjs` | `npm pack` 会带走的 29 个文件 |
| 真实 CLI 冒烟（脱离宿主） | `node scripts/live-check.mjs` | 真实发现 + 真实派发（重启前用它先验过 0.2.0 代码） |
| **运行中的 0.2.0 实例** | `coharness` 工具 + `doctor` | 下面所有「本轮真机」条目 |

插件是**停用 → 启用**（`plugin_manager set_plugin include:oh-my-coharness`）完成热加载的：
停用后 5 个 Skill 从会话消失，启用后重新出现，`doctor` 立刻多了 `providers:` 行——
说明加载的是本目录的新代码，不是旧实例。

## A–H

| Case | 目标 | 状态 | 证据 |
|---|---|---|---|
| **A** | 不装 Slim 也能完成一次 Council | ✅ | `codex + antigravity` 两席只读、`surface: provider`、各自独立作答；主控合成见下 |
| **B** | OMC + Slim 共存 | 🟡 | `oh-my-dsh-slim@0.8.6` 已装、bundle/preset 行已挂载；宿主级检测正确地报 `not detected (may be scoped)`（角色工具是 preset-scoped，**这正是不能断言「未安装」的原因**）。「主 Agent 同时看到 `subagent_*` 与 `coharness`」仍需一个使用**极简角色委派** preset 的会话 |
| **C** | 两 Harness 并行、不丢任务、耗时 ≈ max | ✅ | `tasks[]` 两席：12.1 s / 4.4 s，两个 `childId`，同一调用返回；另有 4 轮历史数据 |
| **D** | Council 部分失败仍返回另一席 | ✅ | `nope` + `codex`：`failed 0.0s · OMC/UNKNOWN-HARNESS`，另一席照常 `completed` |
| **E** | ULW 分阶段，Build 后才 Review | ✅ | 真机跑完 Plan→Build(`STATUS: done`)→Review(`VERDICT: approve`)→Verify(exit 0)，见下 |
| **F** | 前后端拆分与集成 | 🟡 | 契约 / 文件归属 / 单写者 / 集成测试均已实测；**尚未**跑一个真正的前端 + 后端双泳道项目 |
| **G** | 默认只读、写必须显式 `in-place`、无并行写入 | ✅ | 只读后 `git status` 仍 22 项（与基线一致）；显式 `in-place` 只在临时目录写出 `OK`；并行写被 `OMC/PARALLEL-WRITE` 拒绝 |
| **H** | Desktop / WSL 安装、停止、重启、卸载 | ✅ | 完整卸载 → 重装已跑：工具/Skill/provider 随卸载消失，重装后恢复且不重复；profile 配置（glm/envFile）保留，见下 |

## 本轮真机运行记录

### 0. 启动后的关键事实：provider 面曾整个丢失（已修）

第一次 `doctor`（重启后、修复前）：

```text
subagents: spawn, fork
#1 codex · completed · 13.5s · surface: direct
   degraded: omc:codex is not registered as a provider
```

根因：Loader 行序不是插件能决定的，`apply()` 执行时 `subagents` 服务还不在；
一次性注册失败被静默吞掉，整个 `omc:<id>` provider 面就消失了。

修复后（同一次会话，停用→启用热加载）：

```text
subagents: spawn, fork, omc:opencode, omc:codex, omc:antigravity, omc:glm, omc:gemini, omc:kimi
providers: omc:opencode, omc:codex, omc:antigravity, omc:glm, omc:gemini, omc:kimi
```

做法：`ctx.inject(['subagents'])` 等待服务出现 + 每次工具调用前重试 + `doctor` 打印
`providers:` / `provider issues:`。注册保持幂等（`registered` Set）。

### 1. Case C —— 一次调用两个 Harness（provider 面）

```text
#1 codex    · completed · 12.1s · surface: provider · child omc-4502660f-e369-40c8-8ea1-916d38e1e991
#2 opencode · completed ·  4.4s · surface: provider · child omc-144e1114-357a-46f2-881e-4e91778e7ecc
```

两个真实 child id，按输入顺序返回；墙钟 ≈ 12.1 s 而不是 16.5 s 之和。

### 2. Case D —— 一个任务失败不影响另一个

```text
#1 nope  · failed    · 0.0s  · surface: -
   note: OMC/UNKNOWN-HARNESS: unknown harness "nope"
#2 codex · completed · 13.0s · surface: provider · child omc-e928d461-…
```

### 3. Case A —— 真机 Council（codex + antigravity，只读、互不可见）

同一份设计问题分别发给两席：

> Independently review this design in at most 60 words: list exactly two concrete risks. …
> DESIGN: coharness runs two external CLIs in parallel read-only, then the lead synthesises their answers.
> Batches over maxParallel are refused; background delivery on the direct surface is refused.

**seat A (codex)** — 16.7 s：

> 1. "Read-only" CLIs may still transmit repository contents or secrets to external services; filesystem restrictions alone do not prevent data leakage.
> 2. If one CLI hangs or fails, synthesis may stall indefinitely or proceed with incomplete evidence unless explicit timeouts, cancellation, and partial-result handling are defined.

**seat B (antigravity)** — 18.8 s：

> 1. **Head-of-line blocking:** Refusing background delivery forces synchronous execution; if either external CLI hangs or slows down, the lead stalls and requests time out.
> 2. **Unresolved output conflicts:** When the CLIs return contradictory findings, the lead lacks deterministic arbitration rules, risking hallucinated or arbitrary synthesis.

**主控合成**

- **共识**：两席独立地指向同一处——**失败/超时后的合成规则缺失**。codex 说「synthesis 可能卡住或带着不完整证据继续」，antigravity 说「同步执行造成队头阻塞」。来源：seat A(2) + seat B(1)。
- **不同层面的分歧**：codex 关心**数据外泄**（只读 ≠ 不外传）；antigravity 关心**冲突裁决**（矛盾结论没有仲裁规则）。两者互补，不矛盾。
- **未验证**：两席都只是设计推理，没有证据或实测；都没提到「只读强度不同」（opencode/kimi/glm 的只读是 advisory）；都没读过实现。
- **建议**：① 每席必须有超时，且部分失败时明说「这次不是完整 council」（Skill 已要求）；② 结论冲突时**不要合成**，列分歧并要证据；③ 评审优先用强制沙箱的 codex / gemini / antigravity；④ 容量与阻塞由主控拆批、写入串行解决。
- **置信度**：中高——失败路径的担忧两席独立重合；数据外泄合理但未测量。

### 4. Case G —— 只读不写、写只在显式 `in-place`、并行写被拒

```text
#1 codex · completed · 17.4s · surface: direct
   degraded: mode in-place differs from the provider default read-only
```

```text
Temp\omc-live-923d9b5b\OMC_LIVE_PROOF.txt   2 bytes   →  OK
repo changed entries: 22   （与运行前完全一致）
```

两个结构闸门也在真机触发过：

```text
Error: OMC/PARALLEL-WRITE: 2 in-place tasks would write concurrently; 0.2.0 is single-writer — run them one call at a time
Error: OMC/TOO-MANY-TASKS: 5 tasks exceed maxParallel=4; split them into 2 calls of at most 4
```

以及 `BACKGROUND-UNSUPPORTED`（direct + background）：

```text
#1 codex · failed · 0.0s · surface: direct
   degraded: mode in-place differs from the provider default read-only
   note: OMC/BACKGROUND-UNSUPPORTED: the direct surface has no completion notice; use delivery "await"
```

### 5. Case E —— 一次真实的 ULW 闭环（临时项目）

契约：`fizz.js` 导出 `fizz(n)`（3 的倍数返回 `Fizz`，否则 `String(n)`）；
`test.mjs` 断言 `3→Fizz`、`5→'5'`、`15→Fizz` 并打印 `ALL PASS`；验收命令 `node test.mjs`；
文件所有权只有这两个文件；**单写者**（codex）。

| 阶段 | 执行者 | 证据 |
|---|---|---|
| Plan | 主控 + `todo_write` | 契约、文件边界、验收命令 |
| Build | codex，`mode: in-place` | 23.6 s，只创建两个文件，footer `STATUS: done` |
| Review | antigravity，`mode: read-only` | 16.1 s / 复跑 15.0 s，`surface: provider`，footer `VERDICT: approve` |
| Verify | 宿主 Node | `node test.mjs` → `ALL PASS`，**exit 0** |

Review 的结论原文：

> `fizz.js` correctly satisfies the contract … `test.mjs` properly imports and validates all test cases.
> VERDICT: approve

产物（临时目录，不进仓库）：`fizz.js` 93 B、`test.mjs` 232 B。

> 诚实说明一处异常：第一次 Review 返回了 `surface: direct` 却没带 `downgradeReason`（8 次派发里仅此一次，未复现）。
> 现在渲染层对「direct 但没有原因」补了一句 `degraded: direct surface (no reason reported)`，不再让它看起来像完整能力。

### 6. Case H —— 完整卸载 → 重装（真机）

```text
plugin_manager remove_bundle oh-my-coharness   → changed: true, applied
   5 个 coharness* Skill 立即从会话目录消失；profile 的 dependencies/bundles 都不再含它
plugin_manager install_bundle E:\...\Oh-My-CoHarness → changed: true, version: 0.2.0
   Skill 立刻回来；doctor 恢复 6 个 omc:* provider（无重复）
```

| 检查 | 结果 |
|---|---|
| 卸载后工具 / Skill / provider 消失 | ✅（Skill 目录实时消失；`subagents` 列表无 `omc:*`） |
| 重装后恢复且**不重复** | ✅ `providers:` 恰好 6 条，`subagents:` 无重复项 |
| profile 配置不丢 | ✅ patch 里 `glm.enabled=true` + `envFile`、`claude.enabled=false` 原样保留，doctor 仍显示 glm |
| 仓库本体不受影响 | ✅ `src/index.js` 仍在；依赖仍是 `link:E:/...` |
| 重装后真的能跑 | ✅ `OMC-REINSTALLED`，`surface: provider`，child `omc-dfe259ad-…` |

### 7. Case B —— 装 oh-my-dsh-slim（0.8.6）后的共存现状

```text
install_bundle oh-my-dsh-slim@0.8.6 → applied（pnpm 2.1s，license MIT）
profile bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, oh-my-dsh-slim, oh-my-coharness
Config 目录: include:oh-my-dsh-slim (schema), include:oh-my-dsh-slim-profiles (schema),
             include:preset-oh-my-dsh-slim (absent = preset 行无 config schema，属正常)
```

- Slim 的 bundle / settings / preset 行都已经在运行中的树里。
- **doctor 仍然报 `companion: not detected (may be scoped)`** —— 这不是回归，而是设计：
  `subagent_*` 是 agent/preset 作用域的工具，host 作用域的 `ctx.tools.get()` 看不到它。
  这一条恰好证明了方案里「检测不到 ≠ 未安装」的写法是必要的。
- 静态检查 Slim 的 preset 源码：`tools.restrict` 只作用于**子角色**（`role-composition.js`），
  orchestrator 不受过滤，因此 `coharness` 不会被它挡掉；但这只是读代码的结论，不是运行时证据。
- 真正的一步验证需要：**重启后新建一个使用「极简角色委派」preset 的会话**，
  确认该会话里 `subagent_*` 与 `coharness` 同时可见，再各调用一次。

### 8. 0.3.0 —— `omc-harness` preset（角色 = 不同 CLI）

**目标**：让「把这件事交给 oracle」真的在 Codex 上跑，而不是在进程内换个人格。

| 检查 | 结果 | 证据 |
|---|---|---|
| preset 声明合法 | ✅ | 用宿主自带 `js-yaml`（注册 `!!js` 标签）解析：2 个 patch 条目、preset 20 个插件行 |
| 四个角色绑定 | ✅ | `provider: 'omc:codex / omc:antigravity / omc:opencode / omc:kimi'` + 对应 `toolName` + `maxDepth: provider-managed` |
| 能力位不越界 | ✅ | 未写 `agentOptions` / `agentPreset` / `modelSelectionSettings`；外部 provider 这三项都是 false |
| 安装生效 | ✅ | `install_bundle` 报 `version: 0.3.0`；`Config.listConfigs` 出现 `include:preset-omc-harness`（与 4 个内置 preset 同级） |
| 回归未破坏 | ✅ | 36/36 单测；`check ok … 5 skills`；`pack-check` 30 文件；`coharness doctor` 仍列出 6 个 `omc:*` |
| 新会话里真的能调 | ⏳ | 需要你新建一个使用「OMC · 外部 Harness 角色」preset 的会话 |

**为什么不能直接改 slim 来达到同样效果**（读源码的结论）：

- slim 的角色行写死 `provider: 'spawn'`（`preset.js` → `roleRow()`），子 Agent 永远是进程内 DSH Agent；
- 它的按角色 `provider/model` 是**模型路由**，不是「换一个 CLI」；
- 外部 provider 没有 `prepareContinuable`，slim 的「后台优先 + 可续接 + `send_message`」在这条路上不成立。

所以 0.3.0 走的是「并列 preset」路线：不 fork、不重写 slim，只是用宿主自己的
`@deepseek-ai/dsh-tool-subagent` 把委派工具接到 `omc:<id>`。

**已知边界**：外部子 Agent 只读（provider 固定 `dispatch.defaultMode`，工具无 mode 参数）、
一次性（不能追问）、缺 CLI 就不挂载；写文件仍必须走 `coharness({ mode: 'in-place' })`。

## 仍未覆盖（需要你决定或操作）

| 项 | 为什么现在做不了 | 怎么做 |
|---|---|---|
| Case B 的调用级验证 | 需要把会话切到 Slim 的 preset；本会话的 preset 由 GUI 决定 | 重启 → Settings → Agent Presets 选「极简角色委派」→ 新建会话 → 先 `coharness({action:'doctor'})`，再各调一次 `subagent_*` 与 `coharness` |
| `omc-harness` 的调用级验证 | 同上，需要一个使用新 preset 的会话 | Settings → Agent Presets 选「OMC · 外部 Harness 角色」→ 新建会话 → 先 `coharness({action:'doctor'})`，再让 `subagent_codex` 做一次只读评审 |
| Case F 的双泳道 | 需要一个真实的前端 + 后端项目 | 用一个真实小项目走一遍「先契约 → 只读并行调研 → 串行写 → 主控集成」 |
| `npm publish` | 本机没有 `npm` | 用 `pack-check` 的输出作发布前对照，再在联网机器上 `npm publish --tag latest` |

## 并发注记（沿用方案 §7）

`dispatch.maxParallel` 只是**单次调用**的任务上限，不是全局并发控制：

- provider 路径受宿主 `maxActiveSubagents`（默认 8）约束；
- direct 路径没有宿主容量槽，并发与写入风险要分别测；
- 0.2.0 **不做并行写入**：`OMC/PARALLEL-WRITE` 已拒绝一次调用里的多个 `in-place` 任务；
  「两次先后调用同时写」仍由主控负责串行。

## 结论

A / C / D / E / G / **H** 已在**运行中的 0.2.0** 上跑过并留下证据；
F 的控制机制（契约、文件归属、单写者、集成测试）已实测，缺的是一个真实双泳道项目；
**B 已装好 Slim 并确认其 bundle / settings / preset 行都在运行中的树里**，
只差一次「新建使用 Slim preset 的会话」来做调用级共存验证。
本轮另外修掉了一个会让整个 provider 面消失的注册缺陷（0.2.0 内修复，未改工具 Schema）。

**0.3.0 新增**：`omc-harness` preset 把角色委派真正接到了外部 CLI 上（§8）。
声明已解析、行已挂载、结构断言与回归全绿；调用级验证同样只差一次「用该 preset 新建会话」。

> 环境提示：本机 profile 现在同时装有 `oh-my-dsh-slim@0.8.6` 与 `oh-my-coharness@0.2.0`（link）。
> 若不想要 Slim，可在 Plugins 面板卸载它；OMC 不依赖它。
