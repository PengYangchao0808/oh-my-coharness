# OMC 下一步实践方案：从基础模块到可验证的协作优化

制定日期：2026-11-03。适用工作区：Oh-My-CoHarness。

> **进度（2026-11-03，practice.1）：R00 与 R01 已完成，R02 是下一步。**
> - R00：[分层基线](evidence/alpha.2/practice-baseline.json)（由 `scripts/practice-baseline.mjs` 生成，须先跑 `scripts/run-tests.mjs`）；实现/测试/宿主探针/真实模型/Desktop/费用覆盖分开统计，任何 claimed pass 的产物缺失即降级为 `unverified`。
> - R01：[`integration/native-runtime.js`](../integration/native-runtime.js) + [11 项组合回归](../test/integration/native-runtime.test.mjs) + [无模型宿主探针](evidence/alpha.2/practice-r01-native-runtime.json)：真实宿主中主控/child/嵌套 child 关联到同一父任务，重放不重复计费，`turn/end` 只结算执行状态。
> - 仍未完成：真实计费模型链路、Desktop 点击、取消(aborted)的宿主级证据、R02 的逐请求闸门与跨进程预留。alpha.2 发布闸门**未**通过。
>
> 当前包版本：`0.5.0-alpha.2-practice.1`（实践增量，不是 alpha.2 发布版本）。本文其余部分仍是对 R02–R10 的原始方案。
> **R02–R10 的可开工执行方案**见 [R02–R10 执行方案](plans/r02-r10.execution-plan.zh-CN.md)：逐项落点、步骤、证据文件、验证命令与依赖闸门。

配套：[可跟踪实践清单](plans/next-practice.backlog.json) · [alpha.2 设计](V0.5-ALPHA2-PLAN.zh-CN.md) · [验收规格](ACCEPTANCE-V0.5-ALPHA2.zh-CN.md) · [反馈与进化设计](FEEDBACK-EVOLUTION.zh-CN.md)。

## 1. 下一阶段的交付定义

先交付一个可核算、可继续、可停止、可验收的最小协作系统，再比较不同会话策略。具体顺序：

**确认基线 → 接通原生事件与任务身份 → 接通真实预算执行 → 会话策略选择 → 监控与独立验收 → 三组真实对照 → 发布 alpha.2 → 有边界的自主改进。**

完成 alpha.2 后可以承诺“在已验证路径上提供协作与效率治理”。是否优于 OMO-SLIM、是否更省更快，分别依功能验收和同条件对照决定，不作为预设结论。

## 2. 现状：哪些保留，哪些继续做

以下依据当前代码与已有 evidence，不能将整个 `implemented` 工作包理解为所有真实链路均已通过。

| 领域 | 已有基础 | 下一步实际缺口 |
|---|---|---|
| 项目策略、解析、快照 | WP01 修复代码及组合回归 | 保留回归；验证新入口没有绕过最终限制 |
| 用量与执行事件 | usage-ledger、execution-events、原生事件纯映射器 | 原生实时归集、父子身份绑定和全请求覆盖 |
| 工作包与产物 | WorkPacket、Artifact、短回显和检索缓存模块 | 与真实角色派发、取回及状态变化接通 |
| 工作图与通信 | 带 node_id 的外部 dispatch、mailbox 注入/恢复基础 | 原生角色自动 claim/settle、真实完成与验收解锁 |
| 预算与进展 | checkpoint、无进展解释、进程内 reservation Map | 逐请求执行闸门、跨进程并发预留、安全停止与恢复 |
| 缓存 | 会话身份探针和安装版 adapter 检查 | 动态发送头能力及真实 usage/费用验证；当前没有协议可以直接宣称已完成缓存优化 |
| 设置卡 | 旧 Runtime tab 和模型配置 | efficiency 模式、能力覆盖、四桶用量和可继续任务的准确展示 |
| 三策略评估 | 离线随机分配、汇总、不确定性和 review 工具 | 真实 collector、隔离运行器、独立 grader、真实对照 |
| 自动优化 | F00–F01 协议与离线基础 | F02–F05 的采集、候选、灰度和回退控制器 |

