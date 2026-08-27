import { describe, expect, it } from 'vitest'
import { backoffDelayMs, DEFAULT_BACKOFF } from './backoff.ts'

describe('backoff', () => {
  it('grows exponentially from the initial delay', () => {
    // rand() == 0.5 → jitter term is 0 (symmetric jitter midpoint).
    const rand = () => 0.5
    expect(backoffDelayMs(DEFAULT_BACKOFF, 0, rand)).toBe(500)
    expect(backoffDelayMs(DEFAULT_BACKOFF, 1, rand)).toBe(1000)
    expect(backoffDelayMs(DEFAULT_BACKOFF, 2, rand)).toBe(2000)
  })

  it('caps at maxDelayMs', () => {
    const rand = () => 0.5
    expect(backoffDelayMs(DEFAULT_BACKOFF, 20, rand)).toBe(DEFAULT_BACKOFF.maxDelayMs)
  })

  it('is bounded within [base - jitter, base + jitter]', () => {
    const plan = { ...DEFAULT_BACKOFF, initialDelayMs: 1000, jitterRatio: 0.2 }
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = Math.min(1000 * 2 ** attempt, plan.maxDelayMs)
      for (let i = 0; i < 100; i++) {
        const d = backoffDelayMs(plan, attempt, Math.random)
        expect(d).toBeGreaterThanOrEqual(Math.round(base - base * 0.2))
        expect(d).toBeLessThanOrEqual(Math.round(base + base * 0.2))
      }
    }
  })

  it('never returns a negative delay', () => {
    const rand = () => 0
    expect(backoffDelayMs({ initialDelayMs: 100, maxDelayMs: 100, multiplier: 1, jitterRatio: 1 }, 0, rand)).toBeGreaterThanOrEqual(0)
  })
})
