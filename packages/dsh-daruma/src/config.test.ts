import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultLogFile, defaultStateFile } from './config.ts'
import { resolveConfig } from './config.ts'

describe('defaultStateFile', () => {
  it('honors an explicit $DSH_HOME so isolated profiles stay isolated', () => {
    const home = join('tmp', 'dsh-home')
    expect(defaultStateFile({ DSH_HOME: home })).toBe(join(home, 'daruma', 'channel-health.json'))
  })

  it('ignores a blank $DSH_HOME, like the host does', () => {
    const fallback = join(homedir(), '.dsh', 'daruma', 'channel-health.json')
    expect(defaultStateFile({ DSH_HOME: '' })).toBe(fallback)
    expect(defaultStateFile({ DSH_HOME: '   ' })).toBe(fallback)
    expect(defaultStateFile({})).toBe(fallback)
  })
})

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    const config = resolveConfig({})
    expect(config.channels).toEqual([])
    expect(config.failureBudget).toBe(3)
    expect(config.cooldownMs).toBe(30_000)
    expect(config.giveUpBudget).toBe(8)
    expect(config.stateFile).toContain('channel-health.json')
    // Default log lives next to the default state file.
    expect(config.logFile).toContain('failover-log.jsonl')
    expect(config.logFile).toBe(config.stateFile.replace('channel-health.json', 'failover-log.jsonl'))
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
    // logFile defaults next to an isolated stateFile, or can be pinned.
    // (dirname/join normalize separators on Windows, so compare via the helper)
    expect(config.logFile).toBe(defaultLogFile('/tmp/daruma.json'))
    expect(config.logFile.endsWith('failover-log.jsonl')).toBe(true)
    const pinned = resolveConfig({ stateFile: '/tmp/daruma.json', logFile: '/var/log/daruma.jsonl' })
    expect(pinned.logFile).toBe('/var/log/daruma.jsonl')
  })

  it('rejects unsafe thresholds and malformed channels', () => {
    expect(() => resolveConfig({ failureBudget: 0 })).toThrow(/failureBudget/)
    expect(() => resolveConfig({ cooldownMs: Number.NaN })).toThrow(/cooldownMs/)
    expect(() => resolveConfig({ channels: [{ provider: '', model: 'x' }] })).toThrow(/channel/)
    expect(() => resolveConfig({
      channels: [
        { provider: 'mt', model: 'x' },
        { provider: 'mt', model: 'x' },
      ],
    })).toThrow(/duplicate/)
    expect(() => resolveConfig([] as never)).toThrow(/expected an object/)
    expect(() => resolveConfig({ logFile: '' })).toThrow(/logFile/)
    expect(() => resolveConfig({ logFile: 42 as never })).toThrow(/logFile/)
  })
})
