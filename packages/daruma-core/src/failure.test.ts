import { describe, expect, it } from 'vitest'
import { FAILURE_CODES, isRequestScopedCode, isRetryableCode, isTerminalCode } from './failure.ts'
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
  ]
  const requestScoped: FailureCode[] = ['INVALID_REQUEST']

  it.each(retryable)('classifies %s as retryable', (code) => {
    expect(isRetryableCode(code)).toBe(true)
    expect(isTerminalCode(code)).toBe(false)
    expect(isRequestScopedCode(code)).toBe(false)
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
})
