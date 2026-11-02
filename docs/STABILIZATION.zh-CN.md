# OMC 稳定化与发布方案（v0.6 稳定版候选）

> 状态：方案草案 · 目标版本 v0.6.0-stable-candidate · 基线 DeepSeek Harness Desktop **0.2.1-rc.3**
> 原则：**DSH 管 Native 模型，OMC 管外部 Harness 的执行与路由。两者共享角色定义，不重复管理模型 Provider。**

本文件是发布门槛，不是功能清单。稳定化期间冻结 SuperAgent 集成、RPH 接口与新 Harness 接入；只有满足 §7 验收矩阵的改动才允许进入候选版。

---

## 1. 定位与本次发布的三条硬约束

v0.5 证明了"角色可以交给外部 CLI"。v0.6 要证明的是"交出去之后仍然可预测、可收费、可解释"。因此本版只做四件事：收敛执行路径、清理不可达实现、确定默认配置、建立真实验收与 CI。

三条不可让步的约束：

1. **单一有效执行路径**。外部角色只有一条：`Provider（omc:<harness>）→ Adapter → CLI`。Direct Dispatch 不再是失败时的隐式兜底，而是需要显式开启的高级操作。
2. **开放权重模型只走 DSH Native**。模型 Provider、凭据、会话、工具与权限全部由 DSH 管理，OMC 不建立第二套 Provider 系统。
3. **闭源订阅模型只走官方 Harness**。Codex、Kimi、GLM Coding Plan、OpenCode Go、Antigravity 通过各自 CLI 与订阅认证执行，OMC 不把订阅转换成通用 API。

推论：**未验证的 Harness 不得出现在稳定版支持矩阵里**。"有代码"不等于"可用"。

---

## 2. executionChannel：按连接方式路由，而不是按模型品牌

现有两个概念保持独立，且必须同时成立：

| 概念 | 配置字段 | 回答的问题 |
|---|---|---|
| Native 模型选择 | `role.provider` / `role.model` | DSH 用哪个 LLM |
| 执行归属 | `role.execution.backend` + `harness` | 由 DSH 还是外部 CLI 执行 |

`executionChannel` 是从这两者**推导**出来的显式分类，不是新的品牌白名单：

| executionChannel | 含义 | 计费形态 |
|---|---|---|
| `native` | DSH 直接管理模型 Provider 与子 Agent | 由 DSH 侧 Provider 决定（本地/自建/API） |
| `harness:<id>` | 官方 CLI + 该 CLI 的订阅认证 | 订阅（或显式授权的 API） |

判定只看连接方式，不看模型名：

- **GLM 是双形态的**：开放权重 GLM 经 DSH Native（自建 vLLM/API Key 均属 Native 侧）；GLM Coding Plan 经 `harness:glm`（Claude Code + Z.ai Anthropic 端点 + 订阅 token）。两者是不同通道，不能互相兜底。
- **OpenCode 是执行框架**：`harness:opencode` 只有在订阅认证下才可路由；若底层是 API Key 计费，则 `billing: api`，必须 `allowPaidApi` 才允许自动路由。
- **同一模型可能出现两个通道**（如 Qwen 开放权重走 Native；某个订阅网关的 Qwen 走对应 Harness）。路由必须依据连接的计费与认证属性，而不是模型名。

因此 `routing` 的合法输入是 `billing + provider 注册 + 连接状态`，而不是模型清单。

---

## 3. 连接状态机：注册 ≠ 可用

现状问题：`omc:<id>` 的注册主要依据 `harnesses.<id>.enabled`；而可执行文件、认证、配额未必已就绪。本机实测已复现该缺陷（Antigravity 已安装但 `signed-out`，仍以 provider 身份出现）。

v0.6 用六态描述每个 Harness 的连接（`missing` 是 `installed` 的前态：已启用但找不到可执行文件，单独列出以免把"没装"说成"装了"）：

```
disabled → missing → installed → authenticated → verified → routable
```

| 状态 | 判定依据 | 允许的行为 |
|---|---|---|
| `disabled` | 配置关闭 | 不注册 provider |
| `missing` | 已启用但可执行文件不存在（`auth: missing`） | 不尝试执行 |
| `installed` | 可执行文件与版本可探测 | 注册 provider，状态里标"未认证" |
| `authenticated` | `authProbe` 无交互通过（`auth: ok`）；或**人工验收记录** `verify.accepted` | 允许用户手动 `role.execution` 指定；显示为"未验证" |
| `verified` | 已认证，且该 Harness 的 argv/执行模式经现场验证（`def.verified`）或人工记录 | 允许手动指定并标记"已验证" |
| `routable` | 已验证且计费已授权 | 允许**自动路由**与设置卡推荐 |

