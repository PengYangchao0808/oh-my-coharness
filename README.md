# Oh My CoHarness

> **v0.5.0-alpha.2-practice.5** — 从“多 Harness 接入”进入“任务交接 + 原生会话复用 + 策略路由”，本轮再往前一步：**原生子 Agent 的请求与用量进入同一套任务记录，预算到额会真正阻止下一次发送**。
> 一个插件、一个默认 Preset：角色可以跑在 DSH 原生子 Agent 上，也可以交给你已经装好的外部 AI 编程 CLI。
> `practice.5` 表示这是一次**实践增量**，不是 alpha.2 的发布版本：R00–R04、R06–R07 已完成，R05 代码/设置卡/监控已完成但缺 Desktop 点击证据，R08–R10 与 alpha.2 发布闸门尚未执行。
>
> **路线（2026-11-03 修订）：0.X = Internal Foundation（内部技术验证，不发布 npm）。** 首次 npm 公开发布移到 **1.X Coharness Core GA**。`package.json` 已设 `private: true` 防误发；`npm pack` 与隔离安装测试保留。0.X 收官实施与验收入口见 [OMC-0X-CLOSEOUT.md](docs/OMC-0X-CLOSEOUT.md)。

**本轮（2026-11-03，R02–R04）：**
- `integration/request-gate.js`：**跨进程**逐请求预算闸门。锁内核对"已结算 + 在途 + 未知"，在 `agent/request`（`llm.stream` 之前，重试也计入）拒绝发送，`agent/pre-step` 提前拒绝该步；未知结果**保留名额**，释放需要带理由的审计调用。两个独立进程争最后一格时只有一个成功（真双进程测试）。
- `integration/native-managed.js`：把已有的原生 child 绑定到工作图节点（`coharness native_action:bind`），用持久执行记录结算（`settle`）；**执行完成不等于验收通过**，没有证据节点不解锁后继。
- `integration/worker-registry.js` + `integration/session-strategy.js`：逻辑负责人与物理 child/generation 分离，续接/排队/压缩/重开有规则与决策日志（`coharness session_action:decide`）；没有合法压缩接口时记 `restart`，不伪造 compact。
- `/coharness status` 末尾新增运行脚注：桥是否安装、闸门是否强制执行、当前预算视图、managed/unmanaged 覆盖。
- **外部按次入账与边界拦截（R02）**：外部 CLI 每次 dispatch 记一条尝试（四桶/未知/仅 CLI 报告费用），到额时在**启动 CLI 之前**拒绝下一次派发，并声明这只是 dispatch 之间的控制。
- **设置卡（R05）**：`efficiency` 已进入 host schema，卡里可编辑模式、请求上限、单任务上限、费用上限与强制执行开关；保存的用户层**覆盖**部署行配置，类型不对的值直接丢弃（不会被强转成"拦截"）。

**证据：** [R02 预算闸门](docs/evidence/alpha.2/practice-r02-budget.json) · [R03 原生闭环](docs/evidence/alpha.2/practice-r03-native-managed.json) · [R04 会话选择](docs/evidence/alpha.2/practice-r04-selection.json) · [分层基线](docs/evidence/alpha.2/practice-baseline.json)。

**下一版本方案：** [0.5.0-alpha.2 效率与协作闭环](docs/V0.5-ALPHA2-PLAN.zh-CN.md)；逐项执行方案见 [R02–R10 执行方案](docs/plans/r02-r10.execution-plan.zh-CN.md)。最新现状以 [剩余审计](docs/REMAINING-AUDIT.zh-CN.md) 为准。

**2026-11-02 Unreleased：OMO-SLIM 核心链路可用化。** 外部角色现可指定 Lane 与最小交接，提供 `coharness` 的 `tasks/result/cancel` action，并修复新开策略、会话轮数和工作目录识别。Codex 原生会话两轮记忆测试、DSH 0.2.1-rc.5 原生/外部角色装载已实测通过。完整功能复刻仍在推进：[差异与开发顺序](docs/OMO-SLIM-PARITY.zh-CN.md) · [本批验收与用法](docs/USABILITY-ACCEPTANCE.zh-CN.md)。

