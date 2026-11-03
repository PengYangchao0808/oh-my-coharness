# 当前剩余工作审计

日期：2026-11-02。对象：当前工作区，OMC `0.5.0-alpha.1`，Unreleased。

本次是状态审计，没有实现新功能或修复以下缺口。已有 268 项测试通过，但新增边界探针复现了测试尚未覆盖的问题；因此此前差异表中的部分“完成”需要降级。本文优先于旧的阶段性完成说明。

## 1. 本次重新执行的检查

| 检查 | 结果 | 范围 |
|---|---|---|
| package.json 中全部测试入口 | **268 pass / 0 fail，27 个文件** | 包括 `vendor/omd/test/result.test.mjs` |
| scripts/check.mjs | **通过** | 15 个 src 模块、入口、插件 patch、locale、5 个 Skill 等 |
| scripts/pack-check.mjs | **通过** | 107 个文件；约 1216.2 KiB；这是仓库清单检查，不是 npm 发布实测 |
| 隔离 DSH 宿主外部配置 | **通过** | 0.2.1-rc.5；9 个主要工具；external Oracle 参数可见；0 模型调用 |
| 新增边界探针 | **复现 3 类未完成行为** | 模拟执行/纯函数；0 CLI 启动、0 模型调用 |
| 真实 Desktop / 混合 Council / 多 CLI 两轮 | **本次未执行** | 既有 Codex 两轮证据继续保留，不能扩展为所有 CLI 或 Desktop 验收 |

自检最初被运行环境的子进程限制阻止；允许模块检查进程后通过，没有把该环境错误当作代码失败。

`git diff --check` 另提示 `src/dispatch.js` 文件末尾多一个空行，属于格式收尾项；本次没有修改该实现文件。

## 2. 已有实现：不再列为“完全缺失”

- 原生角色与模型配置、fleet/demo、外部角色 Lane/交接、Codex 原生会话恢复。
- 按 profile 分区的持久状态、跨进程会话锁、外部任务结果持久化与 unknown 状态。
- 工作图的 plan/claim/complete/audit、依赖检查、已登记写范围冲突检查。
- durable mailbox、原生消息投递、外部消息存储与查询。
- Runtime 设置卡代码、逐 Lane 清除、用量汇总。
- 显式 dispatch fallback、CLI 分类器、项目限制配置、外部只读自定义角色模板。
- 外部 dispatch 独立 worktree 与显式合并、RoleResult 投影、预设快照存储与差异比较。

“已有实现”不等于全部发布验收完成：界面点击、真实账号调用、异常退出和不同平台仍需单独证据。

## 3. 新发现：需要先修的实现缺口

### P0：项目限制会被单次调用参数覆盖

位置：`src/dispatch.js:407`、`:437`；`integration/project-policy.js`。

复现条件：项目 `.omc/project.json` 设置 `dispatch.defaultMode:"read-only"`，调用指定 `mode:"in-place"`。探针观察到实际 Codex 参数为 **`-s workspace-write`**，执行结果仍显示 completed（探针仅使用模拟进程，没有启动 CLI 或写入项目）。

原因：项目限制只改写 `effectiveCfg.dispatch.defaultMode/timeoutMs`，随后单次 `request.mode/request.timeoutMs` 再次优先。显式 timeout 同样没有被项目上限截住。此外，坏 JSON 返回空 policy + warning 后继续派发，省略或相对 cwd 时也不会读取真实项目策略。

判定：项目配置目前只能算**部分限制已接入**，不能承诺“项目强制只读/超时上限不可绕过”。下一步要先解析实际工作目录，再对最终请求应用限制；策略损坏需明确的拒绝或降级契约。

### P1：真实解析器与分类器接在一起后，无效 JSON 仍可被判为成功

位置：`src/session-adapters.js`、`integration/cli-result.js:102`、`:141`。

复现：对 `THIS IS NOT JSON` 调用 `parseSessionOutput("codex-jsonl", stdout)`，得到 `{text:null,sessionId:null,...}`；再传入 `classifyCliResult({exitCode:0,expectJson:true,parsed,...})`，得到 **`status:"completed"`**。

原因：解析器始终返回对象；分类器只判断 parsed 是否为对象，并在 text 为 null 时回退到原始 stdout。现有“非法 JSON”测试用的是 `parsed:null`，没有走真实解析器组合。

判定：CLI 语义分类为**部分完成**。需要结构化的解析成功/终态/错误标记，并增加真实解析器 → 分类器 → Provider 的组合回归。

### P1：预设快照不能保证代表会话启动配置，且漏掉后端变化

位置：`src/index.js:339`、`:348`；`integration/preset-snapshot.js:17`。

复现：Oracle 从 `execution.backend:"native"` 改为 `omc/codex`，`diffPresetSnapshot()` 返回 **`same:true`**。