硬规则：

- `auth: unknown` **不等于**已登录；禁止当成 `authenticated`。
- 自动路由（`routing` / 推荐）只认 `routable`；人工验收必须落一份可追溯记录（harness、版本、日期、命令、结果、执行模式）。
- Provider 注册与 Routable 必须解耦：注册用于"可以显式尝试"，Routable 用于"可以自动消费用户订阅"。

状态来源与落地：连接状态由 Host 侧探测并随 `/coharness status` 输出；设置卡的推荐必须与 status 中真实生效的路由同源，禁止"显示建议、执行另一套"。

---

## 4. 默认配置两档（正式支持）

两档模板随包发布在 [`presets/`](../presets/README.md)，用法见该目录 README。只提供两种官方模式；Council 为可选扩展，不计入默认。

### 4.1 Safe Native（首次安装默认）

全部基础角色由 DSH Native 执行；外部 CLI 不自动激活。

```json
{
  "roles": {
    "oracle":     { "execution": { "backend": "native" } },
    "explorer":   { "execution": { "backend": "native" } },
    "fixer":      { "execution": { "backend": "native" } },
    "librarian":  { "execution": { "backend": "native" } },
    "designer":   { "execution": { "backend": "native" } },
    "councillor-alpha": { "enabled": false },
    "councillor-beta":  { "enabled": false },
    "councillor-gamma": { "enabled": false }
  },
  "harnesses": {
    "codex": { "enabled": false }, "claude": { "enabled": false },
    "glm": { "enabled": false }, "opencode": { "enabled": false },
    "antigravity": { "enabled": false }, "kimi": { "enabled": false },
    "gemini": { "enabled": false }
  },
  "routing": { "enabled": false, "allowPaidApi": false, "allowUnknownBilling": false }
}
```

未指定 `provider`/`model` 时，Native 子 Agent 继承 DSH 会话模型。没有可用开放权重模型时，引导用户在 DSH `Settings → Models` 配置，而不是静默选择闭源付费 API。

### 4.2 Hybrid Subscription（验收后启用）

Native 承担调度与写入，订阅 Harness 承担评审与前端方案：

```json
{
  "roles": {
    "oracle":   { "execution": { "backend": "omc", "harness": "codex", "fallback": "fail" } },
    "designer": { "execution": { "backend": "omc", "harness": "antigravity", "fallback": "fail" } },
    "explorer": { "execution": { "backend": "native" } },
    "fixer":    { "execution": { "backend": "native" } }
  }
}
```

`fallback: "fail"` 是刻意选择：订阅失效时**明确失败**，不在用户不知情时改用另一条可能收费的通道。需要自动兜底必须显式改成 `fallback: "native"`。

### 4.3 能力矩阵（v0.6 稳定版）

| 角色 | 默认执行渠道 | 模型来源 | 理由 |
|---|---|---|---|
| Orchestrator | DSH Native | 用户选择的开放权重主模型 | 统一调度，避免跨订阅编排开销 |
| Explorer | DSH Native | 轻量代码模型 | 搜索与初步归纳 |
| Fixer | DSH Native | 编码较强模型 | 实际修改，受 DSH 权限约束 |
| Librarian | DSH Native | 支持工具调用的模型 | 继续使用 MCP 工具 |
| Oracle | 外部 Codex（可配置） | Codex 订阅 | 架构与独立评审 |
| Designer | 外部 Antigravity（可配置） | AGY 订阅 | 前端方案与 Patch |
| Council Seats | Native 或混合 | 按已连接模型分配 | 用不同来源提供独立意见 |
| Council Synthesizer | DSH Native | 主模型或独立综合模型 | 统一整合 |
| Observer | 禁用 | 待验证视觉能力 | 附件转发未完成 |

外部执行是**推荐混合配置**，不是新装即启用。未完成 CLI 认证与权限验收时，首次安装一律 Safe Native。

安全边界保持不变：**外部 Fixer 不可写；外部 Designer 只返回 Patch**。这是发布边界，必须保留到工作区隔离真正落地。

---

## 5. PR 拆分与验收

### PR-01 · Adapter 与执行路径冻结（合并 #1 + 严格 surface + 连接状态）

