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

export function isRetryableCode(code: FailureCode): boolean {
  // UNKNOWN is treated as retryable (conservative): try once more rather
  // than immediately burning a channel.
  return RETRYABLE_CODES.has(code) || code === 'UNKNOWN'
}

export function isTerminalCode(code: FailureCode): boolean {
  return TERMINAL_CODES.has(code)
}
