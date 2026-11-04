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
import { isRequestScopedCode, isTerminalCode } from './failure.ts'
import type { FailureSignal } from './signal.ts'

const NO_CHANNELS: ReadonlySet<ChannelId> = new Set()

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
  /**
   * Channels this conversation already proved it cannot use. Request-scoped
   * rejections accumulate here so the same dead route is not re-chosen on every
   * step of one turn.
   */
  readonly unusableChannels?: ReadonlySet<ChannelId>
}

/**
 * Whether this failure opens the circuit on its own, instead of spending budget.
 *
 * Two kinds do:
 * - terminal codes (`QUOTA` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`):
 *   a same-channel retry can never repair them;
 * - a failure the host already retried to exhaustion (`retryExhausted`): retry
 *   spent its entire budget on this channel and the channel still failed, so the
 *   signal already carries a retry sequence rather than one attempt.
 *
 * `tripOnRetryExhausted: false` restores counting for the second kind.
 */
function tripsCircuit(signal: FailureSignal, config: RecoveryPolicyConfig): boolean {
  if (isTerminalCode(signal.code)) return true
  return config.tripOnRetryExhausted !== false && signal.retryExhausted === true
}

export function decide(input: DecideInput): RecoveryPlan {
  const { signal, healths, failoverCount, config, nowMs } = input
  const current = healths.get(signal.channel) ?? freshHealth(signal.channel, nowMs)

  // The provider refused this request, not this channel. Burning the channel
  // with a global cooldown would bench a route that serves everyone else, so
  // health stays as it is and only this conversation's routing loses it.
  if (isRequestScopedCode(signal.code)) {
    if (failoverCount >= config.giveUpBudget) {
      return {
        verdict: { kind: 'GIVE_UP', reason: 'give-up-budget-exhausted' },
        healthAfter: current,
        failoverCount,
      }
    }

    const unusable = new Set(input.unusableChannels ?? NO_CHANNELS)
    unusable.add(signal.channel)
    const target = pickFallback(signal.channel, healths, config, nowMs, input.preferred, unusable)
    if (target === undefined) {
      return {
        verdict: { kind: 'GIVE_UP', reason: 'no-routable-fallback' },
        healthAfter: current,
        failoverCount,
      }
    }

    return {
      verdict: { kind: 'FAILOVER', target },
      healthAfter: current,
      failoverCount: failoverCount + 1,
    }
  }

  const healthAfter = tripsCircuit(signal, config)
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

  const target = pickFallback(
    signal.channel,
    healths,
    config,
    nowMs,
    input.preferred,
    input.unusableChannels ?? NO_CHANNELS,
  )
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
 * is routable, not the failed channel, and not ruled out for this
 * conversation), then the first routable channel in priority order. A
 * cooled-down channel whose cooldown expired is routable (it becomes a probe
 * target).
 */
export function pickFallback(
  failed: ChannelId,
  healths: ReadonlyMap<ChannelId, ChannelHealth>,
  config: RecoveryPolicyConfig,
  nowMs: number,
  preferred?: Channel,
  unusable: ReadonlySet<ChannelId> = NO_CHANNELS,
): Channel | undefined {
  if (
    preferred !== undefined
    && preferred.id !== failed
    && !unusable.has(preferred.id)
    && canRouteNow(healths.get(preferred.id) ?? freshHealth(preferred.id, nowMs), nowMs)
  ) {
    return preferred
  }
  for (const channel of config.channels) {
    if (channel.id === failed) continue
    if (unusable.has(channel.id)) continue
    const health = healths.get(channel.id) ?? freshHealth(channel.id, nowMs)
    if (canRouteNow(health, nowMs)) return channel
  }
  return undefined
}