- 合并 PR #1（Adapter 契约、订阅计费保护、Codex Resume 修正）作为验收基线。
- 新增 `dispatch.allowDirectFallback`（默认 `false`）：Provider 缺失时返回 `OMC/PROVIDER-UNAVAILABLE`，不再自动降级 Direct；Direct 仅保留给显式请求的高级操作。
- 接入 §3 连接状态：provider 注册、`recommendRoute`、设置卡推荐三者同源。
- 验收：执行结果准确标注 Surface / Harness / Model / 会话身份；authority 缺失或未登录时行为可预测。

### PR-02 · 死代码与发布包清理

- 先做可达性审计（入口：`package.json exports`、`cordis.patch.yml`、运行时入口、动态插件注册），产出 `dead-code-report.json` + 删除清单 + 清理前后测试差异。
- 删除确定不可达的实现与失效测试；历史设计文档移入 `docs/archive/` 并从 npm 包排除；`vendor/omd` 逐模块分析导入关系后再动。
- **保留**迁移层（`src/migrate.js`、`integration/migration.js`），淘汰至少推迟到一次完整升级/回滚验收之后。
- 验收：清理后全测试通过，tarball 不含归档与历史材料。

### PR-03 · 双轨默认配置与设置卡一致性

- 落地 §4 两档模板 + 可选 `native-model-profiles.json`（按实际已装模型生成，不预置用户环境不存在的模型 ID）。
- 设置卡：默认值与真实执行结果一致；未认证 Harness 不可被推荐为可用；订阅计费需显式授权。
- 验收：按引导完成后角色走正确渠道，不产生未授权计费回退。

### PR-04 · 发布验收与 CI

- 结构化解密 Kimi/OpenCode/GLM 输出与会话解析；补齐跨平台 smoke、隔离权限测试、安装/升级/回滚测试。
- 加入 CI（§8），产出带日期的验收报告与 Release Notes。
- 验收：§7 全部 P0 通过后切 Release Candidate。

**顺序约束**：PR-02 的删除不与 PR-01/PR-03 的路由重构混在同一提交；所有删除走独立 PR，可单独回滚。

---

## 6. 本机现状（2026-10-30 实测，用于确定本机默认值）

| Harness | 安装/版本 | 认证 | 可路由结论 |
|---|---|---|---|
| codex | 0.165.0（WSL） | ok | 可 routable（resume 已 verified） |
| opencode | 2.1.4（WSL） | ok | 可 routable（resume unverified） |
| antigravity | 1.4.10（WSL） | **signed-out** | **不可路由**（注册≠可用） |
| glm | Claude Code 2.1.312（WSL） | unknown（env token 存在） | 未验收，不自动路由 |
| gemini | 0.66.0（WSL） | unknown | 未验收，不自动路由 |
| kimi | 2.4.0（WSL） | unknown | 未验收，不自动路由 |
| claude | 未安装 | — | disabled |
| qwen | 未安装 | — | 从稳定版矩阵移除 |

本机 DSH：Desktop 0.2.1-rc.3；profile 以 `link:` 指向本仓库，改动代码后重启 DSH 生效。

---

## 7. 发布验收矩阵（P0 = 阻断发布）

| # | 维度 | 检查项 | 证据 |
|---|---|---|---|
| 1 | 代码 | 发布模块均有入口引用；清理后测试无回归 | `dead-code-report.json` + 前后测试差异 |
| 2 | 代码 | 旧 OMD 独立入口不重复注册 | profile 启动日志、Preset 列表 |
| 3 | Native | 开放模型可完成主 Agent 与 Explorer/Fixer 子任务 | 会话记录 + 工具调用证据 |
| 4 | Native | 角色切换 provider/model 生效，无误继承 | 两角色不同模型的实际响应 |
| 5 | Harness | Codex/Kimi/GLM/OpenCode/AGY 各一次真实调用 | 脱敏命令与输出 |
| 6 | Harness | 未登录/配额耗尽报错清晰，且不自动收费回退 | 失败用例输出 |
| 7 | 权限 | 外部只读任务无法写入受保护工作区 | 受限工作区前后 `git status` + 文件哈希 |
| 8 | 权限 | Designer 仅出 Patch，Fixer 负责应用 | Patch 产物 + 应用记录 |
| 9 | 会话 | Codex 两轮真实 resume；其余仅验证后开启 | 原生 session id + 第二轮上下文 |
| 10 | 会话 | 两项目、两并行 Lane 不串会话 | registry 导出 + 隔离验证 |
| 11 | 环境 | Windows Host + WSL CLI 的路径/环境变量/取消 | 取消与超时用例 |
| 12 | 发布 | `npm pack` 内容正确；装/重启/卸载/重装正常 | tarball 清单 + 安装日志 |