参考证据：[WP02–03](evidence/alpha.2/acceptance-A05-A10.json)、[WP05](evidence/alpha.2/acceptance-A11-A16.json)、[WP06](evidence/alpha.2/acceptance-A17-A20.json)、[缓存边界](evidence/alpha.2/acceptance-A21-A22.json)、[离线评估检查](evidence/2026-11-03-feedback-eval.json)。

特别注意：当前预算 reservation 保存在 tracker 的进程内 Map。即使 ledger 有文件锁，也不能据此宣称两个进程对最后一个调用名额实现了原子互斥；必须补充专门实现和并发证据。

## 3. 工作包与建议修改顺序

R 编号表示本轮整理的**剩余实践任务**，不覆盖原 WP/F 编号或把历史工作重置。每项应独立成一组可审阅修改；相邻任务共改 index/provider/config 时由单一集成人处理。

| ID | 实践任务 | 对应旧计划 | 前置 | 优先级 |
|---|---|---|---|---|
| R00 | 固定基线和验收状态 | WP00、WP09 | 无 | P0 |
| R01 | 原生事件桥与身份归集 | WP02、WP05、F02 | R00 | P0 |
| R02 | 请求预算真正执行与恢复 | WP06 | R01 | P0 |
| R03 | 角色派发、消息和验收闭环 | WP03–05 | R01、R02 | P0 |
| R04 | 会话选择器和可轮换负责人 | 会话复用、F02 | R03 | P1 |
| R05 | 监控、设置卡与能力诊断 | WP08 | R01、R02、R03 | P1 |
| R06 | 三策略 collector 与隔离运行器 | F02、WP09 | R03、R04 | P1 |
| R07 | 独立 grader 和分层任务集 | F03 | R06 | P1 |
| R08 | 真实三组实验与缓存对账 | WP07、WP09、F03 | R05、R06、R07 | P1 |
| R09 | alpha.2 产品验收与发布准备 | WP08–09 | R08 | P1 |
| R10 | 有限候选、灰度和自动回退 | F04–05，后续版本 | R09 | P2 |

### R00：固定现状，避免在旧结论上继续开发

修改重点：版本证据索引、工作包状态、测试与兼容清单。

- 记录当前 commit 和未提交工作树指纹，保留已有修改，不重做 WP01–07 模块。
- 将状态拆为“代码实现、组合测试、宿主探针、真实模型、Desktop、费用覆盖”，分别写 passed/partial/not-run/blocked。
- 重新检查必要基线。已有 34 个文件/336 项通过是上一轮工作树的记录，不代替未来改动后的结果。
- 将缓存 A21 的身份可用与 A22 的真实费用验证分开；CI 的 DSH runtime smoke 仍是 placeholder，不能算宿主已测。

验收：能用一张表指出每个发布能力由哪个产物证明，未验证项不被汇总为通过。输出建议为 `docs/evidence/alpha.2/practice-baseline.json`。

### R01：让原生 child 真正进入同一套任务和用量记录

优先阅读/修改：`src/index.js`、`integration/usage-ledger.js`、`integration/execution-events.js`、`vendor/omd/npm-package/preset/subagent-roles.js`、`role-composition.js`。建议新增 `integration/native-runtime.js`，避免把所有逻辑塞进角色提示或 index。

需要完成：

1. 在父任务派发时建立 rootTask/trial、node、child、executionAttempt 的关联，包含嵌套子任务。
2. 通过宿主受支持事件/服务接入 request、usage、terminal、cancel；不以读取并改写磁盘会话文件作为实时控制方案。
3. 记录实际 provider/model/effort，区分配置路由、创建元数据与实际请求。失败请求缺 usage 时继续入账为未知，不能丢失。
4. 以来源 session + event 标识幂等归集，父任务汇总不再次记成自己的调用。重启回放使用相同来源标识。
5. 对作用域、profile、父任务授权、监听器重复安装和卸载做检查；不要接管其他插件或其他父任务。