**2026-11-02 晚：原生多模型 Demo。** 不接外部 CLI，直接复用 DSH 已可调用的模型：`/coharness fleet` 从实时模型目录生成角色路由（优先继承仍挂载的 OMD-Slim 配置），`/coharness fleet --apply` 只写 provider/model/execution 并保留工具与 MCP，`/coharness demo` 生成一个确定性工作区和可直接粘贴的 Explorer → Oracle → Fixer 任务；`/coharness status` 显示每个 native 角色实际钉住的模型以及目录校验结果。见 [原生多模型 Demo](docs/NATIVE-FLEET-DEMO.zh-CN.md) · [Oh-My-Pi 参考与后续方案](docs/OH-MY-PI-REFERENCE.zh-CN.md)。

**反馈与策略评估：** [三策略监控与自主优化方案](docs/FEEDBACK-EVOLUTION.zh-CN.md) 提供“续接/压缩、新建/交接、自适应”离线对照工具，核算失败、优化成本及结果不确定性。当前不自动运行付费实验或修改线上策略。

**后续开发入口：** [完整下一步实践方案](docs/NEXT-PRACTICE.zh-CN.md) 按 R00–R10 列出剩余接线、代码落点、验收和发布顺序；配套 [可跟踪清单](docs/plans/next-practice.backlog.json)。

**产品路线：** [OMC 0.X → 1.X → 2.X 完整发展路线](docs/ROADMAP.zh-CN.md) 把三个阶段固定为三种能力（Collaborate / Connect / Evolve），给出各自里程碑、完成门槛与三层 Benchmark；2.X 的分层结构与授权账本详设见 [分层维护体系设计](docs/SUPERAGENT-LAYERING.zh-CN.md)。路线只给方向与排期，不构成能力声明。

Oh My CoHarness（OMC）把两件过去分开的事合成一个产品：

- **谁来做**：Orchestrator + Oracle / Explorer / Fixer / Designer / Librarian / Council 的专业分工；
- **在哪做**：同一个 `subagent_oracle` 可以执行成 DSH 原生子 Agent，也可以执行成 Codex、Gemini、Antigravity、opencode、Kimi、Claude Code 的外部运行；支持的 CLI 可按 Lane 恢复原生会话。

它不再需要同时安装 `oh-my-dsh-slim` 和 `oh-my-coharness`。合并后的用户只安装 **`oh-my-coharness`** 一个包。

---

## 它做什么

```
DSH Desktop / Web / CLI
        │
        ▼
Oh My CoHarness  ·  一个 Bundle · 一个 Preset
┌──────────────────────────────────────────────────────────────┐
│ Orchestrator（主控 Prompt / 规划 / 验收 / 汇总）              │
│   ├─ 专业角色：oracle explorer fixer designer librarian       │
│   ├─ Council：alpha / beta / gamma + 原生 synthesizer         │
│   └─ 每个角色选择执行后端                                     │
│          ├─ DSH Native：spawn / fork，可续接，受 DSH 权限约束 │
│          └─ External：omc:<harness>，固定只读，可按 Lane 续用 │
└──────────────────────────────────────────────────────────────┘
        │
        ├─ DSH 官方 Subagent / Session / 工作区 / 权限 / 插件管理
        └─ OMC Provider：CLI discovery · Doctor · Windows/WSL
```

**六条设计原则**

1. DSH 负责 Runtime：子 Agent、会话、生命周期、工作区和插件市场都沿用官方实现。
2. 只有一个 Orchestrator：保留 OMD 的主控 Prompt 与角色，不再维护第二套角色系统。
3. 角色与 Harness 解耦：`oracle` 是任务角色，`codex` 是执行后端，两者通过 `role.execution` 关联。
4. 无点对点通信：所有 Agent 的交接都经过 DSH 主控，没有消息总线。
5. Native 默认不变：没有配置外部 CLI 时，角色行为与 OMD v0.8.6 一致。
6. 前端只有一套：保留成熟的设置卡，只增加执行后端选择。

---

## 角色与执行后端

| 角色 | 工具 | 默认 | 可切外部 CLI | 说明 |
|---|---|---|---|---|
| oracle | `subagent_oracle` | native | ✅ | 架构、难题、代码审查；只读 |
| explorer | `subagent_explorer` | native | ✅ | 代码库侦察；只读 |
| councillor-alpha/beta/gamma | `subagent_councillor_*` | native（默认关闭） | ✅ | Council 独立席位；只读 |
| fixer | `subagent_fixer` | native | ❌ | 写入角色；本版必须留在 DSH 原生 |
| designer | `subagent_designer` | native | ✅（仅 patch） | UI/UX；外部运行时只读产出 unified diff，由原生 fixer 落地 |
| librarian | `subagent_librarian` | native | ❌ | 依赖 context7 / gh_grep MCP；本版保持原生 |
| observer | `subagent_observer` | 本版锁定 | ❌ | 需要视觉模型与附件转发 |
| council | `subagent_council` | native | ❌ | 合成器永远原生，汇总不依赖另一套 CLI |

