/**
 * RecoveryEngine — the adapter-side state holder that wraps the pure
 * `decide()` from daruma-core.
 *
 * It owns the mutable channel-health map and per-scope failover counters,
 * and persistence through a `ChannelHealthStore`. All decision logic stays in
 * daruma-core; this class only threads state and I/O.
 */

import {
  decide,
  freshHealth,
  type Channel,
  type ChannelHealth,
  type ChannelHealthStore,
  type ChannelId,
  type ChannelState,
  type Clock,
  type FailureSignal,
  type RecoveryPlan,
  type RecoveryPolicyConfig,
} from 'daruma-core'

const systemClock: Clock = { nowMs: () => Date.now() }

export interface ChannelHealthView {
  readonly channel: ChannelId
  readonly state: ChannelState
  readonly failures: number
  /** Epoch ms when the channel's cooldown ends; `0` when not cooling. */
  readonly cooldownUntilMs: number
}

export interface FailoverRecord {
  readonly from: string
  readonly to: string
  readonly reason: string
  readonly at: number
}

const FAILOVER_HISTORY_LIMIT = 5

export class RecoveryEngine {
  private readonly healths = new Map<ChannelId, ChannelHealth>()
  private failoverTotal = 0
  private readonly failoversByScope = new Map<string, number>()
  private readonly failoverHistory: FailoverRecord[] = []
  private readonly clock: Clock

  constructor(
    private readonly config: RecoveryPolicyConfig,
    private readonly store: ChannelHealthStore,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock
    this.preload()
  }

  /** Load every configured channel's persisted health into memory. */
  private preload(): void {
    for (const channel of this.config.channels) {
      if (this.healths.has(channel.id)) continue
      const stored = this.store.load(channel.id)
      this.healths.set(channel.id, stored ?? freshHealth(channel.id, this.clock.nowMs()))
    }
  }

  /** Feed one failure signal and persist the resulting state. `scope` should
   * identify an agent/session so independent tasks do not share a budget. */
  onFailure(signal: FailureSignal, preferred?: Channel, scope = 'global'): RecoveryPlan {
    const scopedCount = this.failoversByScope.get(scope) ?? 0
    const plan = decide({
      signal,
      healths: this.healths,
      failoverCount: scopedCount,
      config: this.config,
      nowMs: this.clock.nowMs(),
      ...(preferred !== undefined ? { preferred } : {}),
    })
    this.healths.set(signal.channel, plan.healthAfter)
    this.store.save(plan.healthAfter)
    if (plan.verdict.kind === 'FAILOVER') {
      this.failoversByScope.set(scope, plan.failoverCount)
      this.failoverTotal += 1
      this.failoverHistory.push({
        from: signal.channel,
        to: plan.verdict.target.id,
        reason: signal.code,
        at: this.clock.nowMs(),
      })
      if (this.failoverHistory.length > FAILOVER_HISTORY_LIMIT) {
        this.failoverHistory.shift()
      }
    }
    return plan
  }

  /** Release per-agent/session counters when the host disposes the scope. */
  clearScope(scope: string): void {
    this.failoversByScope.delete(scope)
  }

  /** Scope's failover count so far (0 when never failed over). */
  failoverCountFor(scope: string): number {
    return this.failoversByScope.get(scope) ?? 0
  }

  /** Per-scope give-up budget from config. */
  get giveUpBudget(): number {
    return this.config.giveUpBudget
  }

  /** Snapshot of every tracked channel's health, for the status UI. */
  listHealth(): ChannelHealthView[] {
    return [...this.healths.values()].map((health) => ({
      channel: health.channel,
      state: health.state,
      failures: health.consecutiveFailures,
      cooldownUntilMs: health.cooldownUntilMs,
    }))
  }

  get failoverCount(): number {
    return this.failoverTotal
  }

  /** Configured failover channels (for provider discovery). */
  get channels(): readonly Channel[] {
    return this.config.channels
  }

  /** Recent failovers, newest last (bounded). */
  get history(): readonly FailoverRecord[] {
    return this.failoverHistory
  }
}
