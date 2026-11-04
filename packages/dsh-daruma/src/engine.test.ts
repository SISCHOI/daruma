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

  describe('request-scoped rejection', () => {
    const rejectingConfig: RecoveryPolicyConfig = {
      ...config,
      channels: [...config.channels, { id: C, provider: 'mt', model: modelId('qwen-3') }],
    }

    it('remembers the rejected channel for that scope only', () => {
      const store = new MemoryStore()
      const engine = new RecoveryEngine(rejectingConfig, store, { nowMs: () => 1000 })
      engine.onFailure({ code: 'INVALID_REQUEST', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')

      expect(engine.unusableFor('agent-1')).toEqual([A])
      expect(engine.unusableFor('agent-2')).toEqual([])
      // The channel keeps its health: it is fine for everyone else.
      expect(store.map.get(A)?.state ?? 'HEALTHY').toBe('HEALTHY')
    })

    it('does not route a rejected scope back to the same channel', () => {
      const engine = new RecoveryEngine(rejectingConfig, new MemoryStore(), { nowMs: () => 1000 })
      const first = engine.onFailure(
        { code: 'INVALID_REQUEST', channel: A, occurredAtMs: 1000 },
        { id: B, provider: 'mt', model: modelId('glm-5.2') },
        'agent-1',
      )
      expect(first.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })

      // B is the configured backup; the next rejection on B must not return to A.
      const second = engine.onFailure(
        { code: 'INVALID_REQUEST', channel: B, occurredAtMs: 1000 },
        { id: B, provider: 'mt', model: modelId('glm-5.2') },
        'agent-1',
      )
      expect(second.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: C } })
    })

    it('lets another scope use the same channel', () => {
      const engine = new RecoveryEngine(rejectingConfig, new MemoryStore(), { nowMs: () => 1000 })
      engine.onFailure({ code: 'INVALID_REQUEST', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')
      const other = engine.onFailure({ code: 'QUOTA', channel: A, occurredAtMs: 1000 }, undefined, 'agent-2')
      expect(other.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
    })

    it('forgets exclusions when the scope is disposed', () => {
      const engine = new RecoveryEngine(rejectingConfig, new MemoryStore(), { nowMs: () => 1000 })
      engine.onFailure({ code: 'INVALID_REQUEST', channel: A, occurredAtMs: 1000 }, undefined, 'agent-1')
      engine.clearScope('agent-1')
      expect(engine.unusableFor('agent-1')).toEqual([])
    })

    /**
     * Replays the observed production sequence (2026-11-03): the primary mt
     * channel times out, failover lands on the DeepSeek backup, DeepSeek rejects
     * the conversation's history, and the old policy went straight back to the
     * primary — then to DeepSeek again — until the turn died at the eighth
     * failover. The turn now lands on the third channel instead.
     */
    it('keeps a turn alive across a rejected backup instead of ping-ponging', () => {
      const backupB = { id: B, provider: 'mt', model: modelId('deepseek-flash') }
      let now = 1000
      const engine = new RecoveryEngine(rejectingConfig, new MemoryStore(), { nowMs: () => now })

      const first = engine.onFailure(
        { code: 'TIMEOUT', channel: A, occurredAtMs: now, retryExhausted: true },
        backupB,
        'turn-1',
      )
      expect(first.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })

      const second = engine.onFailure(
        { code: 'INVALID_REQUEST', channel: B, occurredAtMs: now },
        backupB,
        'turn-1',
      )
      expect(second.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: C } })

      // Once A's own cooldown expires the turn returns to it — never to the
      // backup that rejected this conversation.
      now = 1000 + rejectingConfig.cooldownMs + 1
      const third = engine.onFailure(
        { code: 'TIMEOUT', channel: C, occurredAtMs: now, retryExhausted: true },
        backupB,
        'turn-1',
      )
      expect(third.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: A } })
      expect(engine.failoverCountFor('turn-1')).toBe(3)
      expect(engine.failoverCountFor('turn-1')).toBeLessThan(rejectingConfig.giveUpBudget)
    })
  })

  /**
   * Production case (2026-11-04): the chain still listed `mt-cc` long after that
   * provider had been removed from the host. The switch landed there, the host
   * answered `NO_ADAPTER`, and the turn died — a stale config entry took the
   * whole task down.
   */
  describe('dead channel (no adapter)', () => {
    const chainConfig: RecoveryPolicyConfig = {
      ...config,
      channels: [...config.channels, { id: C, provider: 'mt-cc', model: modelId('claude-3-5-haiku-latest') }],
    }

    it('fails over instead of ending the turn', () => {
      const engine = new RecoveryEngine(chainConfig, new MemoryStore(), { nowMs: () => 1000 })
      const plan = engine.onFailure(
        { code: 'NO_ADAPTER', channel: B, occurredAtMs: 1000 },
        undefined,
        'agent-1',
      )
      expect(plan.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: A } })
      expect(plan.verdict.kind).not.toBe('GIVE_UP')
      expect(engine.unusableFor('agent-1')).toEqual([B])
    })

    it('never returns to it for the rest of the conversation', () => {
      let now = 1000
      const engine = new RecoveryEngine(chainConfig, new MemoryStore(), { nowMs: () => now })
      engine.onFailure({ code: 'NO_ADAPTER', channel: C, occurredAtMs: now }, undefined, 'agent-1')
      expect(engine.unusableFor('agent-1')).toEqual([C])

      // After its cooldown expires the circuit would look routable again, but a
      // missing adapter does not appear on its own.
      now = 1000 + chainConfig.cooldownMs + 1
      const next = engine.onFailure(
        { code: 'TIMEOUT', channel: A, occurredAtMs: now, retryExhausted: true },
        undefined,
        'agent-1',
      )
      expect(next.verdict).toMatchObject({ kind: 'FAILOVER', target: { id: B } })
    })
  })

  describe('onSuccess', () => {
    it('resets a tripped channel to HEALTHY and persists it', () => {
      const store = new MemoryStore()
      let now = 1000
      const engine = new RecoveryEngine(config, store, { nowMs: () => now })
      engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: now })
      engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: now })
      engine.onFailure({ code: 'RATE_LIMIT', channel: A, occurredAtMs: now })
      expect(store.map.get(A)?.state).toBe('COOLDOWN')

      now = 5000
      engine.onSuccess(A)
      expect(store.map.get(A)).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0, cooldownUntilMs: 0 })
      expect(engine.listHealth().find((h) => h.channel === A)).toMatchObject({
        state: 'HEALTHY',
        failures: 0,
        cooldownUntilMs: 0,
      })
    })

    it('seeds fresh health for an untracked channel (stale out-of-chain backup)', () => {
      const store = new MemoryStore()
      const engine = new RecoveryEngine(config, store, { nowMs: () => 1000 })
      engine.onSuccess(C) // C is not in this engine's chain config
      expect(store.map.get(C)).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0 })
    })

    it('is idempotent for an already-healthy channel', () => {
      const store = new MemoryStore()
      const engine = new RecoveryEngine(config, store, { nowMs: () => 1000 })
      engine.onSuccess(A)
      engine.onSuccess(A)
      expect(store.map.get(A)).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0 })
    })
  })
})
