# 原生多模型 Demo：在 OMC 上快速复用 DSH 已可调用的模型

日期：2026-11-02（Asia/Shanghai）。状态：Unreleased，包版本仍为 `0.5.0-alpha.1`。

这份文档只讲一件事：**不接外部 CLI、不新增模型 Provider，用 DSH 已经能调用的模型，把 OMC 的专业角色真正跑一遍。**

外部 Harness（Codex / Claude / Kimi …）不在本 demo 范围内。多 Harness 协同是下一阶段，见 [OMO-SLIM 差异与顺序](OMO-SLIM-PARITY.zh-CN.md) 与 [Oh-My-Pi 参考方案](OH-MY-PI-REFERENCE.zh-CN.md)。

---

## 1. 为什么先做这一层

OMC 现在有两层能力，成熟度不同：

| 层 | 由谁执行 | 现状 |
|---|---|---|
| Native 角色层 | DSH 子 Agent / 模型 / 权限 / 会话 | 继承 OMD-Slim，已经可用 |
| 外部 Harness 层 | `omc:<id>` → CLI | Alpha；只有 Codex 过了真实两轮续接 |

“尽快可用”的路径只能走第一层。用户环境里其实已经有一套可用的角色模型映射（OMD-Slim 的 `my-dsh-normal`），缺的不是模型，而是：

1. 把这些模型**映射到 OMC 的角色**；
2. 让人能看见每个角色**实际**会调用哪个 provider/model；
3. 有一份**可复现**的任务，证明分工、执行、验证真的发生了。

本批补的就是这三点。

---

## 2. 三条命令

> 插件代码改动后需要重启 DSH；每个宿主进程只加载一次插件。

### 2.1 预览：现在会怎么分配

```text
/coharness fleet
```

不调模型、不写配置。它会：

- 读实时 DSH 模型目录（`ctx.llm.listProviders()` + `listModels()`）；
- 如果 `oh-my-dsh-slim` 仍挂载，读取它当前选中的角色配置，**完整的 provider/model 对优先继承**；
- 其余角色按“角色关键词 + 目录顺序”分配，尽量不重复；
- 输出每个角色的 `provider/model` 和匹配理由。

### 2.2 应用：只改路由，不动工具

```text
/coharness fleet --apply
```

写入当前 DSH profile 的 OMC 设置：

- 只合并 `roles.<id>.provider / model / execution`；
- 保留该角色原有的 `tools / deny / mcps / personaAppend / temperature`；
- 写入前备份到 `~/.dsh/coharness-backups/fleet-<timestamp>.json`（POSIX 下 `0600`；只含配置，不含 prompt 或 CLI 凭据）；
- 写完后重新读取配置并逐角色核对；不一致会打印 `verify:` 行。

也可以直接从模型工具调用：

```js
coharness({
  action: "fleet",
  apply: true,
  models: {
    oracle: { provider: "zai-coding-cn", model: "glm-5.3" },
    explorer: { provider: "opencode-go", model: "deepseek-v4.1-flash" }
  }
})
```

`models` 里的角色优先于 OMD 继承，也优先于自动匹配。

### 2.3 一键准备 demo

```text
/coharness demo
```

等价于“应用 fleet + 生成工作区 + 打印 prompt”。如果只想生成工作区、不写配置：

```text
/coharness demo --preview
```

工作区默认在：

```text
~/.dsh/omc-demo/run-<timestamp>/
```

里面包含：

| 文件 | 作用 |
|---|---|
| `inventory.mjs` | 有一个 off-by-one：`totalValue` 少算最后一行 |
| `inventory.test.mjs` | 三条 `node:test`：总计、低库存、空购物车 |
| `TASK.md` | 症状、要求、验收、角色分工 |
| `RUN.md` | 记录绝对 Node 路径的测试命令 |
| `.omc-demo.json` | demo 版本、时间、Node 路径 |

---

## 3. 跑起来

1. 新建一个会话，Agent preset 选择 **Oh My CoHarness**（当前会话如果已经用它，直接继续）。
2. 把 `/coharness demo` 输出的 `--- prompt ---` 整段粘贴进去。
3. 观察主控是否按顺序调用：
   - `subagent_explorer`：只读定位 `items.length - 1`；
   - `subagent_oracle`：只读评审最小修复与回归风险；
   - `subagent_fixer`：只改 `inventory.mjs`；
   - 主控运行 `"<绝对 node 路径>" --test inventory.test.mjs`；
   - 再用 `subagent_oracle` 复核 diff（同一 child 用 `send_message` 继续）。
4. 结束后运行：

```text
/coharness status
```

应该看到类似：

