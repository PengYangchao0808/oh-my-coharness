# v0.4.0-alpha.1 集成验收记录

日期：2026-10-30。宿主：DSH **0.2.1-rc.3**（Windows，Desktop 安装的 `dsh` CLI）。
基线：OMC v0.3.0 `b2f0d39` + OMD v0.8.6 `537d4c7`。

> 原则：只记录真实执行过的证据。**没有跑过的项明确标为未验证**，不用“应该可以”代替。

## 1. 自动化门禁

| 套件 | 命令 | 结果 |
|---|---|---|
| OMC 原有回归 | `node test/smoke.test.mjs` | **36 pass / 0 fail** |
| 执行契约 | `node test/integration/contracts.test.mjs` | **14 pass / 0 fail** |
| Preset / 角色 | `node test/integration/preset.test.mjs` | **10 pass / 0 fail** |
| 设置卡模型 | `node test/integration/client.test.mjs` | **8 pass / 0 fail** |
| 迁移 | `node test/integration/migration.test.mjs` | **9 pass / 0 fail** |
| 包自检 | `node scripts/check.mjs` | **ok**：manifest / patch / locales / 11 modules / 5 skills |
| 打包清单 | `node scripts/pack-check.mjs` | **ok**：67 files · 708.8 KiB unpacked |

覆盖的契约：

- native 默认、external 解析、Provider 缺失 blocked、`fallback: native`、advisory 拒绝 / 显式接受、unsupported 拒绝、未知 harness、结构性错误；
- `stockConfig` 外部分支**完全省略 `agentOptions`**、`maxDepth: provider-managed`；
- 外部 Persona Brief：保留角色职责、删除 DSH 工具段落、写入只读等级与返回格式；
- Council 文本列出每个席位后端、不再假设工具集相同、合成器原生；
- 客户端 draft / write-plan / profile 文档的 `execution` 往返，native 不产生多余字段；
- 迁移的合并、冲突、`--force`、备份、旧会话检测；
- Provider 即使全局 `defaultMode: in-place` 也以 `-s read-only` 启动。

## 2. 真实宿主装载（隔离 profile）

为了不触碰正在使用的 Desktop profile，在 workspace 内建立隔离 `DSH_HOME` 与 `omc-test` profile：

```powershell
$env:DSH_HOME = "E:\Calculations\Plugins\Oh-My-CoHarness\.ops\dsh-home"
dsh --profile omc-test --dump-config
dsh --profile omc-test --no-open --port 0
```

证据：

1. **`--dump-config` exit 0**，组合中出现：
   - `oh-my-coharness`（Host row）
   - `preset-oh-my-coharness`（Preset row）
   - `oh-my-coharness-profiles`（Profile row）
   - `agent-preset-registry` 的 `default: oh-my-coharness`
2. **Web host 启动成功**，HTML 的 `__DSH_BOOT__` 图里只有：
   - `{"id":"oh-my-coharness", ... "immediately":true}`
   - 没有 `oh-my-dsh-slim` 客户端条目。
3. **客户端 bundle 实际可取回**：
   - `GET /plugins/??oh-my-coharness/client.js` → HTTP 200，118,770 bytes；
   - 包含 `id: 'oh-my-coharness'`、`0.4.0-alpha.1`、`executionBackend`、`execution-status`、`/coharness`。
4. **`/coharness/execution-status` RPC 实际返回**：
   - `presetId: oh-my-coharness`，`source: DSH plugin settings: oh-my-coharness`；
   - `presetIds` 含 `oh-my-coharness`，`legacyPreset: false`；
   - providers：`spawn, fork, omc:opencode, omc:codex, omc:claude, omc:antigravity, omc:gemini, omc:kimi`；
   - 10 个角色全部 `native`、`blocked:false`；
   - harness 只读等级：codex/gemini/antigravity = enforced，opencode/kimi/claude/glm = advisory，qwen = unsupported。
5. **Native preset 会话创建成功**：
   - `POST /api/session/create` → `{sessionId, agentPreset:"oh-my-coharness"}`。
   - 会话创建会挂载整个 preset composition；成功意味着 10 个 role row、role-composition、Council、MCP 等全部通过宿主校验。
6. **外部 Oracle 配置真实装载**：把隔离 profile 的 Host row 改为
   `roles.oracle.execution = {backend: omc, harness: codex}`，重启后：
   - status 返回 `execution:"omc:codex"`、`backend:"omc"`、`readOnly:"enforced"`、`providerAvailable:true`、`blocked:false`；
   - 再次 `session/create` 成功 —— 说明 external stock config 通过了官方
     `@deepseek-ai/dsh-tool-subagent` 的能力检查（无 `agentOptions`、`maxDepth: provider-managed`、provider 已注册）。

