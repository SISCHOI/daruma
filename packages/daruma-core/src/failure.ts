/**
 * Provider-neutral failure taxonomy for Daruma.
 *
 * These codes mirror DeepSeek Harness's canonical model-request failure
 * classes. The DSH adapter translates `LlmFailure.code` into these codes —
 * never the other way around.
 */

export const FAILURE_CODES = [
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_CREDENTIAL',
  'INVALID_REQUEST',
  'NO_ADAPTER',
  'UNKNOWN',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

/** Transient failures worth retrying on the same channel. */
const RETRYABLE_CODES: ReadonlySet<FailureCode> = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/**
 * Terminal failures: retrying the same channel cannot fix them.
 *
 * `NO_ADAPTER` means the host has no adapter registered for the channel's
 * provider — a stale failover-chain entry, not a bad request. Nothing the
 * channel does will change that inside this process, so it must be skipped just
 * like a quota or credential failure instead of being counted as a transient
 * one (the production case, 2026-11-04: a chain still listing `mt-cc` long
 * after that provider was removed killed the turn with `NO_ADAPTER`).
 */
const TERMINAL_CODES: ReadonlySet<FailureCode> = new Set([
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_CREDENTIAL',
  'NO_ADAPTER',
])

/**
 * Failures the provider raised against the *request* rather than the channel.
 *
 * A provider that refuses one conversation's shape (the production case:
 * DeepSeek's Messages API rejects an assistant turn carrying `tool_use` but no
 * `thinking` block while thinking mode is on) answers `400 INVALID_REQUEST`.
 * The channel itself keeps serving every other session, so benching it with a
 * global cooldown would take a healthy route out of service; the honest
 * response is to drop that channel for this conversation only.
 */
const REQUEST_SCOPED_CODES: ReadonlySet<FailureCode> = new Set(['INVALID_REQUEST'])

/**
 * Terminal failures that also rule the channel out for the rest of this
 * conversation: a cooldown expiring does not give a missing adapter a way to
 * appear, so re-probing it inside the same turn only kills the turn again.
 */
const SESSION_EXCLUDED_CODES: ReadonlySet<FailureCode> = new Set(['NO_ADAPTER'])

export function isRetryableCode(code: FailureCode): boolean {
  // UNKNOWN is treated as retryable (conservative): try once more rather
  // than immediately burning a channel.
  return RETRYABLE_CODES.has(code) || code === 'UNKNOWN'
}

export function isTerminalCode(code: FailureCode): boolean {
  return TERMINAL_CODES.has(code)
}

/**
 * Whether this failure excludes its channel from the current conversation only,
 * leaving channel health untouched.
 */
export function isRequestScopedCode(code: FailureCode): boolean {
  return REQUEST_SCOPED_CODES.has(code)
}

/** Whether this failure should drop its channel from the rest of the conversation. */
export function excludesChannelForSession(code: FailureCode): boolean {
  return REQUEST_SCOPED_CODES.has(code) || SESSION_EXCLUDED_CODES.has(code)
}
