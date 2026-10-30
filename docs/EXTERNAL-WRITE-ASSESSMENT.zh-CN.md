# 外部可写角色 + CLI 可插拔：影响评估与方案

> 评估对象：Oh My CoHarness v0.4.0-alpha.1（DSH 0.2.1-rc.3，Windows，WSL Ubuntu）
> 触发需求：让 10 个角色都能自由绑定不同 CLI，**尤其是 designer 使用更强的前端模型**，且 CLI 绑定要可插拔、符合 DSH「一切皆插件」。
> 状态：评估结论。**落地进展（2026-10-30）**：P0 的卡片字段与路线 D 的 designer 只读 patch 已实现（未发布）；P1 声明式注册表与 P2 外部可写未做。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 能力否？ | **能**，但可写的「外部」只能建立在一个前提上：该 CLI 自己有**可界定的写沙箱** |
| 谁满足？ | 只有 `codex`（`-s workspace-write`，`src/harnesses.js:49-58`）；`gemini` 的 `auto_edit` 自动批准，`antigravity` 默认放行，`claude/glm/kimi/opencode` **连写 flag 都没有** |
| 能否保住 DSH 审批/沙箱？ | **不能**。宿主没有给外部进程的写/审批入口（见 §2），native 侧本身也没有审批门（见 §1.3） |
| 推荐路线 | **P0 + P1 立刻做；P2（patch 产出式外部写，仅 codex）进 v0.5；放弃 B；C 可选** |
| designer 的正确解法 | 先 P0 原生 pin 强模型；确需前端强 CLI，则让其**只读产出 patch**，由 native 侧落地 |

### 落地状态

| 项 | 状态 |
|---|---|
| P0.1 原生 pin 强模型 | 卡片已支持，无需改代码 |
| P0.2 Harness enabled/model 可编辑 | 已完成（未发布） |
| P1 `integration/capabilities.js` 注册表 | 未做；当前仍是 `compatibility.js` 白名单 |
| P2 外部可写（`omc:<h>:write`） | 未做，按结论留到后续版本 |
| 路线 D：designer 只读产 patch | 已完成（未发布） |

---

## 1. 现状为什么不行（三个硬事实）

### 1.1 只读是 provider 级的，不是角色级的
```js
// src/index.js:305
const provider = makeProvider(ctx, def, cfg, { readOnly: true })
// src/provider.js:42
name: `omc:${def.id}`,
// src/provider.js:61-64
mode: options.readOnly === true ? 'read-only' : cfg.dispatch.defaultMode,
// src/dispatch.js:62-63 —— provider 路径拒绝任何非 read-only 的共享 mode
```
→ 想让某个角色可写，**不能**加一个 role 配置位；必须新增一个 provider 名。

### 1.2 宿主没有 per-call 的写/模式字段
`SubagentStartRequest` 只有 `{cwd?, agentPreset?, label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?}`（`@deepseek-ai/dsh-subagent` lib/types，asar 内）；角色工具也只透传 `{cwd, description, prompt, agent_preset, provider, model, reasoning_effort}`。
→ 唯一表达通道是 **provider 名**：`omc:codex`（只读）/ `omc:codex:write`。仓库早有计划：`docs/V0.2-PLAN.zh-CN.md:201`。

### 1.3 纠正一个普遍误解：native 也没有审批门
`captureDelegatedPolicyOverrides` 对所有进程内委派写死 `approvalPolicy: 'never'`（`dsh-subagent/lib/index.js:409-416`），只继承父会话的 sandbox override。
→ native 保住的是**文件沙箱**（`dsh-fs-sandbox` / `dsh-sandbox-policy`），**不是审批答问器**。因此「把外部写回灌 DSH 工具以保住审批」这个收益被高估了（见 §3 路线 B）。

### 1.4 两个顺带发现
- `src/harnesses.js:18` 的 `capabilities.write` 是**死数据**：`readOnly` 被消费，`write` 无人读。可插拔所需的表其实早就有了，只是没接线。
- 设置卡片**不能编辑** `harnesses.<id>.model` / `.enabled`（`vendor/omd/npm-package/client/client.js:616-629` 只读渲染）。per-CLI 模型现在只能手改 `cordis.patch.yml`——**这是离用户目标最近的真空档**。
- 仓库里**没有任何 git diff / git status 代码**（`src/`、`integration/`、`vendor/` 全无命中）。任何「事后用 diff 复核」的方案都是新代码。

