/**
 * Recovery policy configuration.
 */

import type { Channel } from './channel.ts'

export interface RecoveryPolicyConfig {
  /** Ordered failover chain, highest priority first. */
  readonly channels: readonly Channel[]
  /** Consecutive failures before a channel's circuit opens. */
  readonly failureBudget: number
  /** Circuit-open duration in ms. */
  readonly cooldownMs: number
  /** Maximum failovers before giving up entirely. */
  readonly giveUpBudget: number
  /**
   * Whether a failure that already exhausted the host's same-channel retry
   * budget opens the circuit by itself. Defaults to `true`.
   *
   * `true`: retry spent its whole budget on this channel and it still failed, so
   * the signal already stands for a whole retry sequence — the strongest
   * evidence a single failure can carry. Counting it as one attempt instead made
   * the commonest failure (`RATE_LIMIT`) cost one failing *turn* per unit, so a
   * saturated channel outlived `failureBudget` turns while a terminal code
   * switched on the first.
   * `false`: restore plain counting against `failureBudget`.
   */
  readonly tripOnRetryExhausted?: boolean
}

export const DEFAULT_CONFIG: Readonly<RecoveryPolicyConfig> = {
  channels: [],
  failureBudget: 3,
  cooldownMs: 30_000,
  giveUpBudget: 8,
  tripOnRetryExhausted: true,
}