验收：至少两个原生 child、一次重试和一次取消都能关联到正确父任务；重复事件和重启不增加费用；模型切换后显示真实路由。覆盖 A05/A06/A08/A13。

### R02：从“给出停止建议”变为“阻止下一次实际请求”

主要落点：`integration/budget.js`、`integration/file-lock.js`、R01 的事件桥、`src/provider.js`/`src/dispatch.js` 的可控边界。

先区分三类 ID：

- executionAttemptId：一次任务执行/续派；其中可能有很多模型调用。
- modelRequestId：每一次真实模型发送尝试，包含重试。
- sourceEventId：返回事件身份，用于入账去重。

不能用 executionAttemptId 当作所有模型请求共用的预留键。

在原生发送闸门处实现“锁内核对已结算/在途 → 预留 → 允许发送 → 用真实事件结算”。多进程共享预留状态；请求可能已发送但结果未知时，不盲目退还名额。恢复时与宿主/收据对账，保留 unknown。

达到预算：持久化检查点，在合法调用边界拒绝后续发送，仍在运行的工具按宿主契约处理；不把 stop-partial 变成完成。明确父任务总预算与子任务分配，主控和辅助请求也计入。

外部 CLI 只能控制 dispatch 之间的边界，不能承诺控制其内部每一轮。直接运行路径也按其实际能力标记。费用存在延迟、缺失和在途消耗，不能承诺严格账单封顶。

验收：两个独立进程竞争最后一个名额时只有一个成功；重试计数；拒绝后没有适配器发送；取消/重启不丢记录；外部未知能力不被标成硬限制。扩展 A17/A18，不能仅重复进程内 Map 测试。

### R03：连接角色派发、工作包、消息和验收

主要落点：`integration/managed-execution.js`、`graph.js`、`mailbox.js`、`work-packet.js`、`artifact-store.js`、`vendor/omd/npm-package/preset/roles.js`。

统一入口顺序：

`解析实际 cwd/最终策略 → 校验工作包 → claim/预留 → 持久化待注入上下文 → 激活并在首请求前完成注入 → 接收事件 → 执行结算 → 独立验收 → 解锁后继/释放`。

- 对原生角色补 task/node 绑定，保留旧显式入口并标为 unmanaged，不假装所有写入均被覆盖。
- 工作包超限外置材料或拒绝，不删掉权限、预算和验收要求。事实带来源和工作树指纹。
- 消息写入可恢复的接收上下文后再确认，崩溃重试不重复注入。queued/delivered/consumed 保持不同语义。
- 后台启动返回 ID 不能提前 settle；外部 managed 批次必须逐项关联结果，不能以第一个结果代表全部。若当前契约一次只支持一个节点，则显式拒绝多任务混入该节点。
- 执行完成与验收通过分开；当前集成树通过验收后才解锁要求通过的后继。旧 attempt 的验收不能带到新要求。
- 同工作树先坚持单活动 writer；scope claim 是协作约束，不替代实际文件权限。

验收：原生 Explorer → Fixer → 验证和外部 Codex → 原生 Fixer 各走通一次；包含激活失败、消息注入中断、取消和重复结算。覆盖 A09–A16/A25。

### R04：建立会话选择器，避免把“固定代理”当作唯一答案

新增建议：`integration/worker-registry.js`、`integration/session-strategy.js`、决策记录。外部 CLI 的 `integration/sessions.js` 保持原语义，不用它冒充原生 child registry。

固定的是模块责任与逻辑 worker；物理 child 可以轮换。记录 project、module、role、实际模型/端点/环境、权限、workspace、childId、generation、健康/忙闲、上下文、来源基线和最后验收。