---

## 2. DSH 0.2.1-rc.3 能力盘点（决定路线 B 是否可做）

| 能力 | 结论 | 证据 |
|---|---|---|
| 对外暴露 MCP **server**（把自己的工具给外部进程） | **不存在**。只有 MCP client：asar 内仅有 `@modelcontextprotocol/sdk/client/{index,stdio}.js`，无 `server/*`，无 `StdioServerTransport` / `StreamableHTTPServerTransport`。`dsh-base/cordis.patch.yml` 只挂 `dsh-mcp-resources` | asar 符号扫描；`dsh-mcp-client` README 自述为 client |
| 最接近的对外能力 | **ACP**（`@agentclientprotocol/sdk`、`dsh-acp`、`dsh-subagent-acp`）：把 **agent** 暴露给编辑器，**不是**把 DSH 工具暴露给外部 | asar 包清单 |
| HTTP/API 面 | websocket RPC mux：`/api/remote.mux`，事件流 `$events`，endpoint 形如 `namespace/method`；命名空间含 `session/commands/userQuestions/settings/workspace/llm/job/...`。**没有 `tools` 命名空间，也没有 `approval` 命名空间** | `dsh-api-gateway` lib/index.js:133,135,1695 |
| 审批答问 | 走 Remote **Event waterfall**，不是 RPC；由 `requireInteractions` 按连接鉴权 | `dsh-client-ui-approval` README；gateway index.js:1453 |
| 审批 + 沙箱执行 | **严格进程内**。`EscalationAsk` 是「结构化函数形状，不是审批服务类型：工具层闭包 `ctx.approval.request(...)` 再下传」。无任何接受非 DSH 调用方写请求的入口 | `dsh-sandbox/lib/types/escalation.js` |
| `worktree` 模式 | 只有 schema/校验文案，**零实现**：`src/index.js:187-188` 直接拒绝 | 全仓无 `git worktree` / `ctx.worktrees` 调用 |

**推论**：路线 B（外部 CLI 通过 MCP/IPC 回调 DSH 的 edit/write 以保住沙箱与审批）在本 build 中**没有可依托的宿主能力**；而且即便桥接成功，CLI 自带的 shell 仍能直接写文件——要被「contain」必须禁用 CLI 自己的写能力，即回到同一个沙箱问题。**B 不做。**

---

## 3. 四条路线对比

| | 做法 | 保住了什么 | 破坏了什么 | 成本 | 主要失败模式 | 结论 |
|---|---|---|---|---|---|---|
| **A** | 外部 CLI 直接写 `/mnt/e/...` | provider 面（childId/容量/一次性结算）完整 | DSH 文件沙箱**完全失效** | M（~150 LOC） | 写到 WSL 用户可达的任何位置 | 仅在 codex 上有意义，需配 `:write` provider |
| **B** | 外部 CLI 回调 DSH 工具再写 | 理论上保住沙箱+审批 | 本 build 无宿主能力；CLI 自带 shell 仍可直写 | XL→∞ | 桥不通；即使通了也不 solved | **放弃** |
| **C** | WSL 内隔离 worktree，事后合并 | 用户工作树不被直接改 | 需要 WSL 内 git、patch 应用、冲突与 CRLF 处理；`.git` 里是 Windows 绝对 `gitdir` 路径，WSL git 读不到 | L（~300 LOC） | 合并冲突被吞、陈旧 hunk 重放 | 可选，P3 |
| **D** | 外部 CLI **只产出 patch**，DSH 侧落地 | A 的全部 + 强制可复核产物 | 与 A 相同的非容器化（CLI 仍可直写） | S–M（~80 LOC） | 声称产出但没产出 / patch 打不上 | **推荐** |

**硬规则（从 `src/harnesses.js` 事实表推出）**
1. 可写外部只允许「写有界」的 harness：`codex`（`-s workspace-write`）。`gemini` 的 `auto_edit` 会自动批准（等于无闸），`antigravity` 默认写，`claude/glm/kimi/opencode` 的 argv 根本不接受 mode。
2. 写模式必须**在角色配置里显式声明**，默认 read-only，**绝不**从全局 `dispatch.defaultMode` 推导（那正是 `provider.js:61-64`、`dispatch.js:62-63` 在防的「全局放宽」）。

---

## 4. 风险排序（按爆炸半径）

