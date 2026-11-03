# OMO-SLIM 核心链路可用化：本批验收

日期：2026-11-02（Asia/Shanghai）。状态：Unreleased，包版本仍为 `0.5.0-alpha.1`。

## 验收结论

| 项目 | 结果 | 证明的范围 |
|---|---|---|
| 根目录自动化 | 203 pass / 0 fail | 角色/Provider/策略/设置卡模型/交接/续接/任务结果权限等；含本批 14 项新增测试 |
| 包自检 | 通过 | 入口、模块、patch、locale、Skill 与契约检查 |
| 打包清单 | 通过 | `integration/tasks.js` 和文档被 files 覆盖；开发验收脚本不随运行时包发布 |
| DSH 真实宿主 | 0.2.1-rc.5，原生配置通过 | 隔离 profile boot、挂载 OMC 预设、创建父 Agent、9 个主要工具可见；没有模型调用 |
| DSH 真实宿主：外部 Oracle | 通过 | 同上，并确认真实角色工具接受 lane / changed_files 字段；没有外部模型调用 |
| Codex 真实 Provider | 0.166.0-alpha.5.1，两轮通过 | 第一轮记录随机标记，第二轮仅凭原生续接正确回忆；每轮使用新的 Registry 实例，证明引用确实保存到磁盘 |
| 临时工作区 | 两轮后仍为空 | 本次只读探针没有创建文件；这不是恶意写入阻断测试 |
| Desktop 浏览器 UI | 本批未执行 | 暗色下拉绘制、按钮点击、真实混合 Council、父会话关闭后的行为仍待交互验收 |
| Claude/Kimi/OpenCode/Gemini/GLM | 本批未执行真实两轮 | 原有适配置信度和门控保留；不能套用 Codex 的结果 |

真实 CLI 摘要保存在 [evidence/2026-11-02-session-live.json](evidence/2026-11-02-session-live.json)。仅记录掩码会话 ID 和 CLI 自报用量，不保存凭据或测试 nonce。用量数据不是成本节省或性能提升结论。

历史记录 `INTEGRATION-ACCEPTANCE.md` 对应 v0.4 / rc.3，不应覆盖本文件的范围，也不能用本批结果宣称所有历史验收项已通过。

## 自动化新覆盖的行为

- 从角色工具实际注册的参数出发：继承工作目录 → 交接签名 → Provider → 结果保存 → 同 Lane 第二次调用触发原生 resume。
- 交接包含 summary、已改文件、产物引用与验收条件；自定义字段被 OMC 消费，不泄漏到宿主参数接口。
- 外部结果重读不产生新的 CLI 调用；其他父会话既看不到任务列表，也不能重读或取消。
- 取消请求不会立刻把任务标为 cancelled；以实际 stopReason 结算；只保留有界终态结果。
- `new` 真正新开；`require-resume` 在不满足前置条件时失败，并且不留下虚假 running 记录。
- 会话换代重置轮数；忘记/失效后的运行晚到结果不能复活引用；等待 lease 的调用可取消。
- workspace 签名不匹配时关闭复用；Provider 工厂固定只读。
- 本地 fork 的父历史不能冒充孩子输出；Windows/Linux 控件使用不透明背景。
- 过大的交接列表和路径失败而不静默截断；过大的签名交接不会发送到 CLI。

## 当前正确使用方式

### 原生子代理

用 `subagent_*` 启动；保存返回的 child id；用 DSH 的 `send_message` 追加任务或继续；用 `subagent_result` 重读该孩子自己的最新消息。最新消息不代表结算，依赖任务应等待宿主完成通知。模型路由仍要求有效的 provider + model 配对。

### 外部角色：继续同一工作方向

在 OMC 角色配置中启用外部后端，例如 Oracle → Codex，然后调用：

```js
subagent_oracle({
  description: "review session reuse",
  cwd: "/absolute/project/path",
  lane: "session-router-review",
  prompt: "检查会话是否按项目和模型隔离；列出证据。",
  context_summary: "Fixer 已完成第一版，尚未进行独立评审。",
  changed_files: ["src/provider.js", "integration/sessions.js"],
  artifact_refs: ["docs/V0.5.md"],
  acceptance: ["确认同 Lane 串行、不同项目不复用；不要修改文件。"]
})
```

