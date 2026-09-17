import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './config.ts'

describe('DEFAULT_CONFIG', () => {
  it('escalates an exhausted retry by default', () => {
    // The default is the fix, not an opt-in: a host that already spent its
    // same-channel retry budget has stronger evidence than one failed attempt,
    // and the counting default is what let RATE_LIMIT outlive the budget.
    expect(DEFAULT_CONFIG.tripOnRetryExhausted).toBe(true)
  })

  it('keeps the documented budgets', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      channels: [],
      failureBudget: 3,
      cooldownMs: 30_000,
      giveUpBudget: 8,
    })
  })
})