| 级别 | 风险 | 说明 | 缓解 |
|---|---|---|---|
| **R1 真危险** | 无界写 + WSL interop | 一个可写的外部 CLI 就是一个能访问 `/mnt/c`、`/mnt/e`（整盘）、`~/.ssh`、`coharness.env`（内含 `ANTHROPIC_AUTH_TOKEN`，已通过 `harnessEnv` 下发）以及 `cmd.exe` 的 WSL 用户。DSH 无法居中拦截 | 只允许「写有界」harness + 每角色显式 mode + 在 harness 表里拒绝 skip-permission 类 flag；卡片红字提示该 CLI 自身权限模型 |
| **R2 真危险** | 假成功 | 外部 agent 什么都没改/改错文件，编排侧只看到 stdout（`src/provider.js:80-95`）就当成完成 | 写模式的结果**必须**带 `git status --porcelain` + `--stat`；没有 diff 就判失败；blocked 角色保持显式失败，不回落 native |
| **R3 真危险** | 全局放宽 | 某个 provider 的 mode 来自全局默认 → oracle/explorer/councillor 静默变成写手 | mode 只从角色配置来；写 provider **按需注册**（见 §5）；`readOnly` 继续留在 harness 表里当代码 |
| R4 不适但可接受 | claude/glm/kimi/opencode 的 advisory 只读 | 已上线并带显式同意闸（`integration/execution.js:121-126`） | 保留 consent 勾选 |
| R5 不适但已治 | 单个角色拖垮 preset | 已用 blocked-not-thrown 解决 | 不要退化成 catch-all 回落 |

---

## 5. 可插拔设计：把白名单变成声明式注册表

新建纯数据模块 `integration/capabilities.js`（形态照 `compatibility.js`，无 ctx、无 I/O），把「角色 × harness」的能力集中成一张表：

```js
// 记录形状（草案）
{
  oracle:            { external: 'read-only',  minReadOnly: 'enforced', writeMode: 'none',     modelPin: 'harness', why: '外部只读评审' },
  explorer:          { external: 'read-only',  minReadOnly: 'enforced', writeMode: 'none',     modelPin: 'harness', why: '外部只读检索' },
  'councillor-alpha':{ external: 'read-only',  minReadOnly: 'enforced', writeMode: 'none',     modelPin: 'harness', why: '议会席位只读' },
  designer:          { external: 'read-write', minReadOnly: 'enforced', writeMode: 'sandbox',  modelPin: 'harness', why: 'UI 实现，需有界写' },
  fixer:             { external: 'read-write', minReadOnly: 'enforced', writeMode: 'sandbox',  modelPin: 'harness', why: '实现工，需有界写' },
  librarian:         { external: 'never',                                             why: '依赖宿主 MCP(context7/gh_grep)' },
  observer:          { external: 'never',                                             why: '视觉附件转发未通 + 本版锁定' },
  council:           { external: 'never',                                             why: '综合器不能依赖外部 CLI' },
}
```

**接线点（8 处，保持函数签名不变）**

| 文件 | 改动 |
|---|---|
| `integration/compatibility.js:42-57` | 白名单改为由注册表**派生**；`canUseExternal` / `isReadOnlyRole` 签名不变（调用方 `status.js:79`、`client.js:611` 不动） |
| `integration/compatibility.js:116-150` | `validateExecution` 增加 `execution.mode ∈ {read-only, in-place}`；`in-place` 仅在 `external==='read-write'` 且 harness `writeMode==='sandbox'` 时接受，否则抛 `OMC/EXECUTION-WRITE-UNBOUNDED` |
| `integration/execution.js:24` | 新增 `executionProviderName(harness, mode)` → `omc:<h>` / `omc:<h>:write`；`resolveExecution` 返回 `{provider, mode}` |
| `src/index.js:294-315` | `ensureProviders` 只注册「有角色实际要求的 (harness, mode)」组合——**这条是安全性的根** |
| `src/provider.js:40-64` | `makeProvider({ write })`，`name` 带 `:write`，`mode: write ? 'in-place' : 'read-only'`；`capabilities` 不变 |
| `src/harnesses.js:13-22` | `readOnly` 旁补 `writeMode: 'sandbox' \| 'approval' \| 'none'`（把死数据 `capabilities.write` 用起来） |
| `preset/roles.js:368-384, 481, 500-516` | `stockConfig` 已按 `execution.provider` 泛化，**无需改**；`externalRoleArgs` 加 mode；写模式换一份 brief |
| `status` RPC + `client.js:611-613` | 状态行加 `writeCapable`，客户端删掉重复的角色列表，改读状态 |

