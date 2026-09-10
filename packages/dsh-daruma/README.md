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
   arms the next routable channel (the user-chosen backup first, then the
   configured chain) and returns `{ kind: 'retry' }`;
3. on the retry turn, the `agent/request` waterfall swaps the request config
   onto the armed channel;
4. appends one JSON line per decision to the audit log (see below).

**Self-healing:** the host exposes no request-success event, so success is
inferred — an agent whose previous model request never tripped
`agent/request-error` earns its channel a success record at the next
`agent/pre-step` or `agent/turn-stopping`. The circuit closes and the failure
counter resets; tripped channels never linger as zombie `COOLDOWN` entries.

Channel health persists to `~/.dsh/daruma/channel-health.json`, so a tripped
channel stays cooled-down across restarts.

## Visible failover notices in the conversation

When a channel switch happens mid-turn, the web client renders a small
`daruma` row **inside the conversation flow** (anchored at the failover event,
right where it occurred): `mt::glm-5.3 failed (RATE_LIMIT) → trying
mt::deepseek-v4-flash`, with the budget usage
(`failover 2/3 · turn 3 step 1`) on hover. When recovery is exhausted, a
red-dotted **give-up row** (`mt::glm-5.3 failed (RATE_LIMIT) → recovery
budget exhausted, giving up`) renders instead of failing silently.

This works through the host's plugin-extensible conversation engine: the
client registers definitions claiming `daruma/failover` / `daruma/give-up`
session events plus a keyed renderer for its node kind, mirroring how
in-repo retries render. The notices are **live-only** — out-of-repo session
events are not yet persisted by the harness, so rows do not survive a page
reload or a resumed session.

## Audit log

Every failover / give-up / boot decision is appended to
`~/.dsh/daruma/failover-log.jsonl` (rotates at 2 MiB to one `.1` generation;
write failures are swallowed — a lost line never breaks recovery):

```jsonl
{"kind":"boot","t":1788860215489,"pid":38660,"channels":["mt::glm-5.3","mt::deepseek-v4-flash","mt-cc::claude-3-5-haiku-latest"],"failureBudget":3,"cooldownMs":30000,"giveUpBudget":8}
{"kind":"failover","t":1788850743199,"agentId":"session-2c50…","from":"mt::glm-5.3","to":"mt::deepseek-v4-flash","reason":"RATE_LIMIT","turn":1,"step":1,"failoverCount":1,"giveUpBudget":8}
{"kind":"give-up","t":1788850876140,"agentId":"session-295a…","from":"mt::deepseek-v4-flash","reason":"no-routable-fallback","turn":1,"step":1,"failoverCount":1,"giveUpBudget":8}
```

`reason` is the failure code for failovers (`RATE_LIMIT`, `QUOTA`, …) or the
give-up cause (`give-up-budget-exhausted` / `no-routable-fallback`);
`failoverCount` / `giveUpBudget` capture the budget state at the decision.

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
        model: glm-5.3
      - provider: mt
        model: deepseek-v4-flash
      - provider: mt-cc
        model: claude-3-5-haiku-latest
    failureBudget: 3     # consecutive failures before a channel trips
    cooldownMs: 30000    # how long a tripped channel stays unroutable
    giveUpBudget: 8      # per-agent failover budget before giving up
    # stateFile: /path/to/isolated/health.json   # REQUIRED for test profiles
    # logFile: /path/to/isolated/failover-log.jsonl
```

Each channel is a `{ provider, model }` pair reachable by the LLM adapter
registry (same names you use in the settings model selector).

> ⚠️ Every chain channel must exist in your `settings.yaml` providers — a
> channel whose provider is missing gets armed on failover, burns one budget
> slot, and fails again. And test/mock profiles must isolate `stateFile`, or
> mock channels pollute the production health records.

## Development

```bash
pnpm --filter dsh-daruma build
pnpm --filter dsh-daruma test
```

## Host compatibility boundary

The recovery engine is independent of DSH runtime objects. Host-facing session
writes go through `src/event-sink.ts`; a Session API change or an unavailable
custom event surface is logged and degraded without interrupting failover.
`src/host-capabilities.ts` records optional host surfaces (RPC and conversation
event registry) so client integrations can remain capability-driven as DSH
releases evolve.
