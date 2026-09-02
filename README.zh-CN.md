# daruma

> **七転八起，跌而不倒。**

Daruma 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一个韧性层。它只为一件事存在：第三方订阅 API 会抽风。限流（`429`）、服务端错误（`500`）、网络抖动、模型抽风、风控拦截——其中任何一个都能把长任务掐断在半路。Daruma 捕捉到失败，**切换到另一个模型/渠道**，让会话替你继续跑下去。

## 工作原理

Daruma 落在 DSH 的两个原生扩展点上：

| 机制 | 负责方 | 作用 |
|---|---|---|
| **重试** | 内建 `dsh-llm-retry` | 同渠道，有界的指数退避 |
| **换渠道** | `dsh-daruma` | 重试放弃后，或遇到终态错误（`QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`）时，切到下一个渠道 |

决策引擎是纯函数：同样的失败历史 + 同样的渠道状态 → 同样的恢复计划。确定性、可测试、无 I/O。

## 包结构

| 包 | 职责 |
|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | DSH 插件——挂 `agent/request-error` + `agent/request`，进程内换渠道 |
| [`daruma-core`](./packages/daruma-core) | 纯域层——故障分类、熔断状态机、恢复决策引擎 |

## 快速开始

```bash
# 本地开发（link 工作区里的包）
dsh plugin --profile web add link:./packages/daruma-core link:./packages/dsh-daruma

# 发布之后：
dsh plugin --profile web add dsh-daruma
```

在 profile 的 `cordis.patch.yml` 里配置渠道链：

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mt, model: deepseek-v4-pro }
      - { provider: mt, model: glm-5.2 }
    failureBudget: 3
    cooldownMs: 30000
    giveUpBudget: 8       # 每个 agent 的故障转移预算
```

当 `deepseek-v4-pro` 开始回 `429`，daruma 熔断它、改用 `glm-5.2` 继续。渠道健康状态落到 `~/.dsh/daruma/channel-health.json`，被熔断的渠道在重启后依然保持冷却。

## 为什么叫 daruma

[达摩不倒翁](https://en.wikipedia.org/wiki/Daruma_doll) 源自一句谚语——**七転八起**（跌七次，起八次）。你的长任务也一样：被 `429` 击中，再爬起来。

## 当前状态

已实现并测试：37 个单测，外加一次端到端换渠道实测（主渠道 mock `429` → 自动切换 → 任务完成）。见 [`docs/e2e-test.md`](./docs/e2e-test.md) 与 [`docs/research.md`](./docs/research.md)。

尚未发布到 npm。

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © 2026 SISCHOI
