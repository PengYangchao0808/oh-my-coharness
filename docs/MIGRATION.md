# 从 OMC 0.3.0 + OMD 0.8.6 迁移到 Oh My CoHarness v0.4.0-alpha.1

本指南覆盖三类旧数据：

| 旧数据 | 处理 |
|---|---|
| OMC 的 CLI / WSL / 认证路径配置 | 原样保留（同一个 profile row id） |
| OMD 的角色、Council、模型、Profile | `/coharness migrate` 一次性导入统一配置 |
| 旧会话绑定的 `oh-my-dsh-slim` / `omc-harness` Preset | 不迁移，只报告；请新建会话 |

> 迁移只搬运**配置引用**，不读取、不复制任何 CLI 凭据文件。

---

## 0. 先备份

迁移命令会自己写备份，但升级前仍建议：

```powershell
# 退出 DSH Desktop 后执行
Copy-Item "$env:USERPROFILE\.dsh\profiles\<profile>\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\<profile>\cordis.patch.yml.pre-0.4"
Copy-Item "$env:USERPROFILE\.dsh\oh-my-dsh-slim.json" `
          "$env:USERPROFILE\.dsh\oh-my-dsh-slim.json.pre-0.4" -ErrorAction SilentlyContinue
```

---

## 1. 安装 v0.4，但先不要卸载 OMD

迁移需要读取旧 settings / 旧 registry row。先把 `oh-my-coharness` 升到
`0.4.0-alpha.1`，重启 DSH，然后运行：

```
/coharness migrate
```

这是**只读预览**。它会列出：

- 找到的旧配置来源（settings / `oh-my-dsh-slim.json` / 自定义 Profile）；
- 将要新增、覆盖、保留的每个字段；
- 与当前配置冲突的值（默认保留当前值，需 `--force` 才覆盖）；
- 绑定旧 Preset 的会话数量（只统计，不改写）。

确认无误后：

```
/coharness migrate --apply
```

若要覆盖冲突值：

```
/coharness migrate --apply --force
```

---

## 2. 迁移做了什么

1. 把旧角色文档（`preset` / `presets` / `roles` / `mcpServers` / `advanced` / `orchestrator`）合并进新的
   `oh-my-coharness` settings 文档；新文档为空时直接整体导入。
2. 把旧 `oh-my-dsh-slim-profiles` 中的自定义 Profile 复制到
   `oh-my-coharness-profiles`；同名 Profile 不覆盖，非法配置跳过。
3. 写入前在 `$DSH_HOME/coharness-backups/migrate-<timestamp>.json` 保存
   `current` / `legacySettings` / `legacyFile` / `legacyProfiles` 四份文档。
4. 旧 `oh-my-dsh-slim.json` **不重命名、不删除**；旧 registry row 也不删除。
5. 不迁移的内容：
   - CLI 登录状态与凭据；
   - 旧会话正文与旧 Preset 绑定；
   - 旧插件目录 / 旧 bundle row（卸载 OMD 时由插件管理器处理）。

迁移后的配置位置：

- Desktop / Web：profile patch 中的 `oh-my-coharness` row（设置卡编辑同一份文档）；
- CLI / 无 settings 服务：`$DSH_HOME/oh-my-coharness.json`；
- 自定义 Profile：`oh-my-coharness-profiles` row。

---

## 3. 卸载旧 OMD

确认迁移成功后：

1. 在插件管理器中卸载 `oh-my-dsh-slim`（或 `dsh plugin --profile <p> remove oh-my-dsh-slim`）；
2. 完全退出并重启 DSH；
3. 运行 `/coharness doctor`，确认：
   - `legacy preset: ...` 不再出现；
   - `providers: omc:...` 有你的 Harness；
   - `role execution` 表里的后端符合预期；
   - 没有任何 `blocked roles`。

两个包同时挂载时会出现两套角色入口；v0.4 的 Doctor 会显式报告，但不会替你卸载。

---

## 4. 旧会话

DSH 把 Agent Preset id 保存在会话头里。旧会话可能绑定：

- `oh-my-dsh-slim`（OMD 默认 Preset）
- `omc-harness`（OMC 0.3 的外部 Harness 角色 Preset）

v0.4 不再注册这两个 id，因此旧会话**不能恢复原来的角色组合**。

处理原则：

- 不删除、不改写旧会话；迁移只报告数量；
- 需要继续工作时，用新的 `Oh My CoHarness` Preset 新建会话；
- 旧会话仍可用于回看历史。

不要把旧会话的失败当成迁移失败：这是两个产品身份合并的必然边界。

---

## 5. 回滚

```
/coharness migrate --rollback
```

它读取**最新**的 `migrate-*.json`，把其中的 `current` 文档写回新的 settings
namespace（没有 settings 服务时写回 `oh-my-coharness.json`）。

回滚不会：

- 恢复旧 OMD 插件；
- 恢复旧会话的 Preset 绑定；
- 删除迁移期间复制到新 registry 的 Profile（旧 row 仍在，可人工清理）。

需要完整恢复旧版时：卸载 v0.4，重装 `oh-my-coharness@0.3.0` 与
`oh-my-dsh-slim@0.8.6`，再恢复第 0 步的 `cordis.patch.yml.pre-0.4` 与旧 JSON。
不要在 Desktop 打包运行时内部直接改文件。

---

## 6. 迁移后的验收清单

- [ ] `/coharness doctor` 无 `legacy preset`
- [ ] `role execution` 表与预期一致
- [ ] 设置卡能打开、保存、重启后保持
- [ ] 原生 Oracle 可启动并可 `send_message` 续接
- [ ] 外部 Oracle（如配置）收到完整 Persona Brief，而不是原始 prompt
- [ ] Council 混合席位能独立返回，synthesizer 正常汇总
- [ ] 旧 JSON 与备份文件仍在
- [ ] 旧会话未被删除
