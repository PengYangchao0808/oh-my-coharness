---
name: coharness-council
description: Put the same question to two different external AI CLIs in one read-only dispatch, then synthesise consensus, disagreement and evidence yourself instead of concatenating answers.
whenToUse: The user explicitly asks for a council, consensus, "多模型看看", "独立意见", "不要只用一个模型", or a second opinion whose value is that it comes from a different model.
---

# Council：一次调用，两个独立席位

Council 不是「多跑几个 agent 显得更认真」。它是**两个不同 Harness 各自独立回答同一个问题**，由主控做合成。

## 触发条件

- 用户明确说：council / 共识 / 多模型看看 / 独立意见 / 不要只用一个模型。
- 决策代价高，且**不同模型的偏见来源不同**（例如：让 Codex 看工程风险，让 GLM 看产品边界）。

不要为普通问题触发。默认 2 席；3 席只在用户明确要求时，而且要说清成本。

## 第 0 步：先看有什么（免费）

```
coharness({ action: 'list' })
```

必须选出**两个不同的 Harness**。同一个 Harness 跑两次是重复采样，不是 council——不要那样做，也不要把它包装成 council。

若可用的 Harness **不足两个**：

- 单派发一个，并在回答开头说明「这里只有一个 Harness，所以这不是 council，只是单模型意见」；
- 不要为了凑两席去启用一个 `signed-out` 或未安装的 CLI。

## 第 1 步：一次调用，两席只读并行

```js
coharness({
  action: 'dispatch',
  mode: 'read-only',
  delivery: 'await',
  tasks: [
    {
      harness: 'codex',
      prompt:
        'Independently review this design. Report concrete risks and the evidence behind each one. ' +
        'Do not assume any other reviewer exists. Answer in Chinese.\n\n<design>…</design>',
    },
    {
      harness: 'glm',
      prompt:
        'Independently review this design. Report concrete risks and the evidence behind each one. ' +
        'Do not assume any other reviewer exists. Answer in Chinese.\n\n<design>…</design>',
    },
  ],
})
```

要点：

- **一次调用**：两席是 `tasks[]` 的两个元素，真并行；不要写成两次串行调用。
- **只读**：`mode: 'read-only'`。评审不需要写文件；若某个 CLI 的只读只是 advisory（opencode / kimi / glm），在最终报告里提醒用户「它可能仍会写」。
- **同步**：`delivery: 'await'`，因为下一步的合成必须等两席都结算。
- **独立性**：每个席位只看到问题，看不到另一席的答案；任务文本里要明写「独立回答」。不要把两席的 prompt 拼在一起。
- **自包含**：外部 CLI 看不到这段对话。把设计、约束、验收标准写进 prompt。

## 第 2 步：主控合成（这是 council 的真正产出）

不要直接拼接两段输出。按下面的结构写：

```text
共识（两席都同意的结论，附来源）
  - …                                   seat A (codex) + seat B (glm)

分歧（两席明确冲突的地方，各自理由）
  - codex 认为 X；glm 认为 Y。证据强度：…

未验证（只有一席提到、另一席没覆盖，或两席都没给证据的）
  - …

建议（你作为主控的结论，并说明你依据哪一席的哪条证据）
  - …

置信度：高 / 中 / 低 —— 理由一句话
```

- 每条结论都标来源：`seat A (codex)` / `seat B (glm)`。
- **不做多数票**。两席冲突时看证据，不看谁票多（2 席也没有多数可言）。
- 你可以在合成里加入自己的判断，但要标明「这是我的判断，不是席位结论」。

## 一席失败怎么办

| 情况 | 处理 |
|---|---|
| 一席 `completed`、一席 `failed` / `timeout` | 只用完成的那一席作答，并在开头**明确**写「这次不是完整 council：X 席失败了（原因）」 |
| 一席输出为空或明显答非所问 | 视为该席失败，不要拿它凑共识 |
| 两席都失败 | 如实报告失败与各自诊断，不要用你自己的猜测冒充评审结果 |
| `OMC/TOO-MANY-TASKS` | 拆成两次调用；不要丢掉席位 |
| 两席结论完全相反且都没有证据 | 输出「无法判定」，并给出需要补什么证据 |

**绝不伪造共识。** 只有一席成功时，说清是哪一席、缺了哪一席。

## 不要做

- 不要为了一次 council 把整个仓库贴进 prompt；只贴必要的片段。
- 不要把两席输出原样转述给用户——那是两份报告，不是 council。
- 不要在 council 里允许写入；需要改动时，council 结束后由主控单独发起一次显式 `in-place` 的 Build。
- 不要把 council 当成「更贵的单模型」：它的价值只在**独立性**与**分歧**上。

## 成本

默认 2 席、只读、一次调用。每席都消耗该 CLI 自己的配额。普通问题直接用单 Agent；用户没要求独立意见时不要主动开 council。
