# daruma

> **Fall seven times, stand up eight.**

Daruma is a resilience layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It exists for one reason: third-party API subscriptions are flaky. Rate limits (`429`), server errors (`500`), network jitter, provider-side model stalls, moderation gatekeeping — any of them kills a long-running task mid-flight. Daruma catches the failure and **fails over to another model/channel**, so the session keeps going without you.

## How it works

Daruma rides two of DSH's native extension points:

| Mechanism | Owner | Effect |
|---|---|---|
| **Retry** | in-box `dsh-llm-retry` | same channel, bounded exponential backoff |
| **Fail over** | `dsh-daruma` | after retry gives up, or on a terminal error (`QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`), switch to the next channel |

The decision engine is a pure function: same failure history + same channel state → same recovery plan. Deterministic, testable, no I/O.

## Packages

| Package | Role |
|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | the DSH plugin — hooks `agent/request-error` + `agent/request` for in-process failover |
| [`daruma-core`](./packages/daruma-core) | pure domain layer — failure taxonomy, circuit breaker, recovery decision engine |

## Quick start

```bash
# local development (link the workspace packages)
dsh plugin --profile web add link:./packages/daruma-core link:./packages/dsh-daruma

# once published:
dsh plugin --profile web add dsh-daruma
```

Configure a failover chain in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mt, model: deepseek-v4-pro }
      - { provider: mt, model: glm-5.2 }
    failureBudget: 3
    cooldownMs: 30000
    giveUpBudget: 8
```

When `deepseek-v4-pro` starts returning `429`, daruma trips it and continues on `glm-5.2`. Channel health persists to `~/.dsh/daruma/channel-health.json`, so a tripped channel stays cooled down across restarts.

## Why "daruma"

A [Daruma doll](https://en.wikipedia.org/wiki/Daruma_doll) is a roly-poly toy rooted in a proverb — *fall seven times, stand up eight* (七転八起). Your long tasks are the same: hit them with a `429`, and they get back up.

## Status

Implemented and tested: 47 unit tests, plus an end-to-end failover run (mock
`429` on the primary channel → automatic switch → task completes). The plugin
also ships a web client: a channel-status dock above the composer and a backup
panel that probes candidate models and picks a backup. See
[`docs/e2e-test.md`](./docs/e2e-test.md) and
[`docs/research.md`](./docs/research.md).

Not yet published to npm.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © 2026 SISCHOI
