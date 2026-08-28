/**
 * Recovery decision engine — the heart of Daruma.
 *
 * `decide` is a pure function: same signal + same channel health + same
 * counters + same config → same `RecoveryPlan`. It never reads a clock,
 * never touches storage, never performs I/O.
 */

import type { Channel, ChannelId } from './channel.ts'
import {
  canRouteNow,
  freshHealth,
  recordFailure,
  trip,
  type ChannelHealth,
} from './channel-health.ts'
import type { RecoveryPolicyConfig } from './config.ts'
import { isTerminalCode } from './failure.ts'
import type { FailureSignal } from './signal.ts'

export type Verdict =
  | { readonly kind: 'RETRY_NOW' }
  | { readonly kind: 'FAILOVER'; readonly target: Channel }
  | { readonly kind: 'GIVE_UP'; readonly reason: string }

export interface RecoveryPlan {
  readonly verdict: Verdict
  /** Updated health of the channel that produced the failure. */
  readonly healthAfter: ChannelHealth
  /** Updated failover counter (incremented only on FAILOVER). */
  readonly failoverCount: number
}

export interface DecideInput {
  readonly signal: FailureSignal
  /** Health of every known channel, keyed by id. */
  readonly healths: ReadonlyMap<ChannelId, ChannelHealth>
  readonly failoverCount: number
  readonly config: RecoveryPolicyConfig
  readonly nowMs: number
  /** Optional user-chosen backup channel, tried before the fallback chain. */
  readonly preferred?: Channel
}

export function decide(input: DecideInput): RecoveryPlan {
  const { signal, healths, failoverCount, config, nowMs } = input
  const current = healths.get(signal.channel) ?? freshHealth(signal.channel, nowMs)

  const healthAfter = isTerminalCode(signal.code)
    ? trip(current, nowMs, config.cooldownMs)
    : recordFailure(current, nowMs, config.failureBudget, config.cooldownMs)

  // Still within this channel's failure budget → the host should retry the
  // same channel. (In DSH, the in-box `dsh-llm-retry` owns that retry.)
  if (healthAfter.state !== 'COOLDOWN') {
    return { verdict: { kind: 'RETRY_NOW' }, healthAfter, failoverCount }
  }

  if (failoverCount >= config.giveUpBudget) {
    return {
      verdict: { kind: 'GIVE_UP', reason: 'give-up-budget-exhausted' },
      healthAfter,
      failoverCount,
    }
  }

  const target = pickFallback(signal.channel, healths, config, nowMs, input.preferred)
  if (target === undefined) {
    return {
      verdict: { kind: 'GIVE_UP', reason: 'no-routable-fallback' },
      healthAfter,
      failoverCount,
    }
  }

  return {
    verdict: { kind: 'FAILOVER', target },
    healthAfter,
    failoverCount: failoverCount + 1,
  }
}

/**
 * Pick a failover target: the user-chosen `preferred` channel first (when it
 * is routable and not the failed channel), then the first routable channel in
 * priority order. A cooled-down channel whose cooldown expired is routable
 * (it becomes a probe target).
 */
export function pickFallback(
  failed: ChannelId,
  healths: ReadonlyMap<ChannelId, ChannelHealth>,
  config: RecoveryPolicyConfig,
  nowMs: number,
  preferred?: Channel,
): Channel | undefined {
  if (
    preferred !== undefined
    && preferred.id !== failed
    && canRouteNow(healths.get(preferred.id) ?? freshHealth(preferred.id, nowMs), nowMs)
  ) {
    return preferred
  }
  for (const channel of config.channels) {
    if (channel.id === failed) continue
    const health = healths.get(channel.id) ?? freshHealth(channel.id, nowMs)
    if (canRouteNow(health, nowMs)) return channel
  }
  return undefined
}