源代码正常变化不应让每次都产生完全不同的 worker key；应核对当前变化与来源、更新工作包，再决定继续或重开。权限/模型/工作区不匹配、失败不明或旧事实失效时不得直接续接。

初始选择使用可解释规则，不增加一次模型调用做路由：

| 场景 | 候选动作 |
|---|---|
| 同模块后续修正，约束和状态匹配 | resume |
| 适合续接但 child 正忙 | queue，而非给同一会话并行塞两个任务 |
| 内容过长且有已验证的缩减能力 | compact；记录冷启动与摘要成本 |
| 失败假设、过期事实或方向改变 | restart，携带可靠交接 |
| 独立模块或独立审查 | 新工作包/新会话 |

宿主核心历史视图目前仍有限制。没有合法压缩接口时，不伪造 compact；可以短工作包重开并记录为 restart。只对自有回显和产物视图进行已验证的缩减。

每个选择记录“当时可见特征、可选动作、选择、实际动作、规则版本、理由、后续结果”。不以续接率最大化评分。验收包含相关修正续接、独立审查新建、过期/忙碌/模型变更拒绝或排队及压缩不可用回退。

### R05：让设置和监控能解释真实运行

主要落点：`src/config.js`、统一 `config-settings.js`、`client/client.js`、locale、status/doctor。

- 升级仍默认 observe；balanced 只在支持路径启用，缺能力明确说明。
- 显示累计保留、运行中、空闲可继续、已结束和异常；“20 个 child”不能显示成“20 个正在执行”。
- 分开新输入、缓存读/写、输出、请求数、已结算费用、在途与未知覆盖。
- 显示配置路由和实际路由、策略版本、最近检查点、停止原因、消息状态及验收状态。
- DSH 自带子代理菜单不由 OMC 通过 DOM 补丁改写；先在 OMC 自己的 Runtime/诊断视图展示，宿主扩展接口另行验证。
- 检查 observe 是否确实仅观察；不能因为某个模块被实例化就无条件改变旧任务的回显、模型或上下文。

验收：保存/重载、并发编辑、旧配置迁移、模式回退和价格未知均有 Desktop 证据。运行中的旧会话不被静默切模型或策略。覆盖 A07/A23/A29。

### R06：将真实轨迹导出给已有离线评估器

建议新增 `integration/trial-collector.js`、`scripts/strategy-runner.mjs`。后者是待开发文件；现有 `scripts/strategy-eval.mjs` 只分配/汇总，不执行代理。

collector 从 R01/R03 汇总完整父任务，输出与现有评估器兼容的 trial：包括失败/截止/取消、全部 attempts、四桶 usage、费用来源、真实耗时、策略实际执行、人工介入、验收与证据。

运行器负责冻结安排、隔离 worktree/会话/产物、恢复起点、策略执行、截止和收据。任务预算要真正接入 R02/可控超时；manifest 中的 budgetDigest 只是指纹，本身没有执行限制的能力。

策略版本和公共提示固定。模型升级、工具变化、外部网络故障、缓存冷热与人工帮助单独记录；不允许把上一组的答案或修改泄漏给下一组。原始记录只追加/修订留痕，最终每个 trial 汇总一次。

验收：6 个模拟 trial 可验证框架恢复；故意删除/重复一条结果、变更模型或忽略分配时，现有评估器拒绝晋升。历史日志可做 observational 基线，不能事后给它贴随机组标签冒充实验。

### R07：建立不会被执行代理自己改分的验收

建议新增 `integration/acceptance-runner.js`、`test/benchmarks/session-strategies/`，并用独立位置存放冻结验收定义。

- 任务有可复现要求、起始快照、已知基线失败和参考可行解。
- grader 运行固定外部行为测试，检查最终代码/产物指纹，不仅检查 worker 自己新写的测试。
- 编码代理可以新增测试，但不能修改外部验收标准来消除失败。
- 主观质量由明确 rubric 与盲评补充；模型 grader 先经人工样本校准，不作为唯一真值。
- execution、acceptance、关键回归和错误完成声明独立记录。
- 按问题族/项目划分 development/validation/holdout，避免同问题的变体泄漏。