行为测试要求（不可用"模型自称不会写"代替）：

- **权限**：在受限测试工作区实际尝试写操作，比对文件哈希与 `git status` 无变化；必要时用 OS 级权限隔离。
- **Resume**：验证原生 session id、第二轮上下文、项目边界、重启后恢复——退出码 0 不等于续接正确。
- **Native 模型**：必须通过真实角色工作流（工具调用、并行子任务、结构化输出），不能只验证聊天可用。

---

## 8. CI 发布门槛

`.github/workflows/ci.yml` 至少三个作业：

| 作业 | 内容 |
|---|---|
| `static-and-contracts` | `npm run check` + `npm test`（Node 20/22） |
| `package-and-install` | `npm pack --dry-run` + `scripts/pack-check.mjs` + tarball 必须/禁止文件 + 从 tarball 安装到隔离目录 |
| `dsh-runtime-smoke` | 需自托管 runner（含 DSH）；`workflow_dispatch` 触发，当前为占位，不伪造通过 |

真实订阅调用（Codex/Kimi/GLM/AGY）**不进公共 CI**：涉及个人账户与配额。由本机 Release Acceptance 执行并保存脱敏证据。

**版本基线**：以 Desktop 0.2.1-rc.3 为 v0.6 测试基线写入文档；`engines.dsh` 区间不构成兼容承诺，其余版本经兼容性矩阵逐个纳入。

---

## 9. 与后续 SuperAgent 的接口冻结

稳定化完成后冻结以下接口，SuperAgent 只通过它调用 OMC 角色执行：

1. 角色执行服务：`role + executionChannel + fallback` → 执行结果（含 surface/harness/model/session 身份）。
2. 连接状态查询：`disabled|installed|authenticated|verified|routable`。
3. 计费授权契约：`billing` + `allowPaidApi` / `allowUnknownBilling` / `authorizeBilling`。
4. 会话与权限契约：原生 session 引用、只读等级、Patch 边界。

在这四项证据齐备前，不新增任何面向 SuperAgent 的适配层。

---

## 10. 本轮落地状态（2026-11-02）

| 项 | 状态 | 证据 |
|---|---|---|
| PR #1 基线（Adapter 契约、计费保护、Codex resume） | 已在 `feat/merge-omd`，PR #1 待合并 | `138 tests` 通过 |
| `dispatch.allowDirectFallback`（默认 false，Provider 缺失不再静默 Direct） | 已实现 | `test/integration/surface-strict.test.mjs` 7 例 |
| 连接状态 `disabled→missing→installed→authenticated→verified→routable` | 已实现（`src/connection.js`） | `test/integration/connection.test.mjs` 18 例 |
| 自动路由只认 `routable`；status 显示真实状态并抑制非 routable 推荐 | 已实现 | `model-policy.test.mjs` 12 例 |
| 人工验收记录 `harnesses.<id>.verify` | 已实现（`auth: unknown` 的唯一升级路径） | `connection.test.mjs` |
| 双轨模板 Safe Native / Hybrid Subscription | 已随包发布（`presets/`） | `scripts/pack-check.mjs` |
| CI（静态/契约、打包安装、DSH runtime 占位） | 已加入（`.github/workflows/ci.yml`） | 待首次 push 后跑通 |
| 本机 profile 收口（仅 codex/opencode 启用，routing 关闭） | 已写入，**重启 DSH 后生效** | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| PR-02 死代码审计与发布包清理 | 未开始 | 审计结果见下 |
| PR-04 真实验收矩阵（§7） | 未开始 | — |

可达性审计（本轮已完成，供 PR-02 使用）：

- `src/*.js` 与 `integration/*.js` **全部静态可达，没有孤儿模块**；不应按“没人 import”删任何模块。
- `qwen` 不是死代码，而是**无默认可运行路径**（`enabled:false`、`readOnly:unsupported`、argv 未验证）：从稳定版支持矩阵移除，不从源码删除。
- `gemini` 仍可用且 `def.verified` 为 true，但 session 解析为 `unverified`，默认禁用后再由验收决定。
- `mcp` / `app-server` 适配器**可从配置到达**但必然失败——标记为实验性，不开放给普通用户。
- 7 个 preset 模块只通过 cordis 行名动态注册，静态不可见但不是死代码。
- 8 篇历史文档随包发布但未被 README 引用：迁入 `docs/archive/` 并从 `files` 排除（CI 已含禁止断言）。
- 迁移层（`src/migrate.js`、`integration/migration.js`）**保留**，淘汰至少推迟到一次完整升级/回滚验收之后。
