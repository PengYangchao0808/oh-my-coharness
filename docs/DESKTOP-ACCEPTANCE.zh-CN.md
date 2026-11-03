# Desktop 混合编排验收清单

日期：2026-11-02。状态：**待执行**。隔离宿主与 Codex Provider 两轮已分别通过；本文件是唯一能证明“真实 Desktop UI 全链路”的验收记录模板。

> 这是人工验收，不是 CI。每条记录必须保存脱敏后的会话 id、命令、输出摘要和失败原因；不要把“隔离宿主通过”写成“Desktop 通过”。

## 1. 前置

- DSH Desktop 0.2.1-rc.5 或当前验证版本；OMC 插件已重启加载。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 中 OMC 为默认 preset，或新建会话时手动选择 **Oh My CoHarness**。
- `codex` 已登录；`/coharness doctor` 显示 codex `auth: ok`、`routable`。
- 临时工作区：一个独立 git 仓库；不要用正在开发的主仓库做写入验收。

## 2. 用例 A：Native Oracle → Fixer

1. 新建 OMC 会话，工作目录设为临时仓库。
2. 让主控调用 `subagent_explorer` 找一个预置 bug。
3. 让主控调用 `subagent_oracle` 评审修复方案。
4. 让主控调用 `subagent_fixer` 写入修复。
5. 让主控运行测试，并调用 `subagent_result` 或完成通知回收。

**通过条件：**

- Explorer 报告具体文件/行；Oracle 方案可执行；Fixer diff 只改预期文件。
- 测试退出码与输出真实；`/coharness status` 显示三个角色实际模型。
- 没有把“子 Agent 已报告”当作整体完成。

**证据：** 会话 id、三个 child id、`git diff --stat`、测试命令/退出码。

## 3. 用例 B：Oracle/Codex 外部只读

1. 把 Oracle 配置成 `execution.backend = omc`、`harness = codex`（或运行 `/coharness fleet` 后手动改这一角色）。
2. 调用 `subagent_oracle`，传入 `lane`、`context_summary`、`changed_files`、`artifact_refs`、`acceptance`。
3. 等待完成通知，再用 `coharness({action:"result", task_id})` 重读。
4. 用同一角色、同 cwd、同 lane 再调用一次，检查是否 resume。

**通过条件：**

- 首次结果带 `surface: provider`、child id、session new/resumed 诊断。
- 第二次调用复用同一 native session（或明确显示 unconfirmed/ID changed）。
- 临时工作区在只读运行前后无变化（文件哈希）。

**证据：** 脱敏 child id、native session 掩码、`git status` 前后、接受标准。

## 4. 用例 C：混合 Council

1. alpha = native，beta = omc:codex，gamma = native（至少两个席位）。
2. 同一问题派发三个席位；等全部结算。
3. 让原生 synthesizer 汇总。

**通过条件：**

- 每个席位实际后端在 Prompt/结果里可见。
- 失败席位如实报告，不伪造共识。
- synthesizer 没有外部执行。

## 5. 用例 D：取消 / 超时 / 父会话关闭

1. 启动一个较慢的外部 Oracle。
2. 分别测试 `interrupt_agent`、`coharness({action:"cancel", task_id})`、关闭父会话。
3. 检查结果索引状态与容量释放。

**通过条件：**

- cancel 请求不立即显示 completed/cancelled；等待真实结算。
- 父会话关闭后，外部 child 不会把结果投递到不存在的父会话。
- Host 重启后 `coharness result` 返回 `unknown` 或持久结果，不伪造。

## 6. 用例 E：Runtime 设置卡

1. 打开 设置 → Oh My CoHarness → **Runtime**。
2. 切换 session reuse、resumePolicy、routing/计费开关；保存。
3. 关闭并重开设置卡；确认值持久。
4. 用 `/coharness sessions` 查看 usage/lane；用 `--clear --lane=<id>` 清除一个 Lane。

**通过条件：**

- 控件可点击、值保存、revision 冲突有提示。
- 设置变化不改变已经运行的 child 的既有配置。
- 清除只影响指定 Lane。

## 7. 记录模板

```text
日期/版本：
DSH / OMC / Codex 版本：
会话 id：
用例：
角色 → 后端 → provider/model：
child ids：
测试命令 / 退出码：
关键输出（脱敏）：
失败/不确定项：
结论：PASS / FAIL / BLOCKED
```

## 8. 当前已知边界

- 外部运行中**实时 steer**不可用；只能 mailbox 排队，下一次同 Lane 带入。
- 当前会话 preset 热切换受 DSH `agent-preset/locked` 限制。
- per-child worktree 不可用；`coharness worktree` 是 session-wide。
- 没有真实 Desktop 记录之前，不要把 P0-4 标为完成。
