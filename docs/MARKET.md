# 发布与收录清单

v0.4.0-alpha.1 的发布物仍然只有**一个 npm 包**：零运行时依赖、一个 Bundle、一个默认 Preset、五个 Skill、一张设置卡。市场收录是另外两步，不能靠 `npm publish` 自动发生（DSH 没有官方索引，Discover 只读用户自己加的索引源）。

---

## 1. npm 发布

```bash
npm login
npm publish --access public --tag alpha
```

发布前必须全绿：

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 包自检 | `node scripts/check.mjs` | `check ok: oh-my-coharness@0.4.0-alpha.1 … 5 skills` |
| 打包内容 | `node scripts/pack-check.mjs` | 文件清单符合预期，vendor/omd 与 integration 都在 |
| OMC 回归 | `node test/smoke.test.mjs` | `pass 36` |
| 执行契约 | `node test/integration/contracts.test.mjs` | `pass 14` |
| Preset/角色 | `node test/integration/preset.test.mjs` | `pass 10` |
| 设置卡 | `node test/integration/client.test.mjs` | `pass 8` |
| 迁移 | `node test/integration/migration.test.mjs` | `pass 9` |
| 真实冒烟 | `node scripts/live-check.mjs` | `live check ok`（两个不同 Harness、只读、工作区不变） |
| 版本号 | 手工 | `package.json`、客户端 `VERSION`、CHANGELOG 顶部一致 |
| 仓库地址 | 手工 | `repository.url` 换成真实地址，不要留 `<owner>` |

`package.json` 的发布契约（已就位，改动需谨慎）：

```json
"main": "./src/entry.js",
"exports": {
  ".": "./src/entry.js",
  "./preset": "./vendor/omd/npm-package/preset/preset.js",
  "./client": "./vendor/omd/npm-package/client/client.js"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true }
},
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0", "node": ">=20" }
```

- `dsh.bundle.patch` 是「能装」的唯一开关；没有它，包只是普通依赖。
- `dsh.client` 是设置卡的唯一入口；`./client` export 必须指向实际 bundle，`clientModules` 从它解析。
- `engines.dsh` 写**测过的下界**，不写 `*`。升级宿主后先跑隔离 profile，再放宽。
- `dsh-plugin` 这个 keyword 必须保留（部分索引用它检索）。
- `vendor/` 必须进 `files`；否则源码导入的 Preset 不会随包发布。

### 发布说明要点（0.4.0-alpha.1）

发布说明必须写清这几句，否则用户会把边界当成能力：

1. **合并，不是新增第二个插件**：OMD 的角色/Council/设置卡已经进入 `oh-my-coharness`；不要再同时安装 `oh-my-dsh-slim`。
2. **一个默认 Preset**：`Oh My CoHarness`；旧会话绑定的 `oh-my-dsh-slim` / `omc-harness` 不能恢复原组合，需要新建会话。
3. **角色可切后端**：Oracle / Explorer / Council 席位支持 native 或外部 CLI；Fixer / Designer / Librarian / Observer / Council Synthesizer 本版保持 native。
4. **外部角色只读且一次性**：`omc:*` Provider 固定只读；advisory-only CLI 默认拒绝，需显式 `allowAdvisory`。
5. **写路径**：只有 `coharness({mode:'in-place'})`，走 `surface: direct`——没有 `childId`、没有宿主容量、没有子会话面板。
6. **迁移**：`/coharness migrate` 预览 → `--apply` → 卸载 OMD → 重启；备份与 `--rollback` 已实现。
7. **未验证项**：发布说明必须链接 `docs/INTEGRATION-ACCEPTANCE.md`，不要让用户以为 Desktop + WSL 已完整验收。

## 2. awesome-dsh-plugin（英文主索引）

该列表本身就是一个 format-1 索引，用户在 Discover 里添加
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 即可看到全部条目。

提 PR 时，在合适的分类下加一行（分类建议 **Workflow & Automation**）：

```markdown
- [PengYangchao0808/oh-my-coharness](https://github.com/PengYangchao0808/oh-my-coharness) - One agent preset with an orchestrator and specialist roles (Oracle, Explorer, Fixer, Designer, Librarian, Council). Each role runs natively in DSH or on an installed coding CLI (Codex, Gemini, Antigravity, opencode, Kimi, Claude Code) with enforced-or-advisory read-only levels, capability checks, and a reversible configuration migration.
```

评审会做的事（所以描述必须可核对）：能 `dsh plugin add` 装上、描述与实际行为一致、
分类正确、仓库仍在维护。**认证检查**：不要写「支持 9 个 agent」这种无法核对的话，
写「已实测 opencode 2.1.4 / codex 0.165.0 / kimi 2.4.0 / antigravity 1.4.10；其余按同一形态支持」，并在 README 里给出矩阵。

仓库还需要：

- GitHub topic `dsh-plugin`
- README 第一段就能看出「装完会发生什么」
- LICENSE + THIRD_PARTY_NOTICES（MIT，已就位）

## 3. dshbase（中文生态）

在其插件目录页提交，接受后它会跑一次安装实测（`dsh plugin add` + 启动）再给「已验证」徽章。
提交材料：包名、仓库地址、一句话中文描述、分类（Developer）。

中文一句话建议：

> 一个 Agent Preset：Orchestrator 带着 Oracle / Explorer / Fixer / Designer / Librarian / Council 专业角色，角色可以选择 DSH 原生或你已安装的 AI 编程 CLI（只读、可切换），并自带设置卡与可回滚配置迁移。

## 4. 可选：进 dsh-market

`dshmarket` 是装进 DSH 内部的市场 UI，自带目录。收录通常跟着 awesome 列表走，
所以先完成第 2 步。

## 5. 发布后自检（用户视角）

在一台**没有**装过本插件的机器/新 profile 上：

1. Plugins 界面搜索 `oh-my-coharness` → 安装 → 重启 DSH。
2. `/coharness doctor` → 应看到：`preset: oh-my-coharness`、providers、每个角色的执行后端；没有 `legacy preset`。
3. 设置 → Oh My CoHarness → 能看到 10 个角色行与执行后端选择；Harness 下拉显示只读等级。
4. 装一个 CLI（如 `npm i -g @anthropic-ai/claude-code`，或已在 WSL 的 opencode）→ doctor 变 `usable`。
5. 把 Oracle 切成 Codex，新建会话，让它读 README 并给三条建议 → Codex 输出里出现角色首行。
6. 卸载 → 工具、Provider、Preset 与设置页消失，profile 只剩别的插件。

第 6 步特别重要：**卸载只删自己的行，不碰用户的 CLI 与认证。**
