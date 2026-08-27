import { describe, expect, it } from 'vitest'
import { channelIdOf, channelIdOfConfig, toCallConfig, toFailureCode, toFailureSignal } from './mapping.ts'
import { channelId, modelId, type Channel } from 'daruma-core'

describe('mapping', () => {
  it('maps known DSH codes to the domain taxonomy', () => {
    expect(toFailureCode('RATE_LIMIT')).toBe('RATE_LIMIT')
    expect(toFailureCode('SERVER')).toBe('SERVER')
    expect(toFailureCode('QUOTA')).toBe('QUOTA')
  })

  it('downgrades unknown codes to UNKNOWN', () => {
    expect(toFailureCode('NO_ADAPTER')).toBe('UNKNOWN')
    expect(toFailureCode('ABORTED')).toBe('UNKNOWN')
  })

  it('derives channel id from provider and model', () => {
    expect(channelIdOf('mt', 'deepseek-v4-pro')).toBe('mt::deepseek-v4-pro')
    expect(channelIdOf('mt', '')).toBe('mt')
  })

  it('derives channel id from a request config', () => {
    expect(channelIdOfConfig({ provider: 'mt', model: 'glm-5.2' })).toBe('mt::glm-5.2')
  })

  it('builds a failure signal with status and message', () => {
    const signal = toFailureSignal(
      { code: 'RATE_LIMIT', status: 429, message: 'too fast' },
      channelId('mt::deepseek-v4-pro'),
      1234,
    )
    expect(signal).toEqual({
      code: 'RATE_LIMIT',
      status: 429,
      channel: 'mt::deepseek-v4-pro',
      occurredAtMs: 1234,
      message: 'too fast',
    })
  })

  it('swaps a request config onto a failover target', () => {
    const target: Channel = { id: channelId('mt::glm-5.2'), provider: 'mt', model: modelId('glm-5.2') }
    const swapped = toCallConfig(
      { provider: 'mt', model: 'deepseek-v4-pro', maxTokens: 4096 },
      target,
    )
    expect(swapped.provider).toBe('mt')
    expect(swapped.model).toBe('glm-5.2')
    expect(swapped.maxTokens).toBe(4096)
  })
})