角色配置示例（`~/.dsh/oh-my-coharness.json` 或设置卡）：

```json
{
  "roles": {
    "oracle": {
      "execution": { "backend": "omc", "harness": "codex", "fallback": "fail" }
    },
    "explorer": {
      "execution": { "backend": "native" }
    },
    "fixer": {
      "execution": { "backend": "native" }
    },
    "designer": {
      "execution": { "backend": "omc", "harness": "antigravity" }
    }
  }
}
```

- `backend` 只有 `native` 和 `omc`。
- `harness` 是 OMC 的 CLI id（`codex`、`gemini`、`antigravity`、`opencode`、`kimi`、`claude`、`glm`）。
- `fallback` 默认 `fail`：Provider 缺失时角色工具**显式失败**并给出原因，绝不静默改回 native。
- `allowAdvisory: true` 才允许只有 advisory 只读的 CLI 承担只读角色（见下节）。
- designer 的外部模式由角色固定为 `patch`，配置里没有 `mode` 字段；其他外部角色固定 `read-only`。

### 只读不是一个词，而是三个等级

| 等级 | 含义 | 可用于外部只读角色 |
|---|---|---|
| `enforced` | CLI 自己的沙箱/审批开关确实拒绝写入（codex `-s read-only`、gemini `--approval-mode plan`、antigravity `--sandbox`） | ✅ |
| `advisory` | 只是 Prompt 要求不要写，CLI 仍可能按默认权限写入（opencode、kimi、claude、glm） | 默认拒绝；需显式 `allowAdvisory: true` |
| `unsupported` | 调用形态未经验证 | ❌ |

`patch` 是 designer 专用的外部只读模式：CLI 仍然不写工作区，而是返回一份可用 `git apply -p1` 应用的 unified diff，由原生 fixer 落地。它不会新增可写 provider，`omc:*` 依旧固定只读。

**`omc:<id>` Provider 固定只读。** 无论全局 `dispatch.defaultMode` 是什么，角色 Provider 都不会升级成可写；`coharness` 工具需要写入时走 `surface: direct` 并在结果里明确标注降级。

---

## v0.5：任务交接与原生会话复用

v0.5 不新建 Agent 消息总线。所有交接仍由主控发起，跨执行者只传**必要事实**，不传完整对话。

### Handoff：一次委派的身份与最小上下文

外部角色 Brief 现在带一段 `Handoff:`：

```
Handoff:
- Task: task-m3k2-9f1c2a
- Project: proj-4a91c02e77
- Lane: lane-oracle-proj-4a91c02e77
- Changed files: src/provider.js
- Acceptance:
  - Report evidence for every claim.
```

- `taskId` 标识这一次委派；`projectId` 来自工作区；`laneId` 标识长期工作方向，默认是“角色 × 项目”。
- 交接内容只包含目标、已改文件、产物引用和验收条件；不包含另一个 Agent 的完整对话。
- Brief 末尾有一个**进程内 HMAC 签名**的机器标记。Provider 在把任务交给 CLI 前会剥离并校验它；直接 `coharness` dispatch 的 prompt 无法伪造标记来续接别人的会话。
- 产物路径必须是工作区相对路径；绝对路径和 `..` 会在签名前被拒绝。

### Session Registry：续接 CLI 的原生会话

OMC 只保存 CLI 返回的 **Native Session ID** 和少量元数据，不保存对话、Prompt 或凭据：

```
~/.dsh/oh-my-coharness-sessions.json
```

会话键由以下字段共同决定，任一不同都不会复用：

```
projectId · laneId · role · harness · model · environment · workspace · endpoint
```

因此 GLM（Z.ai 端点）和 Claude（Anthropic 端点）即使共用 `claude` 二进制，也不会串用会话。

```json
{
  "sessions": {
    "enabled": true,
    "resumePolicy": "auto",
    "maxTurns": 24,
    "idleTtlMs": 604800000,
    "allowUnverified": false
  }
}
```