第一版建议覆盖：局部修复、同模块连续修正、跨文件接口、长工具回显、错误假设恢复、独立模块、状态/并发、取消恢复。不要只有“应当复用”的题，也要有“应当重开”的题。

验收：每个任务参考解能通过；故意错误补丁确实失败；同代码不同策略得到同一验收结果；模型自报完成不影响判分。

### R08：分三档开展真实实验

| 档位 | 规模 | 目的 | 不能得出的结论 |
|---|---|---|---|
| 链路冒烟 | 3 个短任务 × 3 策略 × 1 次 = 9 个完整 trial | 检查派发、collector、grader 和费用对账 | 不能宣称策略优劣 |
| 开发筛选 | 12 个任务 × 3 策略 × 2 次 = 72 trial | 找明显浪费、失败与候选规则 | 不能证明质量无损或直接自动晋升 |
| 冻结确认 | 至少 30 个不同任务，每组每任务至少 2 次；按证据需要继续扩大 | 验证冻结候选是否值得推广 | 30 个任务也不是统计充分性的保证 |

trial 数不是模型调用数；一个 trial 可能包含很多 child/请求。每档开始前明确总模型费用、单任务限制、并发、截止和停止规则，由运行器执行，不能自动从冒烟升级为大批付费实验。

A/B/C 定义分别为续接/按需缩减、新建/可靠交接、自适应规则。相同任务和重复编号组成配对区组，随机化组内顺序，隔离写入。第一轮固定模型与并发，后续再研究路由和人数。

同时完成真实缓存桶对账：同 session、重试、恢复、新 child 和启用协议。若只能验证身份而不能验证发送头或真实费用，就继续标 partial；不为提高命中率统一所有 child 的 session ID。

输出包括原始 trial、冻结 manifest、实际版本、总费用和优化费用、成功率/回归/截断、P50/P95、任务级比较及未知项。成本/成功任务包含失败与优化成本；通过数为零时未定义。速度不能只比较成功子集。

使用现有评估器的保守检查：不完整数据阻止推荐；小样本全通过不直接证明非劣。预先声明主比较和门槛，反复查看过的 holdout 不能继续当作新证据。保留不同任务类型的优势，不强制选出一个所有场景通吃的策略。

### R09：完成 alpha.2 的产品和发布验收

完成 A00–A29/G0–G4 对应证据；原生和 Codex 分别覆盖，其他 CLI 保持自己的 verified/unverified 标识。

必须补齐：实际 Desktop 任务流程、取消/超时/父会话关闭、设置保存/回退、真实 tarball 隔离安装和文档同步。当前 CI 的宿主 placeholder 必须在报告中单列；要做真实宿主 CI，应配置适当 runner 和明确的模型预算。

验收后再统一 package 版本、自检固定版本断言、CHANGELOG、支持矩阵与打包文件。发布说明只描述实际支持的路径：外部实时 steer、核心历史压缩、原生多 writer、自定义原生角色等未完成项不被顺带宣传。

若费用/速度目标未达到，保持 observe 默认，公布结果和限制；不能通过删除失败样本、降低验收或隐藏人工帮助制造收益。

### R10：在稳定证据上增加自主改进

此项进入后续版本，不作为 alpha.2 首先要完成的内容。

按 F04/F05 实现“失败分类 → 有版本的有限候选 → 开发筛选 → 冻结留出确认 → 按父任务灰度 → 退化回退”。先允许修改续接规则、阈值、交接模板和取回策略；保持权限、验收和总预算固定。

候选必须包含变更差异、来源证据、适用范围、预期机制、优化成本和前一版本；记录那些淘汰的候选。执行中的任务保持版本稳定，回退不破坏其已有状态。

