/**
 * Bounded exponential backoff with symmetric jitter.
 *
 * `backoffDelayMs` takes an injected `rand` so callers can keep it
 * deterministic in tests and random in production. `attempt` is zero-based.
 */

export interface BackoffPlan {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly multiplier: number
  readonly jitterRatio: number
}

export const DEFAULT_BACKOFF: Readonly<BackoffPlan> = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.1,
}

export function backoffDelayMs(
  plan: BackoffPlan,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const base = plan.initialDelayMs * Math.pow(plan.multiplier, attempt)
  const capped = Math.min(base, plan.maxDelayMs)
  const jitter = capped * plan.jitterRatio * (rand() * 2 - 1)
  return Math.max(0, Math.round(capped + jitter))
}
