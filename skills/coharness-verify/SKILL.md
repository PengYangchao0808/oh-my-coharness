---
name: coharness-verify
description: Choose the evidence a change actually needs, then collect it as real commands with exit codes — and say "unverified" instead of "done" when there is none.
whenToUse: Before claiming any change is complete, after a Build or Review stage, or when the user asks "真的测试过吗 / 怎么证明".
---

# Verify：证据，不是断言

「我改完了」和「它工作了」是两句话。Verify 只负责第二句。

## 按风险定证据

| 风险 | 典型改动 | 最少证据 |
|---|---|---|
| **低** | 文档、注释、只读脚本 | 类型检查 / 单测 / 语法检查 |
| **中** | 业务逻辑、API、数据转换 | 单测 + 集成测试 |
| **高** | 认证、数据迁移、UI 交互、破坏性变更 | 集成测试 + 手动或视觉检查 + 回滚方案 |

不要给文档改动要求端到端 UI 测试，也不要给认证改动只跑一个单测。

## 证据的格式

每条证据必须包含三件事：

```text
命令：<原样的命令>
退出码：<0 / 非 0 / 未取得>
输出：<尾部若干行>
```

- **没有退出码就是「未验证」。** 不要把「看起来通过了」写成通过。
- 输出被裁剪时说明裁剪了多少，并指出完整输出在哪。
- 用 DSH 现有测试工具跑；**不要新增 OMC 执行器**，也不要把测试命令交给外部 CLI 替你判断通过与否。
- 若命令因为环境原因没跑起来（缺依赖、缺网络、缺凭据），如实写「未能执行」+ 原因，而不是「应该没问题」。

## 测试不存在时

- 先看仓库里有没有现成的测试入口（`package.json` scripts、`Makefile`、`pytest.ini`、CI 配置）。
- 确实没有时，提出**最小测试建议**：测哪个行为、用哪个工具、断言什么。
- 不要为了凑一个「通过」临时写一个必然通过的空测试。

## 汇报模板

```text
验证项              命令                                  退出码   结论
单元测试            node --test test/smoke.test.mjs        0       通过（17/17）
包自检              node scripts/check.mjs                 0       通过
手动检查            打开设置页 → 切换主题                    -       未执行（无 GUI 会话）
```

结尾一句必须与证据一致：

- 有通过证据 → 「已验证：<命令> 退出码 0」。
- 只有部分证据 → 「部分验证：X 通过，Y 未验证」。
- 没有证据 → 「未验证」。

## 与外部 CLI 的分工

- 外部 CLI 说「我测试通过了」只是**它的声明**，不是你的证据。转述时必须标明来源。
- 需要外部 CLI 自测时，在 prompt 里要求它输出**命令 + 退出码 + 输出尾部**，缺一不可。
- 最终是否通过由主控根据真实输出判定；不要让执行者自己给自己验收。

## 反模式

- ❌ 「测试都过了」但没有命令和退出码。
- ❌ 用 `|| true`、`2>/dev/null` 把失败藏掉。
- ❌ 只跑测试的子集，却报告成全部通过。
- ❌ 把上一次运行的输出当成这一次的证据。
- ❌ 外部 CLI 返回 `STATUS: done` 就直接宣布完成——那是 Build 的声明，Verify 还没开始。
