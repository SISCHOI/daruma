/**
 * Time-aware channel-health classification for the status dock.
 *
 * The host exposes no request-success event, so a channel whose cooldown has
 * expired keeps its `COOLDOWN` state field forever — it becomes routable again
 * (`canRouteNow`) without ever flipping back to `HEALTHY`. The dock therefore
 * must judge by time, not by the raw state field: only a channel that is
 * *still* cooling (cooldown not yet expired) counts as an error.
 */

import type { ChannelHealthView } from './api.ts'

export type Dot = 'done' | 'warning' | 'ongoing' | 'error'

/**
 * Overall dock state:
 * - `error`    — at least one channel is still cooling (`cooldownUntilMs > now`).
 * - `warning`  — a probe is in flight (kept for parity; the adapter no longer
 *                enters PROBE, but persisted legacy states may surface it).
 * - `done`     — everything routable: healthy, or cooled down long enough.
 * - `ongoing`  — no snapshot yet.
 */
export function overallState(
  channels: readonly ChannelHealthView[] | null,
  nowMs: number,
): Dot {
  if (channels === null) return 'ongoing'
  if (channels.some((c) => c.state === 'COOLDOWN' && c.cooldownUntilMs > nowMs)) return 'error'
  if (channels.some((c) => c.state === 'PROBE')) return 'warning'
  return 'done'
}