- `resumePolicy`：`auto`（有匹配就续接）/ `new`（每次新开）/ `require-resume`（没有可续接会话就直接失败）。
- 角色工具先通过 DSH 工作目录服务解析显式/继承的 `cwd`，再生成交接；Provider 只在实际 cwd 与交接工作区相符时复用。独立调用 Provider 的集成方必须显式提供正确 cwd，不能用 Host 进程目录代替项目目录。
- 同一个 Native Session 同时只允许一个运行：Registry 用进程内 lease 排队，超时后明确报 `OMC/SESSION-BUSY`，不会并发写同一个会话。
- 失败、身份未确认、用户清除的会话都不会自动续接；TTL 或 `maxTurns` 到期后新建。
- 用户可以随时清除 OMC 引用，但**不会删除 CLI 自己的历史**：

```bash
/coharness sessions          # 查看引用（session id 已掩码）
/coharness sessions --clear  # 只清除 OMC 的引用
```

CLI 支持矩阵（`confidence` 决定默认是否启用）：

| Harness | 续接形态 | 置信度 | 默认 |
|---|---|---|---|
| codex | `codex exec resume <id>` + `--json` | verified（2026-10-30 两轮 + 沙箱继承） | ✅ |
| claude | `claude -p ... --resume <id> --output-format json` | documented | ✅ |
| kimi | `kimi ... --session <id>` | unverified | ⚠️ 需 `allowUnverified` |
| opencode | `opencode run --session <id>` | unverified | ⚠️ 需 `allowUnverified` |
| gemini | `gemini --resume <id>` | unverified | ⚠️ 需 `allowUnverified` |
| glm | 复用 Claude 的 `--resume`，Z.ai 端点兼容性未验证 | unverified | ⚠️ 需 `allowUnverified` |
| antigravity | 恢复命令未验证 | — | ❌ |

> **目前只有 Codex 完成真实两轮验收。** 上表的 `documented` 表示命令形态有官方文档依据，不代表本机已经跑通“同一 Lane 第二轮续接”。在真实环境验证前，不要把它当作稳定能力发布。Codex 的 `exec resume` 没有 `-s`：续接轮沿用会话创建时记录的沙箱，所以不要续接一个可写会话。

继续外部工作时，再次调用相同角色工具、相同 `cwd` 和 `lane`，传入新任务；不能对外部 child id 使用 `send_message`。`context_summary / changed_files / artifact_refs / acceptance` 用于主控在角色之间交接事实。独立任务应使用不同 Lane；默认“角色 × 项目”的 Lane 不按父聊天隔离。

外部 Provider 结果可通过工具重读，不会再次调用模型：

```js
coharness({ action: "tasks" })
coharness({ action: "result", task_id: "<external-child-id>" })
coharness({ action: "cancel", task_id: "<external-child-id>" })
```

这些 action 只允许操作本父会话的运行，索引在 Host 重启后消失，并保留最近 100 个终态结果；持久 CLI 引用另存于 Session Registry。`surface: direct` 没有 child receipt，不进入此索引。取消请求不等于完成。详细契约见 [本批验收](docs/USABILITY-ACCEPTANCE.zh-CN.md)。

### 模型策略：可解释的建议，加一道成本闸门

`routing` 提供 `economy / balanced / quality` 三套建议，默认不改变执行配置：

```json
{
  "routing": {
    "enabled": false,
    "preset": "balanced",
    "allowPaidApi": false,
    "allowUnknownBilling": false
  }
}
```

显式的 `role.execution` 永远优先。`routing.enabled=true` 后，策略才会在角色没有显式 `execution` 时把建议变成实际路由（仅限可外部执行的角色）；Provider 未注册时不发车，回落到 native。

自动路由还要过一道成本闸门：`harnesses.<id>.billing` 取 `subscription | api | unknown`，只有订阅计费的线路默认可被自动选用；API 计费需要 `routing.allowPaidApi: true`，计费未知需要 `routing.allowUnknownBilling: true`，单条线路也可用 `authorizeBilling: true` 单独放行。**未知不等于免费**——说不清谁付费的线路不会被自动选中，被拦下的线路会带原因出现在 `/coharness status`。

---

## Council：同一套编排，混合执行后端