收到完成通知后，原任务的新要求通过**再次调用相同角色工具、相同 cwd/lane、新 prompt**传入。返回新的 DSH child id；CLI native session 仅在匹配且可续接时恢复。不同的独立任务必须使用不同 Lane。

`cwd` 可以由真实宿主的工作目录服务继承；独立调用 Provider 时必须显式传入。路径要对应实际运行环境：Windows/WSL 的转换由 Transport 处理。

### 外部 Provider 任务：发现、重读、取消

```js
coharness({ action: "tasks" })
coharness({ action: "result", task_id: "<返回的外部 child id>" })
coharness({ action: "cancel", task_id: "<返回的外部 child id>" })
```

- 这些是 **coharness 工具 action**，不是新增的 `/coharness tasks` 斜杠命令。
- 仅操作调用父会话自己的外部 **Provider** 运行；`surface: direct` 没有 child receipt，不在此索引中。
- result 返回 status 与实际 output；running 且尚无 result 时不能宣布完成。cancel 走宿主中断，accepted/requested 不是完成。
- 索引是本进程内存，只保留最近 100 个终态结果，活跃结果不被裁掉。Host 重启后会消失；持久 CLI 引用不受此影响。
- 不要把外部 child id 传给 send_message，也不要把 taskId / lane / native session id 混作 task_id。

### 主控交接示例

Oracle 结束 → 主控核对其报告 → 原生 Fixer 实现 → 主控把已改路径与验证结果交给相同 Oracle Lane 再评审。这是当前支持的通信闭环。外部 Agent 不能实时互聊；外部 Designer 仍只输出 diff，由原生 Fixer 落地。

## 开发者复验

常规门禁：

```sh
npm test
npm run check
node scripts/pack-check.mjs
```

本机缺少 npm 命令，因此本批使用 `node.exe` 逐个执行与 npm test 相同的 16 个测试文件。`node --test` 在受限环境下可能因启动子进程被拒；单文件执行不需要启动测试 Worker。静态检查需要允许启动独立模块检查进程。

真实 Codex 两轮（会使用现有 CLI 登录与少量模型配额）：

```sh
node scripts/session-live-check.mjs --command /absolute/path/to/codex --timeout 60000
```

脚本创建两个临时目录，分别放空工作区与验收证据；不读取或复制认证文件。输出 `acceptance.json` 的位置；两轮分别检查 completed、预期 token、新建/恢复诊断和 Registry turns。它通过 OMC Provider 实现调用，并非绕过适配器直接拼命令。接口依据：[OpenAI 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)。

真实宿主零模型检查：

1. 在本仓库 `.ops` 内准备独立 DSH_HOME/profile，bundle 链接当前 checkout；不使用正在工作的 Desktop profile。
2. 设置 `DSH_HOST_ANCHOR` 为当前安装的绝对 `dsh/lib/bin.js`；`DSH_PROFILE_DIR` 指向该隔离 profile。
3. 使用宿主的 Node/Electron 运行 `scripts/host-live-check.cjs`，Electron 需 `ELECTRON_RUN_AS_NODE=1` 和 `--expose-internals`。
4. 默认验收原生配置；增加 `--external` 验收外部 Oracle 参数装载。此选项仅写隔离目录下的探针配置。

通过标记分别包含 `OMC_HOST_LIVE_PASS`、`hostVersion:0.2.1-rc.5`、`externalOracle:false/true`、`modelCalls:0`。这是代码级宿主集成，不等同于真实浏览器渲染、模型侧自主调度或全部 CLI 的配额/认证测试。

## 发布前仍需实际完成

1. Desktop 新建 OMC 会话，实际调用 Oracle/Codex，两轮继续，并核对 UI 的 Lane/会话说明。
2. 两个不同外部 Harness 并行 + 原生 Fixer，再运行混合 Council；如实记录失败席位。
3. 前台退出/取消/超时/父会话关闭，核对容量释放、通知只投递一次、索引状态一致。
4. 重启后恢复 CLI 引用，核对丢失的内存结果不会伪装成可重读。
5. 核对所有变更均进入发布 tarball，更新版本和发布说明后再发布；本批没有发布或改动真实 Desktop 配置。
