# 发布与收录清单

v0.1 的发布物只有**一个 npm 包**。市场收录是另外两步，不能靠 `npm publish` 自动发生
（DSH 没有官方索引，Discover 只读用户自己加的索引源）。

---

## 1. npm 发布

```bash
npm login
npm publish --access public
```

发布前必须全绿：

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 包自检 | `node scripts/check.mjs` | `check ok: oh-my-coharness@x.y.z` |
| 打包内容 | `node scripts/pack-check.mjs` | 文件清单符合预期，无多余无缺失 |
| 单测 | `node test/smoke.test.mjs` | `pass 16` 及以上 |
| 版本号 | 手工 | `package.json` 与 CHANGELOG 顶部一致 |
| 仓库地址 | 手工 | `repository.url` 换成真实地址，不要留 `<owner>` |

`package.json` 的发布契约（已就位，改动需谨慎）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0", "node": ">=20" },
"keywords": ["dsh", "dsh-plugin", "deepseek-harness", "coharness", ...]
```

- `dsh.bundle.patch` 是「能装」的唯一开关；没有它，包只是普通依赖。
- `engines.dsh` 写**测过的下界**，不写 `*`。升级宿主后先在 CI 跑，再放宽。
- `dsh-plugin` 这个 keyword 必须保留（部分索引用它检索）。
- **不要加 `dsh.client`**：v0.1 是 Host-only，多一个客户端半会把 Web UI 卷进来。

## 2. awesome-dsh-plugin（英文主索引）

该列表本身就是一个 format-1 索引，用户在 Discover 里添加
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 即可看到全部条目。

提 PR 时，在合适的分类下加一行（分类建议 **Tools & Capabilities** 或 **Workflow & Automation**）：

```markdown
- [PengYangchao0808/oh-my-coharness](https://github.com/PengYangchao0808/oh-my-coharness) - Finds the AI coding CLIs already installed on the machine (including inside WSL), registers each as a real DSH subagent provider, and dispatches self-contained tasks to them with honest timeouts, capacity limits and diagnostics.
```

评审会做的事（所以描述必须可核对）：能 `dsh plugin add` 装上、描述与实际行为一致、
分类正确、仓库仍在维护。**认证检查**：不要写「支持 9 个 agent」这种无法核对的话，
写「已实测 opencode 2.1.4；其余按同一形态支持」，并在 README 里给出矩阵。

仓库还需要：

- GitHub topic `dsh-plugin`
- README 第一段就能看出「装完会发生什么」
- LICENSE（MIT，已就位）

## 3. dshbase（中文生态）

在其插件目录页提交，接受后它会跑一次安装实测（`dsh plugin add` + 启动）再给「已验证」徽章。
提交材料：包名、仓库地址、一句话中文描述、分类（Developer）。

中文一句话建议：

> 装一次就能发现本机（含 WSL）的 AI 编程 CLI，并把每个都注册成 DSH 原生子 Agent 来派发任务，失败时给出可复制的诊断报告。

## 4. 可选：进 dsh-market

`dshmarket` 是装进 DSH 内部的市场 UI，自带目录。收录通常跟着 awesome 列表走，
所以先完成第 2 步。

## 5. 发布后自检（用户视角）

在一台**没有**装过本插件的机器/新 profile 上：

1. Plugins 界面搜索 `oh-my-coharness` → 安装 → 重启 DSH。
2. `/coharness doctor` → 应看到所有 CLI 的真实状态，而不是崩溃。
3. 装一个 CLI（如 `npm i -g @anthropic-ai/claude-code`，或已在 WSL 的 opencode）→ doctor 变 `usable`。
4. 让它读一个文件并总结 → 结果里有真实内容。
5. 卸载 → 工具与 Skill 消失，profile 只剩别的插件。

第 5 步特别重要：**卸载只删自己的行，不碰用户的 CLI 与认证。**
