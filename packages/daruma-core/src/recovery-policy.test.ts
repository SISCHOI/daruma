import { describe, expect, it } from 'vitest'
import { channelId, modelId, type Channel } from './channel.ts'
import { freshHealth, type ChannelHealth } from './channel-health.ts'
import { decide, type RecoveryPlan } from './recovery-policy.ts'
import type { RecoveryPolicyConfig } from './config.ts'
import type { FailureSignal } from './signal.ts'

const A = channelId('ch-a')
const B = channelId('ch-b')
const C = channelId('ch-c')

const channels: Channel[] = [
  { id: A, provider: 'provider-a', model: modelId('model-a') },
  { id: B, provider: 'provider-b', model: modelId('model-b') },
  { id: C, provider: 'provider-c', model: modelId('model-c') },
]

const config: RecoveryPolicyConfig = {
  channels,
  failureBudget: 3,
  cooldownMs: 30_000,
  giveUpBudget: 8,
}

function signal(code: FailureSignal['code'], channel = A, at = 1000): FailureSignal {
  return { code, channel, occurredAtMs: at }
}

function healthsOf(entries: Array<[typeof A, ChannelHealth]>): Map<typeof A, ChannelHealth> {
  return new Map(entries)
}

describe('recovery policy decide()', () => {
  it('retries a transient failure within budget', () => {
    const plan = decide({
      signal: signal('RATE_LIMIT'),
      healths: healthsOf([[A, freshHealth(A, 0)]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict.kind).toBe('RETRY_NOW')
    expect(plan.healthAfter.consecutiveFailures).toBe(1)
    expect(plan.failoverCount).toBe(0)
  })

  it('fails over to the next channel after the budget trips', () => {
    let h = freshHealth(A, 0)
    h = { ...h, consecutiveFailures: 2 }
    const plan = decide({
      signal: signal('RATE_LIMIT'),
      healths: healthsOf([[A, h]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
    expect(plan.healthAfter.state).toBe('COOLDOWN')
    expect(plan.failoverCount).toBe(1)
  })

  it('fails over immediately on a terminal failure', () => {
    const plan = decide({
      signal: signal('QUOTA'),
      healths: healthsOf([[A, freshHealth(A, 0)]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
    expect(plan.healthAfter.state).toBe('COOLDOWN')
  })

  it('skips a channel that is still cooling down', () => {
    const a = freshHealth(A, 0)
    const b = { ...freshHealth(B, 0), state: 'COOLDOWN', cooldownUntilMs: 90_000 } as ChannelHealth
    const plan = decide({
      signal: signal('QUOTA', A),
      healths: healthsOf([[A, a], [B, b]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: C } })
  })

  it('gives up when no fallback is routable', () => {
    const a = freshHealth(A, 0)
    const b = { ...freshHealth(B, 0), state: 'COOLDOWN', cooldownUntilMs: 90_000 } as ChannelHealth
    const c = { ...freshHealth(C, 0), state: 'COOLDOWN', cooldownUntilMs: 90_000 } as ChannelHealth
    const plan = decide({
      signal: signal('QUOTA', A),
      healths: healthsOf([[A, a], [B, b], [C, c]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict).toMatchObject({ kind: 'GIVE_UP', reason: 'no-routable-fallback' })
    expect(plan.failoverCount).toBe(0)
  })

  it('gives up when the failover budget is exhausted', () => {
    const plan = decide({
      signal: signal('QUOTA'),
      healths: healthsOf([[A, freshHealth(A, 0)]]),
      failoverCount: 8,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict).toMatchObject({ kind: 'GIVE_UP', reason: 'give-up-budget-exhausted' })
    expect(plan.failoverCount).toBe(8)
  })

  it('prefers the user-chosen backup channel over the fallback chain', () => {
    const preferred = channels[1]! // B
    const plan = decide({
      signal: signal('QUOTA', A),
      healths: healthsOf([[A, freshHealth(A, 0)]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
      preferred,
    })
    expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
  })

  it('skips a cooled-down backup channel', () => {
    const preferred = channels[1]! // B
    const b = { ...freshHealth(B, 0), state: 'COOLDOWN', cooldownUntilMs: 90_000 } as ChannelHealth
    const plan = decide({
      signal: signal('QUOTA', A),
      healths: healthsOf([[A, freshHealth(A, 0)], [B, b]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
      preferred,
    })
    // B is cooling → falls through to C.
    expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: C } })
  })

  it('is deterministic: same input → same plan', () => {
    const mk = () => ({
      signal: signal('SERVER', A, 1000),
      healths: healthsOf([[A, freshHealth(A, 0)]]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    const p1: RecoveryPlan = decide(mk())
    const p2: RecoveryPlan = decide(mk())
    expect(p1).toEqual(p2)
  })

  it('uses an unknown channel as a fresh HEALTHY channel', () => {
    const plan = decide({
      signal: signal('TIMEOUT', channelId('never-seen')),
      healths: healthsOf([]),
      failoverCount: 0,
      config,
      nowMs: 1000,
    })
    expect(plan.verdict.kind).toBe('RETRY_NOW')
    expect(plan.healthAfter.channel).toBe('never-seen')
  })
})
