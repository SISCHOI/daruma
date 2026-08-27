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
}

export const DEFAULT_CONFIG: Readonly<RecoveryPolicyConfig> = {
  channels: [],
  failureBudget: 3,
  cooldownMs: 30_000,
  giveUpBudget: 8,
}
