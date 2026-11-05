# 0.X 剩余真实验收操作单（待授权，不在本文件中执行）

> 状态：**待执行的操作单，不是验收证据**。本文件不发起任何模型调用。
> 前置：先阅读 [remaining-blocks.json](../evidence/v0.9/remaining-blocks.json)。只有用户重新明确授权后，才能执行 §2/§3；Desktop 点击按 §1 人工进行。
> 统一要求：独立工作树、真实 session/route/attempt/usage 记录、Runner 验收、未知费用记 `null`。不得用现有 25-Trial 或合成测试替代这三项验收。

## 1. Desktop 点击验收（人工）

工具限制：当前自动化工具没有 GUI 点击、截图或鼠标操作面。请人工在 DSH Desktop 中执行，并将结果保存到 `docs/evidence/v0.9/desktop/`。

### 1.1 设置卡（R05）

按 [desktop-acceptance-checklist](desktop-acceptance-checklist.zh-CN.md) 的 R05 六项逐项操作：

- [ ] 打开 OMC 设置卡，记录 `efficiency` 的 observe/balanced、请求上限、单任务上限、费用上限和强制执行开关初值。
- [ ] 修改并保存；重载设置卡，确认值保持。
- [ ] 在两个设置卡实例中并发编辑不同字段，确认没有互相覆盖。
- [ ] 输入类型错误的值，确认被丢弃而不是被强转为“拦截”。
- [ ] 切换模式并验证 observe 不静默改变旧会话的模型、历史回显或路由。
- [ ] 检查四桶用量、未知费用、实际模型路由、检查点和 managed/unmanaged 覆盖；未知费用不能显示为 `$0`。

### 1.2 生命周期与安装

- [ ] 预算到额时，下一次真实请求被阻止，且界面显示停止原因，不把 stop-partial 当完成。
- [ ] 取消一个运行中的任务：先显示取消请求，只有真实终态出现后才显示 cancelled。
- [ ] 验证超时、父会话关闭和宿主重启后的 `unknown` 状态，不自动重放。
- [ ] 用本地 tarball 在隔离 profile 中安装，验证迁移、回滚、启动和卸载；不得使用真实工作会话做破坏性验证。

每条记录：日期、包版本、DSH 版本、profile、操作、期望、实际、结论（passed/failed/blocked）、截图路径。没有截图和版本信息的项不得标 passed。

## 2. External Mixed 真实工作流（需重新授权）

**目标**：External Codex Oracle → Native Fixer → 独立 Runner Verify。只执行一次，预算上限和模型路线须在执行前由用户明确写出。

### 2.1 准备

- 在隔离测试工作区创建一个小的、预期可修复的源代码任务，并准备可执行的 acceptanceSpec。
- `coharness graph_action:plan` 建三个依赖节点：`oracle-read`（write:false）→ `native-fix`（write:true，限定 writeScope）→ `verify`（独立验收）。
- Codex 必须为 `routable`，Native Fixer 使用已验证的 Native route；禁止把外部角色切换为 writer。

### 2.2 执行

1. `coharness dispatch` 使用 `node_id=oracle-read`，read-only 完成外部分析；保存 task/receipt、route、usage 和结果。
2. 以该结果作为 Native Fixer 的受控 WorkPacket/Handoff 输入，在子会话首个请求前 `native_action:bind`，冻结 baseline。
3. 让 Native Fixer 在限定 writeScope 内修改，等待真实 `turn/end`；`native_action:settle` 由 Runner 产生 verdict。
4. 核对 changed_files、独立验收、三节点状态、Native/External usage 归属与项目 Writer Lease。

### 2.3 通过条件

- Oracle 只读；Fixer 只改允许文件；验收由 Runner 通过；三节点 completed。
- receipt 包含 external/native 两种 route、真实 session/attempt、四桶 usage 和最终 verdict；未知费用保持 `null`。
- 任何 NO_ADAPTER、权限绕过、缺 baseline、Writer 冲突或自报 verdict 都是基础设施失败，不计为普通模型错题。

## 3. Managed Council 真实工作流（需重新授权）

**目标**：至少两个不同模型/后席位只读评审，Native Synthesizer 汇总，全过程进入 Graph/Ledger/Acceptance。

### 3.1 执行

1. `coharness council_action:plan` 创建两个只读席位节点和一个依赖全部席位的 synthesizer 节点。
2. 每个席位用 `council_action:seat` 绑定真实只读子会话，记录 `child_session_id`、node、route 与 read-only 约束；不得给席位写权限。
3. 全部席位结束后，以 `council_action:synthesize` 绑定 **Native `council`** 合成器，输入每席原始结果，不先替它筛选结论。
4. `council_action:settle` 逐节点结算，由独立 Runner/预设验收决定最终状态。

### 3.2 通过条件

- 至少两个不同 sessionId 和可区分的实际模型路由；席位零文件修改。
- synthesizer 必须为 Native `council` 角色、无工具；汇总保留每席详情，失败席不得包装成共识。
- Graph、usage ledger、acceptance verdict 能对应到同一 root/task/attempt；未知费用保持 `null`。

### 3.3 必测负向

- 一个席位失败或被取消时，synthesizer 不得被 claim 为可汇总的依赖完成状态。
- prompt-only Council 若未经过本 managed action，状态必须仍为 unmanaged，不能宣称已覆盖。

## 4. 证据归档与冻结

每项成功后分别写：

```text
docs/evidence/v0.9/desktop/<checklist-id>.json + screenshots
docs/evidence/v0.9/mixed-live-receipt.json
docs/evidence/v0.9/council-live-receipt.json
```

然后：

1. 更新 `remaining-blocks.json` 的对应 block，附真实证据，不删除历史 blocked 记录。
2. 复跑 `node scripts/run-tests.mjs`、`node scripts/check.mjs`、`node scripts/pack-check.mjs` 并等待 CI 全绿。
3. 只有 [OMC-0X-CLOSEOUT §8](../OMC-0X-CLOSEOUT.md) 全部硬验收满足后，才更新 backlog、README 和 0.X 状态，并讨论内部 0.9 Tag。
4. 仍不发布 npm；首次公开发布门槛仍是 1.X Coharness Core GA。
