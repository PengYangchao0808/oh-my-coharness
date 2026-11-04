# 当前 OMC / OMD 与 OMO-SLIM 的差距复核

> **2026-11-03 路线修订**：本文保留为**历史差距证据**。按 [OMC-0X-CLOSEOUT.md](OMC-0X-CLOSEOUT.md)，0.X 的目标是**核心行为兼容**（角色、路由、工作流、正确性），**不再追求完整 OMO-Slim 生态复刻**；Observer、Companion、ACP/App-server、视觉增强等边缘能力移出 0.X 关键路径（归 1.X 或可选功能）。本文中的"完整能力覆盖差距"不再作为 0.X 的阻断项。

日期：2026-11-03。本地对象：OMC `0.5.0-alpha.1` 工作区，整合 OMD `0.8.6`，包含未发布 alpha.2 基础改动。这里不是独立安装的 OMD 最新版测评。

上游对象：查询时 OMO-SLIM master 的官方 README、package.json 和功能文档，package 声明 `3.0.6`。master 内容不等同于此前固定 commit 的快照；本次没有安装运行上游，也没有进行同任务性能对照。[上游版本声明](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/package.json)

## 1. 结论

核心专业角色和原生多模型分工已具备，能够进行实际协作；完整能力覆盖仍有明显差距。成本/状态/工作包/离线评估方向增加了本地基础，但原生自动接线、实际预算执行、设置卡和真实评估仍未闭环。不能将模块数量或回归通过数解释为已达到完整替代或效率领先。

不使用整体完成百分比：功能、适配范围和真实验收的权重不同，简单相加会误导。

## 2. 当前差异矩阵

| 维度 | 本地当前状态 | 与上游对齐仍需要的工作 |
|---|---|---|
| 专业角色与多模型分工 | Orchestrator、Explorer、Oracle、Fixer、Designer、Librarian/Council；配置模型与实际路由记录 | 核心思路接近；实际路由质量、角色工具全链及混合 Council 仍需任务集/Desktop 验收 |
| 原生后台生命周期 | DSH 提供原生 child、完成通知、send_message；已有真实使用记录 | 将原生 role 与 OMC graph、usage ledger、acceptance、预算自动绑定；不能只覆盖显式 external dispatch |
| 会话复用与任务继续 | native 可续接；Codex 外部两轮有既有证据；managed reuse 基础 | 模块负责人/选择器/原生 worker registry 尚未实现；续接与重开效果没有对照证据 |
| 外部 Agent 协议 | CLI start/resume、显式 fallback、Codex 已验证 | OMO-SLIM 有 ACP wrapper 与进度接入；本地未实现通用 ACP/app-server。标准协议是缺口，但并不等于上游外部会话一定更持久 |
| 项目定制与新角色 | 项目限制、自定义 external read-only 模板 | 缺统一的项目级 native 角色、prompt/skills/MCP 绑定与多层继承体验 |
| 当前会话 preset | 本地有 first-observation 基线、manual 快照、差异和实际模型记录 | OpenCode v2 的 `/preset` 支持当前会话子代理推理设置绑定；本地 DSH 整体 preset 首轮锁定，等价范围需明确设计 |
| 长任务与并行写入 | graph、WorkPacket、Artifact、ULW/verify 流程、外部 worktree/显式 merge | 尚缺 Deepwork 完整阶段执行/恢复；native child cwd 到独立工作树的接线和集成验收未完成 |
| 视觉、代码工具及交互生态 | 主要沿用 DSH 工具；Observer 未完成附件/模型链路 | Observer、codemap/AST 类增强、Interview/Implement、Companion、multiplexer、原生自定义 agent 生态仍有明显缺口 |
| 成本和上下文治理 | 四桶 ledger、budget/progress、短回显与检索缓存已有模块 | 原生实时入账与发送闸门未完整接入；reservation 仍有进程内边界；核心历史视图缩减未启用，真实缓存费用未对账 |
| 评估与反馈 | 本地三策略离线分配、汇总、不确定性和有限 review 基础 | collector、隔离运行器、真实 grader、候选生成、灰度/回退未实现；尚无同条件费用/速度/质量领先证据 |