上述 6 项是本次最关键的“单 Bundle + 外部角色可装载”证据。

## 3. 用户 16 项验收清单

图例：✅ 已验证；🟡 代码/单元验证，真实运行未做；❌ 未验证。

| # | 项目 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | OMD 源码已导入并保留许可证 | ✅ | `vendor/omd/`、`UPSTREAM.json`、两份 LICENSE、`THIRD_PARTY_NOTICES.md` |
| 2 | 只有一个默认 OMC Preset | ✅ | dump-config + status：`default: oh-my-coharness`，无旧 preset row |
| 3 | OMD Native 角色回归通过 | ✅ | 36+14+10 单测；隔离宿主 native preset 会话创建成功；上游 runtime/model-switch 测试仍通过 |
| 4 | OMC Provider 与 Doctor 正常注册 | ✅ | status RPC 列出 6 个 `omc:*`；doctor 渲染路径由单测覆盖 |
| 5 | Oracle 可选择 Native / Codex | 🟡 | native / external 两种配置都在真实宿主装载成功；**真实 Codex 运行未做** |
| 6 | 外部 Persona 正确传入 CLI | 🟡 | Brief 生成、DSH 工具段落裁剪、execute 包装均有单测；**真实 CLI 回显未做** |
| 7 | 外部角色只读能力经过验证 | 🟡 | 三级分类、advisory 默认拒绝、Provider 强制 `-s read-only` 有单测；**真实 CLI 写入探针未做** |
| 8 | Native 持续会话保持正常 | 🟡 | 未改 `prepareContinuable`/`send_message` 路径；**真实两轮续接未做** |
| 9 | Council 支持不同 Backend | 🟡 | 混合席位文本、per-seat 解析、preset 装载有验证；**真实混合 Council 未做** |
| 10 | Council Synthesizer 仍为 Native | ✅ | `validateExecution` 拒绝 `council` 外部；preset 中 synthesizer 为 native |
| 11 | ULW 不存在重复调度 | ✅ | Skill 文档与架构明确唯一 Orchestrator；没有新增调度器 |
| 12 | 失败、取消、超时正确上报 | ✅ | OMC smoke：direct/provider 超时、取消、background unsupported、CLI missing |
| 13 | 设置卡支持 Backend 选择 | 🟡 | 客户端 bundle 实际由宿主提供，执行控件与 RPC 有单测；**未做浏览器点击** |
| 14 | 配置保存与重启恢复通过 | 🟡 | 隔离宿主从 settings 读出角色配置并跨重启生效；**设置卡保存按钮未点击** |
| 15 | 旧配置可迁移与回滚 | 🟡 | 迁移单测覆盖合并/冲突/备份/回滚；**真实旧 OMD settings 未迁移**（隔离 home 无旧配置） |
| 16 | Desktop + WSL 完整测试通过 | ❌ | 当前 agent shell 被宿主拒绝访问 WSL（`Wsl/E_ACCESS_DENIED`），无 native CLI；Desktop 在线 profile 未切换，避免破坏正在使用的环境 |

## 4. 为什么第 16 项没有做

- 本机可用 CLI 全在 WSL；从当前 agent 沙箱执行 `wsl.exe -l -q` 返回
  `Wsl/E_ACCESS_DENIED`（DSH 沙箱限制），因此无法真实启动 codex/kimi/opencode。
- 正在运行的 Desktop profile 仍同时挂着 OMD v0.8.6（用户环境），直接切换会让当前会话失去角色工具；
  本次用隔离 `DSH_HOME` + `omc-test` profile 完成宿主级验证，没有改用户 profile。
- 要在真实 Desktop 完成第 5/6/7/9/16 项，需要在 Desktop 里：
  1. 运行 `/coharness migrate` 并卸载 OMD；
  2. 重启 Desktop；
  3. 新建一个 Oh My CoHarness 会话；
  4. 让主控调用一次外部 Oracle，确认 Codex 输出里出现角色首行；
  5. 配两个混合 Council 席位并跑一次真实评审。

这些步骤已写入 [`MIGRATION.md`](./MIGRATION.md) 与 README 的验收清单，不应被本文的“通过”字样掩盖。

## 5. 复现命令

```powershell
$node = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node test/smoke.test.mjs
& $node test/integration/contracts.test.mjs
& $node test/integration/preset.test.mjs
& $node test/integration/client.test.mjs
& $node test/integration/migration.test.mjs
& $node scripts/check.mjs
& $node scripts/pack-check.mjs
```

隔离宿主复现：

```powershell
$env:DSH_HOME = "<repo>\.ops\dsh-home"
& "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  --profile omc-test --dump-config
```

`.ops/` 是本地诊断目录，已被 `.gitignore` 排除，不会进入 npm 包。
