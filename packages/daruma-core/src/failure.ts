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

/** Terminal failures: retrying the same channel cannot fix them. */
const TERMINAL_CODES: ReadonlySet<FailureCode> = new Set([
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_CREDENTIAL',
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