表中是本地代码/证据与上游文档的能力对照，不代表上游每项功能都在本机验证。角色名称与工具入口在不同宿主间不要求一一相同，应按用户行为和验收对齐。

## 3. 上游能力依据与需要修正的旧判断

### 专业分工、预设和扩展生态

官方 README 描述专业代理、后台协调、Observer、技能、工作树和交互生态；v2 的 preset 动作主要改变当前会话后续子代理的推理设置，不能概括成任意主会话能力全量热切换。[官方功能总览](https://github.com/alvinunreal/oh-my-opencode-slim)

### 项目配置

上游支持项目/祖先目录配置、自定义代理、内置 prompt 覆盖/追加、每角色 skills/MCP 和预设合并。本地项目策略收紧与外部模板只覆盖其中一部分。[项目定制文档](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/project-local-customization.md)

### ACP 不能与会话复用画等号

官方 ACP 文档描述 wrapper 调用、模型选择、权限与更新流，同时明确每次调用启动独立 ACP 子进程/session，没有记住上次内部模型选择。不能据此说上游 ACP 天然复用更高或支持任意外部运行中的实时追加。本地当前缺的是这一标准接入路径，不是所有 CLI 能力都完全缺失。[ACP 文档](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/acp-agents.md)

### 上游已经有评估、反思与效率工作

- Developer Evals 包含源代码工作区里的路由/可靠性轨迹采集、离线评分和辅助模型判断。文档限定其不证明实现正确性，不作 v2 或跨模型性能宣称；实时部分需要兼容的 OpenCode v1 环境。[Evals](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/evals.md)
- `reflect` 根据近期会话和重复工作摩擦建议 skills、代理、命令、配置或流程改进，不等于持续自动训练或在线策略自动发布。[Reflect](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/skills/reflect/SKILL.md)
- Runtime Efficiency 包括合并配置缓存、请求局部事实、按需实现加载和事件写入/投影优化；文档明确操作计数和字节数不是 CPU、内存或端到端提速基准。[Runtime Efficiency](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/runtime-efficiency.md)

因此，之前将“评估/反思/效率优化”笼统视作本地将超出原版的判断需要收窄。本地三策略公平对照、全父任务成本和晋升约束是具体开发方向，尚不是已证明的独有优势或实际领先。

## 4. 本地证据能说明什么

当前 WP00–WP07 多项标记 implemented，同时保留了原生接线、自动停止和真实缓存对账边界；WP08/WP09 未完成。反馈 F01 为 implemented-offline，F02–F05 未完成。

上轮本地记录有 34 个测试文件、336 项通过，其中离线策略评估新增 14 项；这是代码与契约证据，不能代替 Desktop 或真实性能。[反馈工具检查记录](evidence/2026-11-03-feedback-eval.json)

已修复的项目策略、结构化输出和快照问题有组合回归，不能继续原样列为“完全未修”；其更广边界仍保留在证据中。[WP01](evidence/alpha.2/acceptance-A01-A04.json)

原生 graph 接线、budget 自动执行、真实费用对账分别见 [WP05](evidence/alpha.2/acceptance-A11-A16.json)、[WP06](evidence/alpha.2/acceptance-A17-A20.json)、[WP07](evidence/alpha.2/acceptance-A21-A22.json)。没有 native-runtime、worker-registry/session-strategy、trial-collector、独立 acceptance-runner 或 policy rollout 的实际接入，不应把计划当成已完成功能。

## 5. 差距大小与下一步

- **核心角色与分工：差距较小。** 基本能力已有真实使用，重点是路由质量和结果整合。
- **统一协作与长任务闭环：差距仍明显。** 接通已有模块比继续增加平行模块更重要。
- **完整产品生态：差距较大。** 视觉、项目定制、长任务恢复、标准外部协议和交互功能不能被效率研究替代。
- **效率与准确率：目前无法排名。** 缺少相同任务、模型、预算和验收条件的对照。

先按 [R00–R03](NEXT-PRACTICE.zh-CN.md) 补真实接线与执行，再做 R04–R08 的选择器和对照；其后单列 OMO-SLIM 功能补齐路线。完成 alpha.2 也不自动等于完整复刻结束。