反馈诊断只是提出假设；通过独立结果才进入规则库。线上观察可以找漂移，不能单凭相关性宣称因果收益。需要持续自动决策时另行设计有效的序贯评估，不能一直重复查看固定样本区间。

## 4. 修改时的工程约束

- 继续沿用 DSH 的子代理、会话、权限和中断生命周期，不另外维护第二个 Agent Runtime。
- 新模块围绕现有 stores 接线，不复制 graph、mailbox、session registry 或 usage ledger。
- 优先明确来源、身份和状态语义，再写 UI 或自动决策。来源不完整时显示 unknown。
- 批次共享入口安排一个集成人；可独立修改的测试、文档或独立模块再分工。本文不启动任何子代理。
- vendor 内的角色接线改动同步记录 `vendor/omd/PATCHES.md`，便于以后合并上游。
- 保留现有显式调用兼容性；新受控能力按支持范围启用，不让旧任务静默变更。

## 5. 每次修改的验证流程

先跑与本次改动相关的组合回归，再执行全量必要检查。现有入口：

```powershell
node test/integration/wp02-usage-ledger.test.mjs
node test/integration/wp05-managed.test.mjs
node test/integration/wp06-budget.test.mjs
node test/integration/strategy-eval.test.mjs
node scripts/check.mjs
node scripts/pack-check.mjs
```

全量测试有 npm 时使用 `npm test`；本机只有 Node 时，可按 package 中的真实清单运行：

```powershell
$testList = (Get-Content package.json -Raw | ConvertFrom-Json).scripts.test -split ' && '
foreach ($entry in $testList) {
  & node.exe ($entry -replace '^node ', '')
  if ($LASTEXITCODE -ne 0) { throw "测试失败：$entry" }
}
```

`check.mjs` 会启动独立模块检查进程；环境禁止该行为时先确认进程限制，不能将环境拦截判作全部模块坏掉。`pack-check.mjs` 是清单检查，不替代实际打包安装。

既有 `efficiency-capability-check.mjs`、`cache-affinity-check.mjs`、`host-live-check.cjs` 涉及安装宿主和隔离 profile，运行前按各脚本现有用法准备；不要直接对用户正在工作的会话做破坏性验证。真实模型测试、对照批次与仅装载探针分开记录。

每项结果存版本、工作树指纹、宿主/CLI、profile、策略版本、实际模型、过程、退出码、费用覆盖与产物。自动检查通过后还需真实链路和 Desktop 证据；不要把文件存在、mock 通过、实际费用改善混为一谈。

## 6. 直接开始修改时使用的任务说明

下一次开发可以从下面这项开始，无需重新设计全部架构：

> 先完成 R00 基线复核，然后只实现 R01 原生事件桥。阅读 NEXT-PRACTICE、现有 usage-ledger/execution-events、角色 request/created 接线和 WP00 能力证据。保留现有未提交修改，复用现有 stores，不新建第二套任务状态机。为原生 child 建立父任务/node/attempt 关联，通过宿主事件归集实际路由、每次 usage 和终态；事件重复/重启不能重复记账，失败缺 usage 保持 unknown。完成组合回归和无模型宿主探针，输出证据与明确边界。尚未接通的预算执行、真实模型和 Desktop 验收不得提前标通过。

R01 稳定后进入 R02，再进入 R03。不要先实现自动选模型或扩大团队；这些都依赖可信的成本和状态基础。

## 7. 最终交付物

alpha.2 至少交付：原生/外部覆盖矩阵、受控协作真实链路、预算停止与恢复证据、可解释的会话选择、完整 trial 导出、独立验收、三组对照报告、设置卡与回退、真实安装结果及已知限制。

用户可据此判断：这项需求为什么新建/续接、到底用了多少新输入和费用、为什么停止、哪些内容已验证、哪个策略在哪类任务上更有效。满足这些条件后，再开展可回退的自主优化。
