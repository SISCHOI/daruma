# daruma

**[English](#english) · [中文](#中文)**

---

<a id="english"></a>

# Daruma — automatic failover & backup channels for DeepSeek Harness

> **Fall seven times, stand up eight.** — 七転八起

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) is a great place to run long agent tasks — until a third-party API subscription hiccups. Rate limits (`429`), server errors (`500`), network jitter, provider-side model stalls, moderation gatekeeping: any of them kills a long-running task mid-flight. **Daruma catches the failure and fails over to another channel**, so the session keeps going without you.

## What it does

- **Automatic failover.** When the current model/channel trips after repeated failures (or hits a terminal error like `QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`), daruma switches the *next* request to another channel in your configured chain. The in-flight generation continues on the new channel — no lost sessions.
- **Circuit breaker with persistent state.** Each channel carries a health record (failures, cooldown, half-open probe). State persists to `~/.dsh/daruma/channel-health.json`, so a tripped channel stays cooled down across restarts.
- **Backup channel UI.** A compact status dock next to the model selector shows overall health and your current backup. The backup panel lists candidate models per provider and lets you set/clear the backup channel manually — picked from real traffic, no synthetic speed tests.
- **Deterministic decision engine.** All recovery logic lives in a pure function package (`daruma-core`): same failure history + same channel state → same recovery plan. No I/O, fully unit-tested.

## How it works

Daruma rides two of DSH's native extension points:

| Mechanism | Owner | Effect |
|---|---|---|
| **Retry** | in-box `dsh-llm-retry` | same channel, bounded exponential backoff |
| **Fail over** | `dsh-daruma` | after retry gives up, or on a terminal error, switch to the next channel |

```
request → 429 → dsh-llm-retry (backoff, same channel)
                ↓ still failing
          dsh-daruma: trip circuit, arm failover target
                ↓ next request
          swapped onto backup/next channel → task continues
```

## Install

```bash
# local development (link the workspace packages)
dsh plugin --profile web add link:./packages/daruma-core link:./packages/dsh-daruma

# once published to npm:
dsh plugin --profile web add dsh-daruma
```

## Configure

Add a failover chain to your profile's `cordis.patch.yml`:

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mt, model: deepseek-v4-pro }
      - { provider: mt, model: glm-5.2 }
    failureBudget: 3      # consecutive failures before a channel trips
    cooldownMs: 30000     # how long a tripped channel stays in cooldown
    giveUpBudget: 8       # total failure budget before giving up the request
```

When `deepseek-v4-pro` starts returning `429`, daruma trips it and continues on `glm-5.2`.

Then open the web UI → click the channel-status dock (next to the model selector) → pick a backup channel from the candidate list.

## Packages

| Package | Role |
|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | the DSH plugin — hooks `agent/request-error` + `agent/request`, mounts the `/dsh-daruma` RPC channel and the web client |
| [`daruma-core`](./packages/daruma-core) | pure domain layer — failure taxonomy, circuit breaker, recovery decision engine |

## Status

- 43 unit tests (`daruma-core` 27 + `dsh-daruma 16`), all green
- End-to-end failover verified: mock `429` on primary → automatic switch → task completes (see [`docs/e2e-test.md`](./docs/e2e-test.md))
- Running in production on the author's DSH web instance

## Development

```bash
pnpm install
pnpm build
pnpm test        # 43 tests across both packages
```

## Why "daruma"

A [Daruma doll](https://en.wikipedia.org/wiki/Daruma_doll) is a roly-poly toy rooted in a proverb — *fall seven times, stand up eight*. Your long tasks are the same: hit them with a `429`, and they get back up.

## License

MIT © 2026 SISCHOI

---

<a id="中文"></a>

# daruma — DeepSeek Harness 的自动故障转移与备用渠道插件

> **七転八起** —— 摔倒七次，站起来八次。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）跑长任务很顺手 —— 直到第三方 API 订阅抽风。限流（`429`）、服务端错误（`500`）、网络抖动、供应商侧模型卡死、内容审核拦截：任何一个都能把长任务拦腰打断。**daruma 接住失败并切换到其他渠道**，会话无需你介入就能继续。

## 功能

- **自动故障转移。** 当前模型/渠道连续失败（或遇到 `QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED` 等终止性错误）后，daruma 把*下一个*请求切到你配置的链上的其他渠道，正在进行的生成在新渠道上继续 —— 会话不丢。
- **带持久化状态的断路器。** 每个渠道有健康记录（失败数、冷却、半开探测）。状态持久化到 `~/.dsh/daruma/channel-health.json`，重启后冷却中的渠道保持冷却。
- **备用渠道界面。** 模型选择器旁的状态控件显示整体健康度与当前备用渠道。备用面板按 provider 列出候选模型，手动设置/清除备用 —— 基于真实流量，不做合成测速。
- **确定性决策引擎。** 全部恢复逻辑在纯函数包（`daruma-core`）里：同样的失败历史 + 同样的渠道状态 → 同样的恢复方案。无 I/O，完整单测覆盖。

## 工作原理

daruma 挂在 DSH 的两个原生扩展点上：

| 机制 | 归属 | 效果 |
|---|---|---|
| **重试** | 内置 `dsh-llm-retry` | 同渠道有界指数退避 |
| **故障转移** | `dsh-daruma` | 重试放弃后、或终止性错误时，切换到下一个渠道 |

```
请求 → 429 → dsh-llm-retry（退避，同渠道重试）
                ↓ 仍然失败
          dsh-daruma：跳闸断路器，武装转移目标
                ↓ 下一个请求
          换到备用/下一渠道 → 任务继续
```

## 安装

```bash
# 本地开发（链接 workspace 包）
dsh plugin --profile web add link:./packages/daruma-core link:./packages/dsh-daruma

# 发布到 npm 后：
dsh plugin --profile web add dsh-daruma
```

## 配置

在 profile 的 `cordis.patch.yml` 里加一条故障转移链：

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mt, model: deepseek-v4-pro }
      - { provider: mt, model: glm-5.2 }
    failureBudget: 3      # 连续失败几次后渠道跳闸
    cooldownMs: 30000     # 跳闸渠道冷却多久
    giveUpBudget: 8       # 放弃请求前的总失败预算
```

当 `deepseek-v4-pro` 开始返回 `429`，daruma 跳闸它并继续用 `glm-5.2`。

然后打开 Web UI → 点击模型选择器旁的渠道状态控件 → 在候选列表里选一个备用渠道。

## 包结构

| 包 | 角色 |
|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | DSH 插件 —— 挂 `agent/request-error` + `agent/request`，提供 `/dsh-daruma` RPC 通道与 Web 客户端 |
| [`daruma-core`](./packages/daruma-core) | 纯领域层 —— 失败分类、断路器、恢复决策引擎 |

## 状态

- 43 个单元测试（`daruma-core` 27 + `dsh-daruma` 16），全绿
- 端到端故障转移已验证：mock 主渠道 `429` → 自动切换 → 任务完成（见 [`docs/e2e-test.md`](./docs/e2e-test.md)）
- 已在作者的 DSH web 实例生产运行

## 开发

```bash
pnpm install
pnpm build
pnpm test        # 两个包共 43 个测试
```

## 为什么叫 "daruma"

[达摩不倒翁](https://en.wikipedia.org/wiki/Daruma_doll)来自一句谚语 —— *摔倒七次，站起来八次*（七転八起）。你的长任务也一样：挨一记 `429`，再爬起来就是了。

## 许可

MIT © 2026 SISCHOI
