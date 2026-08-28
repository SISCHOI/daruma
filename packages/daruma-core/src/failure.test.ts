import { describe, expect, it } from 'vitest'
import { isRetryableCode, isTerminalCode } from './failure.ts'
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

  it.each(retryable)('classifies %s as retryable', (code) => {
    expect(isRetryableCode(code)).toBe(true)
    expect(isTerminalCode(code)).toBe(false)
  })

  it.each(terminal)('classifies %s as terminal', (code) => {
    expect(isTerminalCode(code)).toBe(true)
    expect(isRetryableCode(code)).toBe(false)
  })
})