```
Orchestrator
  ├─ alpha  → DSH Native
  ├─ beta   → omc:codex（只读 enforced）
  └─ gamma  → omc:kimi（需要 allowAdvisory）
        ↓
原生 synthesizer（无工具，只读各席位结果）
```

Council 保留 OMD 的原有编排逻辑：最多三个独立席位、同一条消息并行派发、全部结算后再合成。合并后只改变席位的执行后端：

- Council Mode 的 Prompt 会列出每个席位实际使用的后端；
- 明确告诉主控：不同席位的工具集不同，外部席位不能假设自己有 DSH 的 `read/glob/grep`；
- 合成器始终是 DSH 原生，失败席位如实进入报告。

---

## 设置卡

`设置 → Oh My CoHarness`：

- 每个角色一行：启用、模型、思考强度、执行后端；
- 选择「外部 CLI」后出现 Harness 下拉、Provider 缺失回退策略、只读等级与风险确认；
- 外部运行时 DSH 模型/强度控件自动禁用；该 CLI 自己的模型在 Harness 区编辑；
- 外部 CLI 区可编辑每个 Harness 的启用状态与模型，只写 `harnesses.<id>.enabled` / `.model`，不重写 `command` / `env` / `envFile` 等字段；
- Harness 状态由 Host 的 `/coharness` RPC 提供，**不在浏览器里重跑 CLI Doctor**；
- 保存仍走 OMD 原有的 revision 冲突保护与 profile 保存流程。

---

## 原生多模型 Demo（最快可用路径）

> 本批新增的 `fleet` / `demo` 命令需要重启 DSH 后才可用（插件代码每个宿主进程只加载一次）。

这条路径**不调用任何外部 CLI**，只使用 DSH 已经能调用的模型：

```text
/coharness fleet            # 预览：角色 → provider/model，来自实时 DSH 目录
/coharness fleet --apply    # 写入（只改 provider/model/execution，先备份）
/coharness demo             # 应用 fleet + 生成确定性 demo 工作区 + 打印 prompt
/coharness status           # 核对每个 native 角色实际钉住的模型
```

`fleet` 的优先级：显式 `models` → 仍挂载的 `oh-my-dsh-slim` 角色配置 → 实时目录关键词匹配。没有目录或没有凭据时，它明确说“角色继承会话模型”，不会编一个模型名。

Demo 工作区默认在 `~/.dsh/omc-demo/run-<timestamp>/`：一个 off-by-one bug、三条 `node:test`、`TASK.md`、记录绝对 Node 路径的 `RUN.md`。把命令输出的 prompt 粘贴进当前会话，由主控依次调用 Explorer / Oracle / Fixer 并跑测试。

完整说明、本机映射示例与验收边界见 [docs/NATIVE-FLEET-DEMO.zh-CN.md](docs/NATIVE-FLEET-DEMO.zh-CN.md)。

## 持久化编排与 Agent 消息

本批把“重启后还能不能解释发生了什么”补进了后端：

- **profile 分区 + 跨进程锁**：`$DSH_HOME/omc/profiles/<profile>/`；同一 Lane 的 native session 由 lease 独占，第二个 Host 得到 `OMC/SESSION-BUSY`，崩溃后按未结算恢复。
- **结果持久化**：`coharness result` 重启后可读；结果体丢失时返回 `status: "unknown"`，不伪造 completed。
- **工作图**：`coharness graph` 的 plan/claim/complete/audit 检查依赖、acceptance evidence、写节点互斥与写范围。
- **消息邮箱**：`coharness send/inbox/ack/thread/reuse`；原生 child 走宿主 `send_message`，外部 child 排队到下一次同 Lane 恢复。
- **CLI 分类**：exit 0 不再自动等于完成；JSON 语义失败、裁剪、空最后消息、resume 身份变化都有独立 code。

