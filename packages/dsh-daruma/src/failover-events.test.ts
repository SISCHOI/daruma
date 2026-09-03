import { describe, expect, it } from 'vitest'
import { FAILOVER_MESSAGE_LIMIT, buildDarumaFailoverEvent } from './failover-events.ts'

function input(overrides: Record<string, unknown> = {}) {
  return {
    from: 'mt::glm-5.3',
    to: 'deepseek-official::deepseek-v4-flash',
    reason: 'RATE_LIMIT',
    at: 1_000,
    agentId: 'agent-1',
    turn: 3,
    step: 2,
    failure: { message: 'rate limited', status: 429 },
    failoverCount: 2,
    giveUpBudget: 8,
    ...overrides,
  }
}

describe('buildDarumaFailoverEvent', () => {
  it('carries the routing decision and its position', () => {
    const event = buildDarumaFailoverEvent(input())
    expect(event).toMatchObject({
      from: 'mt::glm-5.3',
      to: 'deepseek-official::deepseek-v4-flash',
      reason: 'RATE_LIMIT',
      at: 1_000,
      agentId: 'agent-1',
      turn: 3,
      step: 2,
      status: 429,
      message: 'rate limited',
      failoverCount: 2,
      giveUpBudget: 8,
    })
  })

  it('passes an optional provider request id through', () => {
    const event = buildDarumaFailoverEvent(input({ failure: { message: 'x', requestId: 'req_123' } }))
    expect(event.requestId).toBe('req_123')
  })

  it('truncates an oversized failure message', () => {
    const long = 'x'.repeat(FAILOVER_MESSAGE_LIMIT + 100)
    const event = buildDarumaFailoverEvent(input({ failure: { message: long } }))
    expect(event.message?.length).toBeLessThanOrEqual(FAILOVER_MESSAGE_LIMIT + 1) // +1 for the ellipsis char
    expect(event.message?.endsWith('…')).toBe(true)
  })

  it('omits absent optional failure fields', () => {
    const event = buildDarumaFailoverEvent(input({ failure: {} }))
    expect(event.status).toBeUndefined()
    expect(event.requestId).toBeUndefined()
    expect(event.message).toBeUndefined()
  })
})
