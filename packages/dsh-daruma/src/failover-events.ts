/**
 * Durable `daruma/failover` session-event assembly.
 *
 * Kept a pure, framework-free module so the event contract is unit-testable
 * without mounting the host runtime. The event is appended to the agent's
 * session log at failover-decision time and survives in the zstd session
 * archive, giving every channel switch a traceable record (agent, turn, step,
 * failure detail, and budget state at the moment of the decision).
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Durable session event appended on every channel switch. */
export interface DarumaFailoverEvent {
  /** Channel id the request failed on, e.g. `mt::glm-5.3`. */
  readonly from: string
  /** Channel id recovery switched to. */
  readonly to: string
  /** Stable failure code, e.g. `RATE_LIMIT`. */
  readonly reason: string
  /** Epoch ms of the failover decision. */
  readonly at: number
  /** Agent that triggered the failover (its scope id). */
  readonly agentId: string
  /** Turn containing the failed request (1-based). */
  readonly turn: number
  /** Step containing the failed request attempt (1-based). */
  readonly step: number
  /** HTTP status of the failed request, when available. */
  readonly status?: number
  /** Provider-issued request id, when available (opaque diagnostic token). */
  readonly requestId?: string
  /** Human-readable failure detail, truncated for event size. */
  readonly message?: string
  /** Scope failover count AFTER this decision (1-based on first failover). */
  readonly failoverCount: number
  /** Scope give-up budget the count counts against. */
  readonly giveUpBudget: number
}

/** Cap on the failure-message detail stored in a session event. */
export const FAILOVER_MESSAGE_LIMIT = 300

/** Event data required from the decision site. */
export interface FailoverEventInput {
  readonly from: string
  readonly to: string
  readonly reason: string
  readonly at: number
  readonly agentId: string
  readonly turn: number
  readonly step: number
  readonly failure: Pick<LlmFailure, 'message'> & Partial<Pick<LlmFailure, 'status' | 'requestId'>>
  /** Scope failover count after the decision. */
  readonly failoverCount: number
  /** Scope give-up budget. */
  readonly giveUpBudget: number
}

function clip(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/** Assemble the durable failover event from decision-site facts.
 *
 * Absent optional fields are omitted (not set to `undefined`): the host's
 * session append validates data with a lossless-JSON snapshotter that rejects
 * own properties whose value is `undefined`, so the event must carry only
 * keys that actually have values.
 */
export function buildDarumaFailoverEvent(input: FailoverEventInput): DarumaFailoverEvent {
  const { failure } = input
  const message = clip(failure.message, FAILOVER_MESSAGE_LIMIT)
  return {
    from: input.from,
    to: input.to,
    reason: input.reason,
    at: input.at,
    agentId: input.agentId,
    turn: input.turn,
    step: input.step,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
    ...(message !== undefined ? { message } : {}),
    failoverCount: input.failoverCount,
    giveUpBudget: input.giveUpBudget,
  }
}

/** Why recovery gave up (mirrors the core engine's GIVE_UP reasons). */
export type DarumaGiveUpReason = 'give-up-budget-exhausted' | 'no-routable-fallback'

/** Durable session event appended when recovery gives up entirely. */
export interface DarumaGiveUpEvent {
  /** Discriminator-compatible shape with {@link DarumaFailoverEvent}. */
  readonly kind: 'give-up'
  /** Channel id the final failure occurred on. */
  readonly from: string
  /** {@link DarumaGiveUpReason}. */
  readonly reason: DarumaGiveUpReason
  /** Epoch ms of the give-up decision. */
  readonly at: number
  /** Agent whose recovery gave up (its scope id). */
  readonly agentId: string
  /** Turn containing the final failed request (1-based). */
  readonly turn: number
  /** Step containing the final failed request attempt (1-based). */
  readonly step: number
  /** Scope failover count at the give-up decision. */
  readonly failoverCount: number
  /** Scope give-up budget the count counted against. */
  readonly giveUpBudget: number
}

/** Event data required from the give-up decision site. */
export interface GiveUpEventInput {
  readonly from: string
  readonly reason: DarumaGiveUpReason
  readonly at: number
  readonly agentId: string
  readonly turn: number
  readonly step: number
  readonly failoverCount: number
  readonly giveUpBudget: number
}

/** Assemble the durable give-up event from decision-site facts. */
export function buildDarumaGiveUpEvent(input: GiveUpEventInput): DarumaGiveUpEvent {
  return { kind: 'give-up', ...input }
}
