import { describe, expect, it } from 'vitest'
import { channelId, modelId, type ChannelHealth, type ChannelHealthStore, type ChannelId, type RecoveryPolicyConfig } from 'daruma-core'
import { RecoveryEngine } from './engine.ts'

class MemoryStore implements ChannelHealthStore {
  readonly map = new Map<ChannelId, ChannelHealth>()
  load(channel: ChannelId): ChannelHealth | undefined {
    return this.map.get(channel)
  }
  save(health: ChannelHealth): void {
    this.map.set(health.channel, health)
  }
}

const A = channelId('mt::deepseek-v4-pro')
const B = channelId('mt::glm-5.2')
const C = channelId('mt::qwen-3')

const config: RecoveryPolicyConfig = {
  channels: [
    { id: A, provider: 'mt', model: modelId('deepseek-v4-pro') },
    { id: B, provider: 'mt', model: modelId('glm-5.2') },
  ],
  failureBudget: 3,
  cooldownMs: 30_000,
  giveUpBudget: 8,
}

describe('RecoveryEngine', () => {
  it('retries within budget, then fails over on trip', () => {
    const store = new MemoryStore()
    const engine = new RecoveryEngine(config, store, { nowMs: () => 1000 })

    const p1 = engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 })
    expect(p1.verdict.kind).toBe('RETRY_NOW')
    const p2 = engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 })
    expect(p2.verdict.kind).toBe('RETRY_NOW')
    const p3 = engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 })
    expect(p3.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
    expect(p3.failoverCount).toBe(1)
  })

  it('persists channel health to the store', () => {
    const store = new MemoryStore()
    const engine = new RecoveryEngine(config, store, { nowMs: () => 1000 })
    engine.onFailure({ code: 'QUOTA', channel: A, occurredAtMs: 1000 })
    expect(store.map.get(A)?.state).toBe('COOLDOWN')
    // The status view carries the cooldown deadline so the dock can tell
    // "still cooling" from "cooldown already expired" without a success hook.
    expect(engine.listHealth().find((h) => h.channel === A)).toMatchObject({
      state: 'COOLDOWN',
      failures: 1,
      cooldownUntilMs: 1000 + config.cooldownMs,
    })
  })

  it('restores persisted health on a new engine instance', () => {
    const store = new MemoryStore()
    const first = new RecoveryEngine(config, store, { nowMs: () => 1000 })
    first.onFailure({ code: 'QUOTA', channel: A, occurredAtMs: 1000 })

    // New engine sharing the same store: the tripped channel is remembered.
    const second = new RecoveryEngine(config, store, { nowMs: () => 1000 })
    const plan = second.onFailure({ code: 'QUOTA', channel: B, occurredAtMs: 1000 })
    // A is still cooling, so failover must skip it (there is no third channel → GIVE_UP).
    expect(plan.verdict).toMatchObject({ kind: 'GIVE_UP', reason: 'no-routable-fallback' })
  })

  it('keeps failover budgets isolated by scope', () => {
    const scopedConfig: RecoveryPolicyConfig = {
      ...config,
      channels: [
        ...config.channels,
        { id: C, provider: 'mt', model: modelId('qwen-3') },
      ],
      failureBudget: 1,
    }
    const engine = new RecoveryEngine(scopedConfig, new MemoryStore(), { nowMs: () => 1000 })
    const first = engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')
    const second = engine.onFailure({ code: 'RATE_LIMIT', channel: C, occurredAtMs: 1000 }, undefined, 'agent-2')
    expect(first.failoverCount).toBe(1)
    expect(second.failoverCount).toBe(1)
  })

  it('clears a disposed scope budget', () => {
    const scopedConfig: RecoveryPolicyConfig = { ...config, failureBudget: 1 }
    const engine = new RecoveryEngine(scopedConfig, new MemoryStore(), { nowMs: () => 1000 })
    engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')
    engine.clearScope('agent-1')
    // A is cooling, but the scope itself starts again from zero; this call
    // demonstrates the cleanup API is safe and idempotent.
    expect(() => engine.clearScope('agent-1')).not.toThrow()
  })

  it('reports the per-scope failover count and budget for tracing', () => {
    const engine = new RecoveryEngine(
      { ...config, failureBudget: 1 },
      new MemoryStore(),
      { nowMs: () => 1000 },
    )
    expect(engine.failoverCountFor('agent-1')).toBe(0)
    engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')
    expect(engine.failoverCountFor('agent-1')).toBe(1)
    expect(engine.giveUpBudget).toBe(config.giveUpBudget)
  })
})