详细契约见 [持久化编排](docs/DURABLE-ORCHESTRATION.zh-CN.md)。外部实时 steer、完整项目级角色绑定、native 自定义角色、当前会话 preset、per-child worktree 仍未完成，原因见 [差异审计](docs/OMO-SLIM-PARITY.zh-CN.md#8-p0--p1-完成状态审计2026-11-02-晚第二次)。

## 安装

| 场景 | 做法 |
|---|---|
| Desktop | Plugins 界面安装 `oh-my-coharness`，或本地安装本目录 |
| 有 dsh CLI | `dsh plugin --profile <profile> add oh-my-coharness@0.5.0-alpha.2-practice.1` |
| 本地开发 | 用 `plugin_manager` 的 `install_bundle`，`target` = 本目录绝对路径 |

装完**必须重启 DSH**：插件代码每个宿主进程只加载一次。

**升级前先卸载旧 OMD。** 两个包同时挂载会出现两套角色入口；v0.4 的 Doctor 会明确报告 `legacy preset: oh-my-dsh-slim is STILL mounted`。

---

## 第一次使用

```
/coharness doctor
```

不联网、不调模型、不花配额。它会给出：CLI 发现结果、Provider 注册状态、每个角色的执行后端、只读等级，以及是否还挂着旧 OMD。

```
/coharness status
```

只看角色 → 后端映射与 Provider 注册，不探测 CLI。

```
/coharness migrate
```

预览旧配置迁移（详见 [`docs/MIGRATION.md`](docs/MIGRATION.md)）。

### Harness 支持矩阵（2026-10-29 本机实测）

| Harness | 形态 | 版本 | 只读等级 | 备注 |
|---|---|---|---|---|
| **codex** | `exec --skip-git-repo-check -s <sandbox> "<task>"` | 0.165.0 | enforced | 已真实委派 |
| **opencode** | `run "<task>"` | 2.1.4 | advisory | 已真实委派；`auth: ok` |
| **kimi** | `-p "<task>" [-m model]` | 2.4.0 | advisory | 已真实委派 |
| **antigravity** | `-p "<task>" [--model slug] [--sandbox]`（`agy`） | 1.4.10 | enforced | 已真实委派 |
| **gemini** | `-p "<task>" --skip-trust --approval-mode plan` | 0.66.0 | enforced | 免费 OAuth 已被 Google 弃用，官方指向 Antigravity |
| **glm** | 同 `claude`，端点换 Z.ai | 2.1.312 | advisory | 已真实委派 |
| **claude** | `-p "<task>" --output-format text` | 2.1.312 | advisory | 无 Anthropic 账号时由 `glm` 接管 |
| qwen | `--prompt` | — | unsupported | 未安装、argv 未验证 |

CLI 发现顺序：**配置路径 → PATH → 常见安装根目录 → WSL 各发行版**。`doctor` 的 `exec` 列会显示来源（`native:path` / `native:search` / `wsl:Ubuntu`）。

`auth: unknown` 是正常的：大多数 CLI 没有稳定的状态子命令。OMC 不会因为文件存在就断言「已登录」。

GLM 这类没有自己命令行的模型，仍然可以作为 Harness——`harness = 二进制 × 端点 × 模型`：

```yaml
- id: oh-my-coharness
  name: oh-my-coharness
  config:
    harnesses:
      glm:
        enabled: true
        envFile: "C:/Users/<you>/.dsh/coharness.env"
```

`~/.dsh/coharness.env`（`chmod 600`，不进 profile patch）：

```
ANTHROPIC_AUTH_TOKEN=<你的 GLM Coding Plan key>
```

---

## 安全边界（请先读这段）

- 外部 CLI **运行在 DSH sandbox/approval 之外**。文件策略管不到它们；`enforced` 只读来自 CLI 自己的沙箱，`advisory` 只读只是约定。
- 角色的 `omc:*` Provider 固定只读；`coharness` 的写入必须显式 `mode: "in-place"`，且走 `surface: direct`（无 childId、无宿主容量、无子会话面板）。
- 外部执行只开放给 **Oracle / Explorer / Council 席位**，以及 **Designer 的只读 patch 模式**（产出 diff，由原生 Fixer 应用）。Fixer、Librarian、Observer、Council 合成器保持原生。
- 任务文本会发给该 CLI 自己的服务商。不要把密钥或无关私有内容放进 prompt。
- OMC 不读取 `~/.codex`、`~/.claude`、`~/.gemini` 的凭证，也不写它们。
- Session Registry 只保存 Native Session ID 与会话键（项目 / Lane / 角色 / Harness / 模型 / 工作区 / 端点哈希），不保存 Prompt、对话或凭据；文件按当前用户权限创建（POSIX 下 `0600`）。`/coharness sessions --clear` 只删 OMC 引用，不动 CLI 历史。

---

## 从 0.3.0 + OMD 0.8.6 迁移

1. **先不要卸载 OMD**：运行 `/coharness migrate` 预览，它会读取旧 settings / `oh-my-dsh-slim.json` / 自定义 Profile。
2. `/coharness migrate --apply`：自动备份到 `~/.dsh/coharness-backups/`，再写入新配置；旧 JSON 文件原样保留。
3. 卸载 `oh-my-dsh-slim`，重启 DSH。
4. 旧会话绑定的 `oh-my-dsh-slim` / `omc-harness` preset 不再能解析：迁移会报告数量，但不会改写或删除会话；请用新 Preset 创建新会话。
5. 回滚：`/coharness migrate --rollback`。

迁移只搬运配置引用，**不复制任何 CLI 凭据**。完整步骤、备份结构和回滚边界见 [`docs/MIGRATION.md`](docs/MIGRATION.md)。

---

## 能力与限制（v0.5.0-alpha.2-practice.1）

| 已有 | 暂不提供 |
|---|---|
| **Native 多模型 fleet**：从实时 DSH 目录分配角色模型，继承 OMD-Slim 配置，`status` 校验 | 自动模型能力评分；目录/凭据缺失时自动发现模型 |
| **一键原生 demo**：确定性工作区 + Explorer/Oracle/Fixer prompt | 自动创建并驱动 demo Agent（需要结果契约与超时语义） |
| **持久化编排**：profile 分区、跨进程 Lane 锁、持久结果/unknown、工作图、消息邮箱 | 项目级角色绑定；当前会话 preset；per-child worktree |
| **Runtime 设置卡**：会话复用、resumePolicy、maxTurns、allowUnverified、routing/计费、usage/lane | 逐 Lane 清除仍走命令（`/coharness sessions --clear --lane=<id>`） |
| **显式会话状态**：provider 结果 `sessionOutcome: new/resumed/unconfirmed`；registry stats 汇总 new/resumed/unconfirmed/unknown | direct 模式没有 native session |
| **项目权限下限**：`.omc/project.json` 只能收紧 dispatch/harness/routing | 项目级角色/Prompt/Skill/MCP 绑定 |
| **自定义外部角色模板**：`coharness role` 用户级 + `.omc/roles.json` 项目级，仅 enforced read-only harness；可选 model/fallbacks | native 自定义角色工具；项目级角色可绑定 Prompt/Skill/MCP |
| **显式 dispatch fallback**：仅可重试错误按序尝试并返回 attempts | 角色工具的模型级自动回退链 |
| **Worktree**：`dispatch mode:"worktree"` 每个外部任务独立 checkout；`coharness worktree` 创建/进入 session checkout；显式 merge 有 clean-tree 预检、diff check、冲突 abort 与可选 graph acceptance gate | native child 的 per-child cwd；自动合并策略 |
| **CLI 结果分类**：auth/quota/rate/context/truncated/semantic/id-changed | 外部实时 steer；自动模型回退链 |
| **RoleResult 投影**：native `subagent_result` + external `coharness result.roleResult` 共用 state/complete 词汇 | 外部 provider/model/structured/artifacts 仍为空 |
| **会话 preset 快照**：`coharness preset snapshot/status` 记录并对比本会话实际配置 | 热切换仍受 DSH `agent-preset/locked` 限制 |
| 单 Preset、单安装入口、Native 角色完整回归 | 所有外部 CLI 的 Resume 都经过真实验证 |
| 签名 Handoff：task / project / lane + 最小上下文 | 外部角色直接写工作区（Designer 只产 patch） |
| Native Session Registry：Codex / Claude 默认续接 | Agent 间点对点通信 / 消息总线 |
| Oracle / Explorer / Council 席位切换外部只读 CLI；Designer 外部只读产 patch | 自动模型能力评分 |
| 外部 Persona 自包含 Brief（含 patch 输出契约） | 设置卡中的 Session / routing 控件 |
| Council 混合后端 + 原生合成器 | 新的多 Agent Dashboard |
| CLI 超时、取消、进程树终止、输出裁剪、Usage 元数据 | 自研 Git Worktree 调度器 |
| 配置预览 / 备份 / 回滚迁移 | 多次 dispatch worktree 的自动合并策略 |

---

## 开发与验证

```bash
# 全部测试（Node 20+；DSH Desktop 自带 Node 也能跑）
npm test

# 也可以逐套跑：
node test/smoke.test.mjs
node test/integration/contracts.test.mjs
node test/integration/preset.test.mjs
node test/integration/client.test.mjs
node test/integration/migration.test.mjs
node test/integration/golden.test.mjs
node test/integration/handoff.test.mjs
node test/integration/session-adapters.test.mjs
node test/integration/sessions.test.mjs
node test/integration/provider-session.test.mjs
node test/integration/model-policy.test.mjs
node test/integration/adapters.test.mjs
node test/integration/connection.test.mjs
node test/integration/surface-strict.test.mjs
node test/integration/fleet.test.mjs
node test/integration/durability.test.mjs
node test/integration/cli-result.test.mjs
node test/integration/graph.test.mjs
node test/integration/mailbox.test.mjs
node test/integration/project-policy.test.mjs
node test/integration/worktree.test.mjs
node test/integration/custom-roles.test.mjs
node test/integration/role-result.test.mjs
node test/integration/preset-snapshot.test.mjs
node vendor/omd/test/result.test.mjs

# 包自检：manifest、patch、locales、模块、skills、导出
node scripts/check.mjs

# 打包清单：npm publish 会实际带上哪些文件
node scripts/pack-check.mjs
```

额外的真实环境验收记录见 [`docs/INTEGRATION-ACCEPTANCE.md`](docs/INTEGRATION-ACCEPTANCE.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/OMC-0X-CLOSEOUT.md`](docs/OMC-0X-CLOSEOUT.md) | **0.X 收官实施与验收入口**：0.6–0.9 目标、PR-01～PR-09、五项冻结验收、npm 首发门槛 |
| [`docs/ROADMAP.zh-CN.md`](docs/ROADMAP.zh-CN.md) | 0.X → 1.X → 2.X 产品路线：三个时代、里程碑、完成门槛与三层 Benchmark |
| [`docs/SUPERAGENT-LAYERING.zh-CN.md`](docs/SUPERAGENT-LAYERING.zh-CN.md) | 分层维护体系设计：L0/L1/L2、Mandate 授权、统一验收出口、分期与收益对照门 |
| [`docs/DURABLE-ORCHESTRATION.zh-CN.md`](docs/DURABLE-ORCHESTRATION.zh-CN.md) | profile 分区、跨进程锁、持久结果、工作图、消息邮箱、CLI 分类 |
| [`docs/DESKTOP-ACCEPTANCE.zh-CN.md`](docs/DESKTOP-ACCEPTANCE.zh-CN.md) | 真实 Desktop 混合编排验收清单与记录模板 |
| [`docs/DSH-CONTRACT-LIMITS.zh-CN.md`](docs/DSH-CONTRACT-LIMITS.zh-CN.md) | 仍受 DSH 宿主契约限制的能力与替代方案 |
| [`docs/NATIVE-FLEET-DEMO.zh-CN.md`](docs/NATIVE-FLEET-DEMO.zh-CN.md) | 原生多模型 demo：fleet/demo 命令、本机映射、验证边界 |
| [`docs/OH-MY-PI-REFERENCE.zh-CN.md`](docs/OH-MY-PI-REFERENCE.zh-CN.md) | 参考 Oh-My-Pi：结果契约、生命周期、任务图、分阶段方案 |
| [`docs/STABILIZATION.zh-CN.md`](docs/STABILIZATION.zh-CN.md) | v0.6 稳定版候选：执行渠道、连接状态、双轨默认、PR 拆分与验收矩阵 |
| [`presets/`](presets/README.md) | Safe Native / Hybrid Subscription 配置模板与人工验收记录范式 |
| [`docs/V0.5.md`](docs/V0.5.md) | v0.5：Handoff、Session Registry、适配器、策略与验收边界 |
| [`docs/ARCHITECTURE.zh-CN.md`](docs/ARCHITECTURE.zh-CN.md) | 合并后的分层、契约与关键决策 |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | 从 OMC 0.3.0 + OMD 0.8.6 升级 |
| [`docs/INTEGRATION-ACCEPTANCE.md`](docs/INTEGRATION-ACCEPTANCE.md) | 验收矩阵与证据 |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | 上游基线与固定 commit |
| [`vendor/omd/PATCHES.md`](vendor/omd/PATCHES.md) | 对 OMD 源码的全部改动点 |

---

## 许可证

MIT。OMD 的角色文本改编自 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)（MIT © 2025 alvinunreal），署名保留在 [`LICENSE`](LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
