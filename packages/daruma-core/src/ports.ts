/**
 * Ports (interfaces) the domain depends on.
 *
 * These are defined here and implemented by the host adapter (`dsh-daruma`).
 * The domain never imports an implementation.
 */

import type { ChannelId } from './channel.ts'
import type { ChannelHealth } from './channel-health.ts'

/** Injectable time source, so decisions are deterministic under test. */
export interface Clock {
  nowMs(): number
}

/** Persistence for channel health, so circuit state survives restarts. */
export interface ChannelHealthStore {
  load(channel: ChannelId): ChannelHealth | undefined
  save(health: ChannelHealth): void
}
