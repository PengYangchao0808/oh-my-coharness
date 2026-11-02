# 官方配置模板（v0.6 稳定版候选）

两个模板都是 **OMC Host 行 config 的片段**，合并进 DSH profile 的 `cordis.patch.yml`：

```yaml
- id: oh-my-coharness
  name: oh-my-coharness
  config:
    # 把模板里除 $comment 以外的键粘贴到这里
  disabled: false
```

| 模板 | 用途 | 前提 |
|---|---|---|
| [`safe-native.json`](safe-native.json) | 首次安装默认：全部角色 DSH Native，外部 CLI 不激活 | 无 |
| [`hybrid-subscription.json`](hybrid-subscription.json) | Native 调度 + Codex 评审 + Antigravity 前端方案 | Codex / AGY 均已完成真实最小调用验收 |

原则：

- **开放权重模型走 DSH Native**：模型 Provider、凭据、会话、工具、权限都由 DSH 管理，在 `Settings → Models` 中配置；OMC 不建立第二套 Provider。
- **闭源订阅走官方 Harness**：Codex / Kimi / GLM Coding Plan / OpenCode Go / Antigravity 用各自 CLI 的订阅认证执行。
- **未验收不启用**：`auth: unknown` 不等于已登录；自动路由只认 `routable`（见 `docs/STABILIZATION.zh-CN.md` §3）。

## 角色模型（Native 侧）

`provider` 与 `model` 必须**成对**出现，否则该角色继承 DSH 会话模型（DSH 侧行为，OMC 不介入）：

```json
{
  "roles": {
    "explorer": { "provider": "ollama", "model": "qwen2.5-coder:7b" },
    "fixer": { "provider": "ollama", "model": "qwen2.5-coder:14b" }
  }
}
```

完整示例见 [`native-model-profiles.example.json`](native-model-profiles.example.json)。不要发布固定了用户环境不存在模型的工厂默认值。

## 人工验收记录

对无法无交互探测登录的 CLI（`auth: unknown`），在完成一次真实调用后用 `verify` 记录，这是它进入 `authenticated` / `verified` 的**唯一**方式：

```yaml
harnesses:
  antigravity:
    enabled: true
    billing: subscription
    verify:
      accepted: true
      at: "2026-10-30"
      mode: read-only
      note: "AGY 1.4.10 登录后一次只读调用通过，返回结构化文本"
```

记录必须写清版本、日期与执行模式；`mode` 只接受 `read-only` 或 `patch`。

## 计费与失败语义

- `billing`：`subscription`（默认可自动路由）| `api`（需 `routing.allowPaidApi`）| `unknown`（需 `routing.allowUnknownBilling`）。**未知不等于免费。**
- `fallback: "fail"`：订阅失效时明确失败。要自动改走 Native 必须显式写 `fallback: "native"`。
- `dispatch.allowDirectFallback: false`：Provider 缺失/拒绝时返回 `OMC/PROVIDER-UNAVAILABLE`，不静默降级 Direct。
- 外部 Fixer 不可写；外部 Designer 只返回 Patch。这是发布安全边界。