原因：比较字段没有 execution；snapshot action 在用户调用时读取当前 Host 配置，再写入该父会话，没有在会话创建时捕获不可变基线。温度、maxTokens 等字段也不在比较范围内。

判定：已有的是**按父会话存储的手动配置快照**，不能声称它已经证明“这个会话实际启动时用了什么”。下一步需在会话创建/预设绑定时记录真实基线，并覆盖路由与后端字段。

## 4. 仍未接成闭环的能力

| 项目 | 当前完成部分 | 仍需完成 |
|---|---|---|
| 实时通信 | 原生 send_message；外部 mailbox | OMC 外部 backend 尚未实现 continuable/ACP 控制；运行中不会收到新指令 |
| 外部 reuse | 返回持久任务、messages 和下一步说明 | **不会自行续派，也没有在角色/Provider 启动前自动注入 mailbox**；当前仍要主控显式携带消息 |
| 工作图 | 对主动登记的节点进行依赖/范围/证据检查 | dispatch/role/provider 没有自动 graph claim/settle；不能说所有写入都受统一互斥控制 |
| 原生隔离写入 | 外部任务已有独立 checkout | 给原生孩子创建 checkout、传 cwd、登记归属、验证并合并的流程尚未接入 |
| 自定义角色 | 用户级/项目级 external read-only 模板 | native 自定义角色、项目角色模型/Prompt/Skill/MCP 绑定 |
| 预设切换 | 手动快照与差异查询 | 正确启动快照、当前会话变更策略、已有孩子保持旧配置；首轮后整体 preset 切换确受宿主锁定 |
| 自动回退 | dispatch/custom-role 显式 fallback | 内置角色的失败归因与重试、实际模型记录；fallback 不能只依赖注册时静态选择 |
| 统一结果 | 外部投影 + 原生最新消息 | 原生终态证据、模型/产物/用量等事实，跨原生/外部的一致完成语义 |
| Desktop 体验 | 客户端 bundle 和模型测试 | Runtime 控件保存/冲突、实际混合 Council、取消/超时/父会话关闭全链验收 |
| SLIM 扩展 | 尚未覆盖完整集合 | Observer/附件、AST/LSP、Interview/Implement、Deepwork 恢复、Companion/分屏等 |

## 5. 需要纠正的宿主边界说明

本次直接读取**当前安装的 DSH 0.2.1-rc.5 源码**，不是仅依据旧文档推断：

1. **原生孩子支持独立初始 cwd。** stock `dsh-tool-subagent` 明确声明 cwd，传入请求；`dsh-subagent` 的 continuable 路径解析该目录，创建孩子时调用 `workingDirectory.set(child, create.cwd, ...)`。缺的是 OMC 将 worktree 与这个接口接起来，不能写成“宿主没有 per-child cwd”。
2. **存在运行时 `agentPresets.register(definition)`。** OMC 自己的 `preset.js` 正在使用它。生成/注册新预设供新会话使用是可行路线；不能写成“没有运行时注册接口”。已经开始的会话不能整体 select 新 preset，则确有 `agent-preset/locked` 源码依据。
3. **stock 子代理工具支持能力允许时的逐调用 provider/model/reasoning_effort。** 角色自动回退仍需 OMC 实现与验证，但不能把全部问题归因于“宿主没有 agentOptions 覆盖接口”。
4. **prepareContinuable 是现有可选契约。** 当前 omc Provider 没实现，CLI 适配器也缺少实时控制协议；这属于后端接入工作，不能概括成 DSH 完全没有相应能力。

因此，`DSH-CONTRACT-LIMITS.zh-CN.md` 第 2 / 4 / 5 节的绝对表述，以及旧验收 JSON 中相应说明应按本文修正。它们仍是历史记录，不能作为“只能等待宿主升级”的依据。

## 6. 建议剩余执行顺序

1. **先修三类新缺口**：项目最终请求限制 → CLI 解析/分类组合 → 真实预设快照与 execution diff。
2. **接通协作闭环**：mailbox 注入/消费确认、reuse 真正委派、graph 与 activation 绑定、RoleResult 终态一致。
3. **利用已有宿主接口**：native child cwd/worktree、自定义角色生成/注册新 preset、能力允许的逐调用模型选择与回退。
4. **执行真实 Desktop 验收**：按 `DESKTOP-ACCEPTANCE.zh-CN.md` 记录原生任务、Codex 两轮、混合 Council、取消/超时、Runtime 设置卡；分别覆盖其他 CLI。
5. **再扩展 SLIM 其余功能及发布**：新增能力独立验收，完成版本、tarball 安装和发布说明；当前代码仍未发布。

当前结论：已经具备较完整的 alpha 实现和基础回归，**仍未达到 OMO-SLIM 核心行为完整等价，也未达到 Desktop 全链路稳定发布条件**。不采用完成百分比，以上述验收结果和明确缺口跟踪。
