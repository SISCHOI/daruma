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
  /**
   * True when the host already spent this channel's same-channel retry budget on
   * the failure before handing it to the policy.
   *
   * Such a signal is not one request attempt: the host retried this channel and
   * it still failed. `decide()` therefore opens the circuit on it instead of
   * counting it as a single failure (see `tripOnRetryExhausted`). Absent when no
   * retry owner covered the route, or when that owner's policy is unbounded.
   */
  readonly retryExhausted?: boolean
}
