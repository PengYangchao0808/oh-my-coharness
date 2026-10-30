# Oh My CoHarness 架构（v0.4.0-alpha.1）

> 基线：OMC v0.3.0（`b2f0d39`）+ OMD v0.8.6（`537d4c7`），目标运行时 DSH 0.2.1。
> 本文描述合并后的实际结构；不是未来设想。

## 1. 目标

一个独立安装、完整可用的多 Harness Agent 工作流插件：

- **OMD 提供编排产品面**：Orchestrator、六个专业角色、Council、角色模型/强度/工具配置、Profile 管理、设置卡。
- **OMC 提供执行内核**：CLI 发现、`omc:<id>` Provider、Windows/WSL Transport、`coharness` 工具、Doctor。
- **DSH 提供运行时**：官方 Subagent、Session、工作区、权限、插件市场与桌面 UI。

不合并两套角色系统，不新造运行时，不开发消息总线。

## 2. 分层

```
DSH Host（模型 / Session / 工作区 / 权限 / 插件 / 子 Agent 注册表）
│
├── oh-my-coharness（唯一的 Bundle）
│   ├── Host row  `oh-my-coharness`
│   │   ├── OMD companion：settings schema、Profile RPC、启动报告
│   │   └── OMC Host：omc:* Provider、coharness 工具、/coharness 命令、skills
│   ├── Preset row `preset-oh-my-coharness`
│   │   ├── Orchestrator persona
│   │   ├── role rows：subagent_oracle / explorer / fixer / designer / librarian
│   │   ├── Council rows：3 seats + synthesizer
│   │   └── role-composition / subagent-roles / council-mode / role-mcp …
│   └── Profile row `oh-my-coharness-profiles`
│       └── 用户命名的角色配置（ConfigEditor 持久化）
│
└── 外部 CLI（Codex / Gemini / Antigravity / opencode / Kimi / Claude …）
```

关键点：**Host row 只有一条**。设置 schema、Provider 注册和 Profile RPC 都挂在这条 row 上，因此：

- 一个 settings namespace（`oh-my-coharness`）；
- 一个 profile patch 覆盖点（`- id: oh-my-coharness`）；
- 一个客户端 bundle（`client/client.js`）；
- 用户不需要同时装两个包。

## 3. 配置契约

### 3.1 角色执行块

```json
{
  "roles": {
    "oracle": {
      "execution": {
        "backend": "omc",
        "harness": "codex",
        "fallback": "fail",
        "allowAdvisory": false
      }
    }
  }
}
```

- `backend`: `native | omc`。缺省 = native。
- `harness`: OMC 的 CLI id。
- `fallback`: `fail | native`。缺省 `fail`；`native` 只用于 Provider 缺失或环境拒绝时显式回退。
- `allowAdvisory`: 只有 `true` 才接受 advisory 只读。

`execution` 与 `provider`/`model` **不是同一个轴**：

- `provider`/`model` 是 DSH LLM 路由，只服务 native 路径；
- `execution` 是“谁来执行”，外部路径使用 CLI 自己的模型配置；
- 配置里不会把 `provider` 改写成 `omc:<id>`。

### 3.2 一份设置文档

Host row 的 Config schema 同时声明：

- OMD 字段：`preset`、`presets`、`roles`、`mcpServers`、`advanced`、`orchestrator`；
- OMC 字段：`surface`、`transport`、`harnesses`、`wsl`、`dispatch`、`privacy`；
- 新增 `execution`。

二者共用同一个 profile patch 文档。用户原有的 OMC harness 配置不需要搬家；OMD 的 `defaults.json` 仍是角色默认层。

### 3.3 Profile

`oh-my-coharness-profiles` 保存用户命名的角色配置。每个 Profile 仍是一个完整的原生 agent preset（id `profile-*`），通过 ConfigEditor 持久化，保留 revision 冲突保护。删除 Profile 不删除旧记录之外的任何数据。

## 4. 执行解析

`integration/execution.js` 是纯函数：

```js
resolveExecution(roleId, roleConfig, availableProviders)
```

- `availableProviders` 必须来自 `ctx.subagents.list()` 的实时结果，不能来自静态注册表。
- 返回 native 或 external 的 stock 参数；external 额外返回 harness、readOnly、provider、mode（`read-only` | `patch`）。
- 环境性失败（Provider 未注册、advisory 只读、只读不可验证）返回 `blocked`，不抛异常；结构性错误（未知 backend、写角色配外部、Council 合成器配外部）抛错。
- `blocked` 的角色仍注册同名工具，但调用即失败，原因写入工具描述与错误。**不会静默改成 native。**

