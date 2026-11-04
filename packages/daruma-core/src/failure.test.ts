import { describe, expect, it } from 'vitest'
import {
  excludesChannelForSession,
  FAILURE_CODES,
  isRequestScopedCode,
  isRetryableCode,
  isTerminalCode,
} from './failure.ts'
import type { FailureCode } from './failure.ts'

describe('failure taxonomy', () => {
  const retryable: FailureCode[] = [
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
    'UNKNOWN',
  ]
  const terminal: FailureCode[] = [
    'QUOTA',
    'CONTEXT_WINDOW_EXCEEDED',
    'INVALID_CREDENTIAL',
    'NO_ADAPTER',
  ]
  const requestScoped: FailureCode[] = ['INVALID_REQUEST']

  it.each(retryable)('classifies %s as retryable', (code) => {
    expect(isRetryableCode(code)).toBe(true)
    expect(isTerminalCode(code)).toBe(false)
    expect(isRequestScopedCode(code)).toBe(false)
    expect(excludesChannelForSession(code)).toBe(false)
  })

  it.each(terminal)('classifies %s as terminal', (code) => {
    expect(isTerminalCode(code)).toBe(true)
    expect(isRetryableCode(code)).toBe(false)
    expect(isRequestScopedCode(code)).toBe(false)
  })

  it.each(requestScoped)('classifies %s as scoped to one conversation', (code) => {
    expect(isRequestScopedCode(code)).toBe(true)
    // Neither: the channel is fine, and retrying the same request is not.
    expect(isRetryableCode(code)).toBe(false)
    expect(isTerminalCode(code)).toBe(false)
  })

  it('puts every code in exactly one bucket', () => {
    for (const code of FAILURE_CODES) {
      const buckets = [isRetryableCode(code), isTerminalCode(code), isRequestScopedCode(code)]
        .filter(Boolean)
      expect(buckets, code).toHaveLength(1)
    }
  })

  it('drops a no-adapter channel from the rest of the conversation', () => {
    // A missing adapter is not repaired by a cooldown expiring, so the channel
    // must not be re-probed inside the same turn (production case 2026-11-04).
    expect(excludesChannelForSession('NO_ADAPTER')).toBe(true)
    expect(excludesChannelForSession('INVALID_REQUEST')).toBe(true)
    // Ordinary terminal codes may recover once the user tops up or fixes a key.
    expect(excludesChannelForSession('QUOTA')).toBe(false)
    expect(excludesChannelForSession('TIMEOUT')).toBe(false)
  })
})
