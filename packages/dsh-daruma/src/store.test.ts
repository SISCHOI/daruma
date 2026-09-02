import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { channelId } from 'daruma-core'
import { JsonFileChannelHealthStore } from './store.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('JsonFileChannelHealthStore', () => {
  it('ignores malformed persisted health records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daruma-store-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({
      healths: {
        good: { channel: 'good', state: 'HEALTHY', consecutiveFailures: 0, cooldownUntilMs: 0, updatedAtMs: 1 },
        bad: { channel: 'bad', state: 'BROKEN', consecutiveFailures: -1 },
      },
    }))
    const store = new JsonFileChannelHealthStore(file)
    expect(store.load(channelId('good'))?.state).toBe('HEALTHY')
    expect(store.load(channelId('bad'))).toBeUndefined()
  })
})
