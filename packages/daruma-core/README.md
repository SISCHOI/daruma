# daruma-core

Pure domain layer for Daruma: failure classification, channel health (circuit
breaker), and the recovery decision engine. Zero Node runtime dependencies —
no `node:*` imports, no DSH/Codex/Claude symbols.

## Domain

- `FailureCode` — provider-neutral taxonomy (`RATE_LIMIT`, `SERVER`,
  `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`,
  `INVALID_CREDENTIAL`, `PROCESS_EXITED`, `STALLED`, `UNKNOWN`).
- `ChannelHealth` — circuit-breaker state machine
  (`HEALTHY → COOLDOWN → PROBE → HEALTHY`).
- `decide()` — pure decision engine: same input → same `RecoveryPlan`
  (`RETRY_NOW` / `FAILOVER` / `RESUME` / `GIVE_UP`).

## Ports

`Clock`, `ChannelHealthStore`, `HealthProbe`, `SignalSource` — defined here,
implemented by host adapters (`dsh-daruma`, `daruma-watch`).

## API

```ts
import { decide, channelId, modelId, backoffDelayMs } from 'daruma-core'

const plan = decide({
  signal: { code: 'QUOTA', channel: channelId('mt::a'), occurredAtMs: Date.now() },
  healths: new Map(),
  failoverCount: 0,
  config: {
    channels: [
      { id: channelId('mt::a'), provider: 'mt', model: modelId('a') },
      { id: channelId('mt::b'), provider: 'mt', model: modelId('b') },
    ],
    failureBudget: 3,
    cooldownMs: 30_000,
    giveUpBudget: 8,
  },
  nowMs: Date.now(),
})
// plan.verdict.kind === 'FAILOVER'
```

## Development

```bash
pnpm --filter daruma-core build
pnpm --filter daruma-core test
```
