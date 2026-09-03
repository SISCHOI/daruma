import { describe, expect, it } from 'vitest'
import type { ChannelHealthView } from './api.ts'
import { overallState } from './health.ts'

const NOW = 1_000_000

function view(state: ChannelHealthView['state'], cooldownUntilMs: number): ChannelHealthView {
  return { channel: 'mt::m', state, failures: 1, cooldownUntilMs }
}

describe('overallState', () => {
  it('returns ongoing while no snapshot exists', () => {
    expect(overallState(null, NOW)).toBe('ongoing')
  })

  it('is done when all channels are healthy', () => {
    expect(overallState([view('HEALTHY', 0)], NOW)).toBe('done')
  })

  it('is done when a cooldown has already expired', () => {
    expect(overallState([view('COOLDOWN', NOW - 1)], NOW)).toBe('done')
  })

  it('is error while any channel is still cooling', () => {
    expect(overallState([view('HEALTHY', 0), view('COOLDOWN', NOW + 5_000)], NOW)).toBe('error')
  })

  it('is warning while a probe is in flight', () => {
    expect(overallState([view('PROBE', 0)], NOW)).toBe('warning')
  })
})
