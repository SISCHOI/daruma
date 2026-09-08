import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAILOVER_LOG_ROTATE_BYTES, JsonlFailoverLogStore } from './failover-log.ts'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daruma-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('JsonlFailoverLogStore', () => {
  it('appends one JSON line per record', () => {
    const dir = freshDir()
    const file = join(dir, 'failover-log.jsonl')
    const log = new JsonlFailoverLogStore(file)

    log.append({
      kind: 'failover',
      t: 1000,
      agentId: 'agent-1',
      from: 'mt::glm-5.3',
      to: 'mt::deepseek-v4-flash',
      reason: 'RATE_LIMIT',
      status: 429,
      turn: 2,
      step: 5,
      failoverCount: 1,
      giveUpBudget: 8,
    })
    log.append({ kind: 'boot', t: 1001, pid: 42, channels: ['mt::a', 'mt::b'], failureBudget: 3, cooldownMs: 30_000, giveUpBudget: 8 })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({
      kind: 'failover',
      t: 1000,
      agentId: 'agent-1',
      from: 'mt::glm-5.3',
      to: 'mt::deepseek-v4-flash',
      reason: 'RATE_LIMIT',
      status: 429,
      turn: 2,
      step: 5,
      failoverCount: 1,
      giveUpBudget: 8,
    })
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'boot', pid: 42 })
  })

  it('rotates to `.1` when the file exceeds the size budget', () => {
    const dir = freshDir()
    const file = join(dir, 'failover-log.jsonl')
    writeFileSync(file, 'x'.repeat(FAILOVER_LOG_ROTATE_BYTES), 'utf8')

    const log = new JsonlFailoverLogStore(file)
    log.append({ kind: 'boot', t: 1, pid: 1, channels: [], failureBudget: 3, cooldownMs: 1, giveUpBudget: 1 })

    // Old content rotated to .1; the live log holds exactly the new record.
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(FAILOVER_LOG_ROTATE_BYTES))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'boot' })
  })

  it('does not rotate below the size budget', () => {
    const dir = freshDir()
    const file = join(dir, 'failover-log.jsonl')
    writeFileSync(file, 'x'.repeat(10), 'utf8')

    const log = new JsonlFailoverLogStore(file)
    log.append({ kind: 'boot', t: 1, pid: 1, channels: [], failureBudget: 3, cooldownMs: 1, giveUpBudget: 1 })

    expect(statSync(file).size).toBeGreaterThan(10)
  })

  it('swallows errors: appending to an unwritable path never throws', () => {
    // A file path whose parent is itself a file → mkdir/enospc-style failure.
    const dir = freshDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir', 'utf8')
    const log = new JsonlFailoverLogStore(join(blocker, 'sub', 'failover-log.jsonl'))
    expect(() =>
      log.append({ kind: 'give-up', t: 1, agentId: 'a', from: 'mt::a', reason: 'no-routable-fallback' }),
    ).not.toThrow()
  })
})