```text
oracle             on  native  native · zai-coding-cn/glm-5.3
explorer           on  native  native · opencode-go/deepseek-v4.1-flash
fixer              on  native  native · opencode-go/deepseek-v4-flash
designer           on  native  native · xiaomi-token-plan-cn/mimo-v2.6-pro
librarian          on  native  native · opencode-go/deepseek-v4-flash
```

具体路由取决于本机目录与 OMD 配置，不是出厂默认值。

---

## 4. 本机示例：继承 OMD-Slim `my-dsh-normal`

本机 OMD-Slim 的 `my-dsh-normal` 已经配置了：

| 角色 | provider / model |
|---|---|
| oracle | `zai-coding-cn / glm-5.3` |
| designer | `xiaomi-token-plan-cn / mimo-v2.6-pro` |
| fixer | `opencode-go / deepseek-v4-flash` |
| explorer | `opencode-go / deepseek-v4.1-flash` |
| librarian | `opencode-go / deepseek-v4-flash` |
| councillor-alpha | `zai-coding-cn / glm-5.3` |

`fleet` 会优先搬这一套；`councillor-beta / gamma` 在 OMD 里没有完整 provider/model，会按实时目录补。`observer` 仍被锁定。

这份表是“本机现场”，不是产品默认值。发布物不预置用户环境不存在的模型 ID。

---

## 5. 它证明了什么，没证明什么

**证明了：**

- 角色工具确实挂载并接受任务；
- 每个角色确实钉到了不同的 DSH provider/model；
- Fixer 的写入发生在 DSH 权限体系内；
- 测试退出码是真实执行结果，不是模型自述；
- `status` 能把“配置里的路由”和“目录里是否存在”分开显示。

**没证明：**

- 外部 Harness 可用；本 demo 不调用任何 CLI；
- 多 Harness 同时协同；
- 主控一定按推荐顺序委派——这取决于主控模型；如果它跳过角色，demo 只能如实报告；
- 结构化结果契约、验收门禁、失败重试、worktree 隔离；
- 所有模型都能完成工具调用（目录里有模型 ≠ 该模型支持工具调用；失败时角色工具会如实报错）。

---

## 6. 验证记录

本批自动化与宿主检查：

| 检查 | 结果 | 范围 |
|---|---|---|
| `node test/integration/fleet.test.mjs` | 14 pass | 目录归一化、角色分配、OMD 继承、显式覆盖、apply 合并、status、demo 种子 |
| 全量测试（27 个文件） | 268 pass / 0 fail | 无回归 |
| `scripts/host-live-check.cjs --external` | PASS | 隔离宿主挂载 OMC preset、9 个工具、`modelCalls: 0` |
| `.ops/fleet-live-check.cjs` | PASS | 真实宿主内执行 `fleet` / `demo` / `graph` / `mailbox` action，`modelCalls: 0` |
| 真实模型调用 | 本批未执行 | 需要本机账号与配额；prompt 由用户在自己的会话里执行 |

机读摘要见 [evidence/2026-11-02-durable-orchestration.json](evidence/2026-11-02-durable-orchestration.json)。目录探测使用隔离 DSH home 中的**合成测试凭据引用**，没有读取或复制真实密钥；它只验证 `listProviders/listModels`，没有发送模型请求。

本批没有把“目录能读出来”写成“模型一定能回答”，也没有把“prompt 已生成”写成“demo 已跑通”。真实模型侧的通过标准是：三条测试通过 + `status` 显示预期路由 + 报告里能给出 Explorer/Oracle/Fixer 的实际输出。

---

## 7. 已知限制与下一步

1. **`fleet` 只做静态分配，不做能力评分。** 关键词匹配能给出可解释的起点，但不等于模型在具体任务上的表现；需要显式覆盖时用 `models`。
2. **目录为空不等于没有模型。** `dsh-llm-pi-ai` 在缺少凭据时 `listModels` 会返回空数组；此时 `fleet` 会明确说“role stays on the session model”，不会编一个模型名。
3. **`apply` 不热切换已运行的子 Agent。** 新的委派会读到新路由；已经创建的孩子保持原配置。
4. **demo 不自动运行。** 当前是“生成工作区 + prompt”，由用户在当前会话执行；自动创建并驱动一个 demo Agent 是下一批（需要结果契约和超时/取消语义）。
5. **没有 per-child worktree。** `coharness worktree` 是 session-wide checkout；demo 只有一个写入者（Fixer）。
6. **设置写回依赖宿主的 settings 服务。** 没有该服务时回落到 `~/.dsh/oh-my-coharness.json`；两种路径都会先备份。

下一批的顺序见 [Oh-My-Pi 参考方案](OH-MY-PI-REFERENCE.zh-CN.md)：先做结果契约与生命周期，再做任务图/写入隔离，最后才恢复多 Harness。
