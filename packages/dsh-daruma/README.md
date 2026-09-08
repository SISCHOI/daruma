# dsh-daruma

Daruma resilience plugin for DeepSeek Harness — detects model-request failures
and fails over to another channel to keep long tasks alive.

## How it works

dsh-daruma is a native Cordis plugin. It sits **downstream of the in-box
`dsh-llm-retry`** on the `agent/request-error` waterfall: retry owns the
same-channel retry budget, and when it gives up it delegates (via `next()`) to
daruma. daruma then:

1. records the failure against the current channel's circuit-breaker state;
2. when the channel trips (`failureBudget` consecutive failures, or a terminal
   code like `QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`), it
   arms the next routable channel and returns `{ kind: 'retry' }`;
3. on the retry turn, the `agent/request` waterfall swaps the request config
   onto the armed channel.

Channel health persists to `~/.dsh/daruma/channel-health.json`, so a tripped
channel stays cooled-down across restarts.

## Visible failover notices in the conversation

When a channel switch happens mid-turn, the web client renders a small
`daruma` row **inside the conversation flow** (anchored at the failover event,
right where it occurred): `mt::glm-5.3 failed (RATE_LIMIT) → trying
deepseek-official::deepseek-v4-flash`, with the budget usage
(`failover 2/3 · turn 3 step 1`) on hover.

This works through the host's plugin-extensible conversation engine: the
client registers a definition claiming `daruma/failover` session events plus a
keyed renderer for its node kind, mirroring how in-repo retries render. The
notice is **live-only** — out-of-repo session events are not yet persisted by
the harness, so rows do not survive a page reload or a resumed session.

## Install

```bash
dsh plugin --profile web add dsh-daruma   # from npm
# or from a checkout:
dsh plugin --profile web add link:./packages/daruma-core link:./packages/dsh-daruma
```

## Configure

Add a `dsh-daruma` entry to your profile's `cordis.patch.yml` (or rely on the
bundle defaults) with an ordered failover chain:

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - provider: mt
        model: deepseek-v4-pro
      - provider: mt
        model: glm-5.2
    failureBudget: 3
    cooldownMs: 30000
    giveUpBudget: 8
```

Each channel is a `{ provider, model }` pair reachable by the LLM adapter
registry (same names you use in the settings model selector).

## Development

```bash
pnpm --filter dsh-daruma build
pnpm --filter dsh-daruma test
```