**必须留作代码（做成配置只会产生「无法兑现的配置」）**：harness 的 `readOnly`/`writeMode` 分类（来自真实 `--help` 事实）、`executionProviderName`、「council 必须 native」、「外部角色不注入 agentOptions/maxDepth」（`vendor/omd/PATCHES.md:42-46`）。

---

## 6. 分阶段计划（每阶段可独立发布）

### P0 —— 立刻可做，0 风险（直接回答「designer 用更强模型」）
1. **原生 pin 强模型**：`roles.designer.provider` + `.model`（卡片本来就支持，`client.js:1277-1280`）。这是「更强前端模型」最便宜的答案——只要 DSH 路由里有更强的模型。
2. **补上卡片缺的两个字段**：`harnesses.<id>.model` / `.enabled` 可编辑。否则 per-CLI 模型永远只能手改 JSON。

验收：`scripts/check.mjs` 通过；`coharness status` 显示 designer 为 native；完成通知里出现 pin 的模型名。

### P1 —— 注册表上线，行为零变化
`integration/capabilities.js` + 派生白名单 + status 增加 `writeCapable` + 客户端去重。
验收：`test/integration/contracts.test.mjs`、`scripts/check.mjs` **不加修改**通过（证明行为等价）。

### P2 —— 路线 D：designer/fixer 的外部写（仅 codex）
`execution.mode: 'in-place'` 仅对 `writeMode: 'sandbox'` 生效；`omc:<h>:write` 按需注册；brief 增加写授权段；结果强制附 `git status --porcelain` + `--stat`，无 diff 即失败。
验收：designer→`omc:codex`(写) 在干净仓库产出非空 diff stat 且文件符合预期；designer→`omc:claude`(写) 直接拒绝并报 `OMC/EXECUTION-WRITE-UNBOUNDED`。

### P3 —— 可选：路线 C 的 worktree 隔离
复用 P2 管线；需先解决 `.git` 的 Windows 绝对 `gitdir` 在 WSL 侧不可解析的问题。
验收：diff 在 worktree 内产生、用户工作树在 apply 前不变、apply 失败被显式报告。

**顺序不可颠倒**：P2 的安全性完全依赖 P1 的「只有被角色要求的写 provider 才存在」。

---

## 7. 必须让用户拍板的两个取舍

1. **「更强的 designer 模型」到底指哪个？**
   - 若指「比 deepseek-flash 更强的**原生**模型」→ P0 一条配置解决，零风险。
   - 若指「Claude / GLM 这类前端强模型」→ 这两家在 `src/harnesses.js:74,117` **没有可写沙箱**。可选形态只有两种：**(a) 只读设计顾问，产出 patch 由 native 落地**；**(b) 接受一旦它自己写文件就等于 `--dangerously-skip-permissions` 级别（R1）**。建议 (a)。
2. **是否接受「可写外部只开放给 codex」？**
   这是唯一有真实写沙箱的 harness。其余 CLI 一律只做只读/产 patch。

---

## 附：证据索引

- provider 级只读：`src/index.js:305`、`src/provider.js:42,61-64`、`src/dispatch.js:62-63`
- 宿主无 mode 字段：`@deepseek-ai/dsh-subagent` `lib/types`（asar）；计划佐证 `docs/V0.2-PLAN.zh-CN.md:201`
- native 无审批门：`dsh-subagent/lib/index.js:409-416`
- 能力事实表：`src/harnesses.js:13-22`（`write` 死数据）、`:49-58/:74/:91-98/:117/:145/:160`
- 白名单/校验/解析：`integration/compatibility.js:42-57,100,116-150,167`、`integration/execution.js:62,115-126,131`
- 外部角色无 MCP：`vendor/omd/npm-package/preset/roles.js:481`
- 卡片只读 harness 行：`vendor/omd/npm-package/client/client.js:616-629`
- worktree 仅 schema：`src/index.js:126-127,187-188`
- MCP client-only：asar 内 `@modelcontextprotocol/sdk/client/*`，无 `server/*`；`dsh-base/cordis.patch.yml:493-494`
- 审批/沙箱进程内：`dsh-sandbox/lib/types/escalation.js`；`dsh-sandbox-local`、`dsh-user-approval` README
- API 面：`dsh-api-gateway` `lib/index.js:133,135,1453,1695`
