import { describe, expect, it } from 'vitest'
import { channelId, modelId, type Channel, type ChannelHealth, type ChannelHealthStore, type ChannelId, type RecoveryPolicyConfig } from 'daruma-core'
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
})
