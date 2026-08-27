import { describe, expect, it } from 'vitest'
import { resolveConfig } from './config.ts'

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    const config = resolveConfig({})
    expect(config.channels).toEqual([])
    expect(config.failureBudget).toBe(3)
    expect(config.cooldownMs).toBe(30_000)
    expect(config.giveUpBudget).toBe(8)
    expect(config.stateFile).toContain('channel-health.json')
  })

  it('derives channel ids from provider/model pairs', () => {
    const config = resolveConfig({
      channels: [
        { provider: 'mt', model: 'deepseek-v4-pro' },
        { provider: 'mt', model: 'glm-5.2' },
      ],
    })
    expect(config.channels.map((c) => c.id)).toEqual([
      'mt::deepseek-v4-pro',
      'mt::glm-5.2',
    ])
  })

  it('honors explicit thresholds and state file', () => {
    const config = resolveConfig({
      failureBudget: 5,
      cooldownMs: 60_000,
      giveUpBudget: 2,
      stateFile: '/tmp/daruma.json',
    })
    expect(config.failureBudget).toBe(5)
    expect(config.cooldownMs).toBe(60_000)
    expect(config.giveUpBudget).toBe(2)
    expect(config.stateFile).toBe('/tmp/daruma.json')
  })
})
