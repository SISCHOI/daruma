# daruma

> 达摩不倒翁：被击倒，就再站起来。

**Daruma** is a resilience watchdog for long-running coding-agent tasks. It targets one recurring failure mode: third-party API subscriptions that are flaky — `429`/`500` rate limits, network jitter, provider-side model stalls, and moderation/风控 gatekeeping. When any of these kill a long task mid-flight, daruma detects the non-human interruption and keeps the session alive by one of three escalating strategies:

1. **retry** — same provider, bounded exponential backoff;
2. **fail over** — switch to another model / channel and continue;
3. **resume** — the process died; restart it and resume the same session.

It works across three agent CLIs:

| Package | Host | Integration | Recovery |
|---|---|---|---|
| [`dsh-daruma`](./packages/dsh-daruma) | DeepSeek Harness (DSH) | native Cordis plugin (`agent/request-error` + `agent/request`) | in-process failover |
| [`daruma-watch`](./packages/daruma-watch) | Codex CLI / Claude Code | external watchdog daemon (`npx daruma-watch`) | process-level resume |
| [`daruma-core`](./packages/daruma-core) | — | pure domain layer (no Node deps) | shared decision engine |

## Why "daruma"

A [Daruma doll](https://en.wikipedia.org/wiki/Daruma_doll) is a Japanese roly-poly toy: knock it over and it rights itself. Your long tasks are the same — hit them with a 429 and they get back up.

## Status

Core domain, the DSH plugin, and the watchdog are implemented and unit-tested
(58 tests). `dsh-daruma` has been verified to load and activate in a real DSH
boot (isolated profile on a separate port). See
[`docs/research.md`](./docs/research.md) for the design rationale and
architecture decisions (ADRs).

Remaining before release: an end-to-end failover trigger against a live model
failure, and npm publishing.

## Packages

- [`daruma-core`](./packages/daruma-core) — pure domain layer: failure taxonomy,
  circuit breaker, recovery decision engine.
- [`dsh-daruma`](./packages/dsh-daruma) — DSH plugin; see its
  [README](./packages/dsh-daruma/README.md) for config.
- [`daruma-watch`](./packages/daruma-watch) — Codex/CC watchdog; see its
  [README](./packages/daruma-watch/README.md) for CLI usage.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT © 2026 SISCHOI
