/**
 * Ports (interfaces) the domain depends on.
 *
 * These are defined here and implemented by host adapters (`dsh-daruma`,
 * `daruma-watch`). The domain never imports an implementation.
 */

import type { Channel, ChannelId } from './channel.ts'
import type { ChannelHealth } from './channel-health.ts'
import type { FailureSignal } from './signal.ts'

/** Injectable time source, so decisions are deterministic under test. */
export interface Clock {
  nowMs(): number
}

/** Persistence for channel health, so circuit state survives restarts. */
export interface ChannelHealthStore {
  load(channel: ChannelId): ChannelHealth | undefined
  save(health: ChannelHealth): void
}

/** Active probe: is a channel reachable right now? */
export interface HealthProbe {
  probe(channel: Channel): Promise<boolean>
}

/**
 * A failure signal producer (DSH event listener, process watcher, log tail).
 * Returns an unsubscribe disposer.
 */
export interface SignalSource {
  onSignal(handler: (signal: FailureSignal) => void): () => void
}
