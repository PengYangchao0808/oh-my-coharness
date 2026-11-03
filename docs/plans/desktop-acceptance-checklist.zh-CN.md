# Desktop 验收清单（R05 / R09）

用途：把"只能在真实 Desktop 点出来"的部分写成可勾选清单。完成后把截图/录屏放进
`docs/evidence/alpha.2/desktop/`，并在 `docs/evidence/alpha.2/practice-r05-settings.json`
（可新建）里逐项登记 `passed / failed / blocked`。没有这一步，R05 在 backlog 里保持
`partial`，R09 的发布闸门不能算通过。

环境要求：安装版 DeepSeek Harness（本轮探针环境为 `0.2.1-rc.5`），OMC 以默认 Preset 挂载，
使用隔离 profile 或你自己的 profile 都可，但**不要在生产会话里做破坏性验证**。

## A. 设置卡：预算与效率（R05）

1. 打开 设置 → 插件 → Oh My CoHarness → **Runtime** 页签。
   - [ ] 能看到"预算与效率"区块：模式、请求上限、单任务请求上限、费用上限、强制执行。
2. 把请求上限改成 `5`、强制执行保持 `auto` → 保存 → 关闭面板 → 重新打开。
   - [ ] 值仍是 `5`（持久化成功）。
3. 把模式切 `observe → off` → 保存；再切回 `observe` → 保存。
   - [ ] 每次都能保存，且没有任何"静默改模型/改上下文"的情况。
4. 两个窗口同时打开该面板，先后把"费用上限"改成不同值并保存。
   - [ ] 后写者生效、先写者不静默覆盖（或明确提示冲突），不出现半写状态。
5. 费用未知的场景（未配置价格、或未跑过请求）：
   - [ ] 用量行显示 `cost unknown`，**不是** `$0.0000`。
6. 把请求上限改成 `0`（=不限）→ 保存。
   - [ ] 重新打开后是 `0`，且 `budget gate` 回到 advisory（见 B.3）。

截图：`desktop/r05-settings-budget.png`（区块全貌）+ `desktop/r05-settings-reload.png`（重开后的值）。

## B. 运行状态脚注与预算执行（R05 + R02）

1. 在一个新会话里让主控调用 `coharness`（`action:"status"`）。
   - [ ] 输出末尾有 `— runtime —` 段：`native bridge: installed`、`budget gate: ...`、
         `budget now: ...`、`managed coverage: ...`、`usage (this parent): ...`。
2. 把请求上限设成 `1`、强制执行 `on`，然后在一个新会话里让主控发起两次需要真实模型请求的动作。
   - [ ] 第二次请求被拒绝，错误包含 `OMC/BUDGET-EXHAUSTED`；
   - [ ] 界面上任务**没有**被标成"已完成"；
   - [ ] `coharness`（`action:"usage"`）里能看到 `checkpoint: stop-partial`。
   注意：这一步会真实产生模型调用费用（很小，但非零）。
3. 把强制执行改为 `off` 后重复第 2 步的最后一次请求。
   - [ ] 不再被拦截（advisory），但 `usage` 仍显示计数与 `budget now`。
4. 重启 Desktop → 再调 `coharness status`。
   - [ ] 之前的计数仍在（ledger 持久化），断掉的在途请求显示为 `unknown` 而不是 0。

截图：`desktop/r05-status-runtime.png`、`desktop/r02-budget-refused.png`。

## C. 取消 / 超时 / 父会话关闭（R09）

1. 启动一个原生 child 任务，在它运行中取消（或关闭父会话）。
   - [ ] 子任务状态变成 `cancelled`/`unknown`，**不是** `completed`；
   - [ ] 工作图里对应节点被释放/失败，依赖它的后继仍锁着；
   - [ ] 没有产生"已交付"的提示。
2. 设置一个很短的单任务截止（或让外部 CLI 超时），确认：
   - [ ] 结果标记为失败/截止，而不是成功；
   - [ ] 费用记录仍保留（至少一条 `unknown` 或带 usage 的条目）。

截图：`desktop/r09-cancel.png`、`desktop/r09-timeout.png`。

## D. 安装与迁移（R09）

1. 真实 tarball 安装：`npm pack` 产出的 tgz 安装到**隔离 profile**，重启后确认插件加载。
   - [ ] 插件市场/插件列表里能看到 Oh My CoHarness 且版本为当前包版本；
   - [ ] 新会话可调用 `coharness` 工具。
2. 旧配置迁移：对一个含 `oh-my-dsh-slim` 配置/数据的 profile 运行
   `coharness`（`action:"migrate"`）→ 预览 → `migrate --apply`。
   - [ ] 备份文件生成；迁移后角色配置仍在；
   - [ ] `--rollback` 能恢复。

截图/产物：`desktop/r09-install.txt`（命令与输出）、`desktop/r09-migrate.txt`。

## 登记格式

每项写清：`id / 日期 / 包版本（0.5.0-alpha.2-practice.N）/ 宿主版本 / 操作 / 期望 / 实际 / 结论 / 截图路径`。
结论只能是 `passed / failed / blocked`；`blocked` 与未执行都不能算通过。

完成后告诉我，我会把 `docs/evidence/alpha.2/practice-r05-settings.json`（或 R09 的 release 证据）
并入分层基线，再决定 alpha.2 是否达到发布条件。
