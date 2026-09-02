import { describe, expect, it } from 'vitest'
import { channelId } from './channel.ts'
import {
  beginProbe,
  canRouteNow,
  freshHealth,
  recordFailure,
  recordSuccess,
  shouldBeginProbe,
  trip,
} from './channel-health.ts'

const CH = channelId('ch-a')
const BUDGET = 3
const COOLDOWN = 30_000

describe('channel health state machine', () => {
  it('starts HEALTHY and routable with zero failures', () => {
    const h = freshHealth(CH, 0)
    expect(h.state).toBe('HEALTHY')
    expect(h.consecutiveFailures).toBe(0)
    expect(canRouteNow(h, 0)).toBe(true)
  })

  it('counts failures below budget without opening the circuit', () => {
    let h = freshHealth(CH, 0)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    expect(h.state).toBe('HEALTHY')
    expect(h.consecutiveFailures).toBe(1)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    expect(h.state).toBe('HEALTHY')
    expect(h.consecutiveFailures).toBe(2)
    expect(canRouteNow(h, 0)).toBe(true)
  })

  it('opens the circuit when the failure budget is reached', () => {
    let h = freshHealth(CH, 0)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    expect(h.state).toBe('COOLDOWN')
    expect(h.consecutiveFailures).toBe(3)
    expect(h.cooldownUntilMs).toBe(COOLDOWN)
    expect(canRouteNow(h, 0)).toBe(false)
  })

  it('does not route during cooldown, then allows a probe after expiry', () => {
    let h = freshHealth(CH, 0)
    h = trip(h, 0, COOLDOWN)
    expect(canRouteNow(h, COOLDOWN - 1)).toBe(false)
    expect(shouldBeginProbe(h, COOLDOWN - 1)).toBe(false)
    expect(canRouteNow(h, COOLDOWN)).toBe(true)
    expect(shouldBeginProbe(h, COOLDOWN)).toBe(true)
  })

  it('PROBE → success closes the circuit and resets failures', () => {
    let h = freshHealth(CH, 0)
    h = trip(h, 0, COOLDOWN)
    h = beginProbe(h, COOLDOWN)
    expect(h.state).toBe('PROBE')
    h = recordSuccess(h, COOLDOWN + 1)
    expect(h.state).toBe('HEALTHY')
    expect(h.consecutiveFailures).toBe(0)
    expect(h.cooldownUntilMs).toBe(0)
  })

  it('allows routing while a probe is in flight until a success/failure hook resolves it', () => {
    const h = beginProbe(trip(freshHealth(CH, 0), 0, COOLDOWN), COOLDOWN)
    expect(canRouteNow(h, COOLDOWN)).toBe(true)
  })

  it('PROBE → failure re-opens the circuit', () => {
    let h = freshHealth(CH, 0)
    h = trip(h, 0, COOLDOWN)
    h = beginProbe(h, COOLDOWN)
    h = recordFailure(h, COOLDOWN + 1, BUDGET, COOLDOWN)
    expect(h.state).toBe('COOLDOWN')
    expect(h.cooldownUntilMs).toBe(COOLDOWN + 1 + COOLDOWN)
  })

  it('trip opens the circuit immediately regardless of budget', () => {
    const h = trip(freshHealth(CH, 0), 500, COOLDOWN)
    expect(h.state).toBe('COOLDOWN')
    expect(h.consecutiveFailures).toBe(1)
    expect(h.cooldownUntilMs).toBe(500 + COOLDOWN)
  })

  it('success on HEALTHY resets the counter', () => {
    let h = freshHealth(CH, 0)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    h = recordFailure(h, 0, BUDGET, COOLDOWN)
    h = recordSuccess(h, 10)
    expect(h.state).toBe('HEALTHY')
    expect(h.consecutiveFailures).toBe(0)
  })
})
