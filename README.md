# daruma

> 达摩不倒翁：被击倒，就再站起来。

**Daruma** is a resilience plugin for DeepSeek Harness (DSH). It targets one
recurring failure mode: third-party API subscriptions that are flaky — `429`/`500`
rate limits, network jitter, provider-side model stalls, and moderation/风控
gatekeeping. When any of these kill a long task mid-flight, daruma detects the
failure and **fails over to another model/channel** so the session keeps going.

Two mechanisms cooperate:

1. **retry** — same channel, bounded backoff (owned by the in-box `dsh-llm-retry`);
2. **fail over** — after retry gives up or a terminal error (`QUOTA` /
   `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`) hits, daruma switches to
   the next channel and continues.

| Package | Role |
|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | native Cordis plugin (`agent/request-error` + `agent/request`) — in-process failover |
| [`daruma-core`](./packages/daruma-core) | pure domain layer (no Node deps) — failure taxonomy, circuit breaker, decision engine |

## Why "daruma"

A [Daruma doll](https://en.wikipedia.org/wiki/Daruma_doll) is a Japanese roly-poly toy: knock it over and it rights itself. Your long tasks are the same — hit them with a 429 and they get back up.

## Status

Core domain and the DSH plugin are implemented and unit-tested (44 tests).
`dsh-daruma` has been verified end-to-end: a mock 429 on the primary channel
fails over to the fallback channel and the task completes (see
[`docs/e2e-test.md`](./docs/e2e-test.md)). See
[`docs/research.md`](./docs/research.md) for the design rationale and
architecture decisions (ADRs).

Remaining before release: npm publishing.

## Packages

- [`daruma-core`](./packages/daruma-core) — pure domain layer: failure taxonomy,
  circuit breaker, recovery decision engine.
- [`dsh-daruma`](./packages/dsh-daruma) — DSH plugin; see its
  [README](./packages/dsh-daruma/README.md) for config.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © 2026 SISCHOI
