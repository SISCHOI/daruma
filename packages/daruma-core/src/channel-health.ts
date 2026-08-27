/**
 * Channel health state machine (circuit breaker).
 *
 * States:
 * - `HEALTHY`   — accepting traffic, counting consecutive failures.
 * - `COOLDOWN`  — circuit open; no routing until `cooldownUntilMs` passes.
 * - `PROBE`     — half-open; a trial request is in flight.
 *
 * All functions are pure: they take the prior `ChannelHealth` and return a
 * new one. Time is always passed in, never read from a global clock.
 */

import type { ChannelId } from './channel.ts'

export type ChannelState = 'HEALTHY' | 'COOLDOWN' | 'PROBE'

export interface ChannelHealth {
  readonly channel: ChannelId
  readonly state: ChannelState
  readonly consecutiveFailures: number
  /** Epoch ms; `0` when not cooling. */
  readonly cooldownUntilMs: number
  readonly updatedAtMs: number
}

export function freshHealth(channel: ChannelId, nowMs: number): ChannelHealth {
  return {
    channel,
    state: 'HEALTHY',
    consecutiveFailures: 0,
    cooldownUntilMs: 0,
    updatedAtMs: nowMs,
  }
}

/**
 * Whether a request may be routed to this channel right now.
 * A `COOLDOWN` channel becomes routable again once its cooldown expires
 * (the caller transitions it to `PROBE` via `beginProbe` before sending).
 */
export function canRouteNow(health: ChannelHealth, nowMs: number): boolean {
  switch (health.state) {
    case 'HEALTHY':
    case 'PROBE':
      return true
    case 'COOLDOWN':
      return health.cooldownUntilMs <= nowMs
  }
}

export function shouldBeginProbe(health: ChannelHealth, nowMs: number): boolean {
  return health.state === 'COOLDOWN' && health.cooldownUntilMs <= nowMs
}

export function beginProbe(health: ChannelHealth, nowMs: number): ChannelHealth {
  return { ...health, state: 'PROBE', updatedAtMs: nowMs }
}

/**
 * Record a failure. Increments the consecutive-failure counter and opens the
 * circuit when the budget is reached. A failure during `PROBE` re-opens the
 * circuit immediately.
 */
export function recordFailure(
  health: ChannelHealth,
  nowMs: number,
  failureBudget: number,
  cooldownMs: number,
): ChannelHealth {
  const failures = health.consecutiveFailures + 1
  if (health.state === 'PROBE' || failures >= failureBudget) {
    return {
      ...health,
      state: 'COOLDOWN',
      consecutiveFailures: failures,
      cooldownUntilMs: nowMs + cooldownMs,
      updatedAtMs: nowMs,
    }
  }
  return { ...health, consecutiveFailures: failures, updatedAtMs: nowMs }
}

/**
 * Open the circuit immediately, regardless of the failure budget. Used for
 * terminal failures (quota / invalid credential / context overflow) that a
 * retry can never repair.
 */
export function trip(
  health: ChannelHealth,
  nowMs: number,
  cooldownMs: number,
): ChannelHealth {
  return {
    ...health,
    state: 'COOLDOWN',
    consecutiveFailures: health.consecutiveFailures + 1,
    cooldownUntilMs: nowMs + cooldownMs,
    updatedAtMs: nowMs,
  }
}

/** Record a success; closes the circuit and resets the counter. */
export function recordSuccess(health: ChannelHealth, nowMs: number): ChannelHealth {
  return {
    ...health,
    state: 'HEALTHY',
    consecutiveFailures: 0,
    cooldownUntilMs: 0,
    updatedAtMs: nowMs,
  }
}
