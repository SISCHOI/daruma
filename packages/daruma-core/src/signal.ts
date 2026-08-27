/**
 * A single observable failure, translated into the domain taxonomy.
 */

import type { ChannelId } from './channel.ts'
import type { FailureCode } from './failure.ts'

export interface FailureSignal {
  readonly code: FailureCode
  /** HTTP status when the failure came from an HTTP provider. */
  readonly status?: number
  /** Which channel the failure belongs to. */
  readonly channel: ChannelId
  /** Epoch ms, from the injected clock. */
  readonly occurredAtMs: number
  /** Human-readable detail for diagnostics; never parsed for decisions. */
  readonly message?: string
}
