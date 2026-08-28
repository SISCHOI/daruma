/**
 * RecoveryEngine — the adapter-side state holder that wraps the pure
 * `decide()` from daruma-core.
 *
 * It owns the mutable channel-health map, the per-session failover counter,
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

  /** Feed one failure signal and persist the resulting state. */
  onFailure(signal: FailureSignal, preferred?: Channel): RecoveryPlan {
    const plan = decide({
      signal,
      healths: this.healths,
      failoverCount: this.failoverTotal,
      config: this.config,
      nowMs: this.clock.nowMs(),
      ...(preferred !== undefined ? { preferred } : {}),
    })
    this.healths.set(signal.channel, plan.healthAfter)
    this.store.save(plan.healthAfter)
    if (plan.verdict.kind === 'FAILOVER') {
      this.failoverTotal = plan.failoverCount
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

  /** Snapshot of every tracked channel's health, for the status UI. */
  listHealth(): ChannelHealthView[] {
    return [...this.healths.values()].map((health) => ({
      channel: health.channel,
      state: health.state,
      failures: health.consecutiveFailures,
    }))
  }

  get failoverCount(): number {
    return this.failoverTotal
  }

  /** Recent failovers, newest last (bounded). */
  get history(): readonly FailoverRecord[] {
    return this.failoverHistory
  }
}