`integration/compatibility.js` 是唯一角色能力表：

- 可外部只读：oracle、explorer、councillor-alpha/beta/gamma；
- 可外部但固定 `patch`：designer —— 产出 unified diff，由原生 fixer 落地；
- 必须原生：fixer、librarian、observer、council。

## 5. Native 路径

与 OMD 0.8.6 完全一致：

- 角色行把手上的 stock config 交给 DSH 官方 `@deepseek-ai/dsh-tool-subagent`；
- `role-composition.js` 在 `agent/created` 注入 Persona 并 `tools.restrict()`；
- `subagent-roles.js` 在 `agent/request` 处理模型继承、effort、温度、输出上限；
- `role-mcp.js` 只给 continuable 的原生角色挂 MCP；
- 角色工具仍可续接，`send_message` 继续可用。

合并没有重写这条路径；Native 回归是发布门槛。

## 6. External 路径

外部 CLI 不是 DSH 子 Agent，因此：

1. **Persona 不经过 `agent/created`**。`roles.js` 在既有工具 `execute()` 包装点把任务改写成自包含 Brief：
   - 角色 Persona（裁掉 DSH 工具专属段落）；
   - 任务；
   - 只读等级与约束；
   - 工作目录；
   - 固定返回格式（Summary / Evidence / Files / Verification / Uncertainty）。
   - patch 模式（目前仅 designer）把返回格式换成 patch 契约：一个 unified diff、仓库相对路径、可由 `git apply -p1` 应用；仍然不写文件。
2. **Provider 配置必须是 external-safe 的**：
   - `provider: omc:<harness>`；
   - `maxDepth: 'provider-managed'`（OMC provider 没有 depthLimit）；
   - **完全省略 `agentOptions`**（官方工具用 `!== undefined` 判定，空对象也会被拒绝）；
   - 不传 `agentPreset`、`modelSelectionSettings`。
3. **只读是 Provider 属性**：`omc:*` Provider 始终以 `read-only` 启动，不受全局 `dispatch.defaultMode` 影响。
4. **一次性**：外部 Provider 没有 `prepareContinuable`，因此没有后续 `send_message`；结果通过完成通知返回。
5. **失败可见**：Provider 未注册 → blocked；CLI 退出非 0 / 超时 / 取消 → `SubagentResult.stopReason` 与诊断进入主控，Council 如实汇总。

## 7. Council

保留 OMD 的编排：最多三席、同一条消息并行派发、全部结算后调用原生 synthesizer。

合并只改变席位执行后端：

- `council-mode.js` 输出每个席位的实际后端；
- 明确说明不同席位工具集不同，外部席位不能假设有 DSH 的 `read/glob/grep`；
- 合成器永远 native，且无工具；
- 失败席位写入 `Per-Councillor Details`，不包装成共识。

## 8. 前端

保留 OMD 的设置卡，只增加执行后端控件：

- `role.execution` 的读、校验、保存、重新加载都走原有 `configForms` / revision 流程；
- Harness 区可编辑 `harnesses.<id>.enabled` 与 `.model`；写计划按字段 path-scoped，不重建整个 entry；
- Harness 状态通过 Host RPC `/coharness` 的 `execution-status` 获取；
- 浏览器端不实现 CLI Doctor；
- Native 仍是缺省值，未改动的角色不会因为打开设置卡而写入 `execution` 字段。

## 9. 迁移与兼容

- 配置读取顺序：`OH_MY_COHARNESS_CONFIG` → profile snapshot → `$DSH_HOME/oh-my-coharness.json` → 旧 `oh-my-dsh-slim.json` → defaults。
- `/coharness migrate` 预览、备份、写入、可回滚；只迁移配置引用，不复制凭据。
- 旧会话绑定的 `oh-my-dsh-slim` / `omc-harness` preset 无法解析；迁移只报告数量，不改写会话。
- 自定义 Profile 从旧 registry row 复制到新 row，旧 row 不删除。
- 旧 OMD 角色标记 `oh-my-dsh-slim-role:` 仍可读，保证冷恢复的旧子会话还能被识别。

## 10. 明确不做

- 外部 CLI 原生 Session Resume；
- Agent 间点对点通信 / 消息总线 / 任务数据库；
- 外部角色直接写工作区（Designer 的外部模式只产 patch，不直接写）；
- 自研 worktree 调度器；
- 自动模型能力评分；
- 第二套 Dashboard 或第二套角色注册表。

这些不是永久拒绝，而是 v0.4 不引入未经联合验证的新运行时。
