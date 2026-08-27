import { describe, expect, it } from 'vitest'
import { parseArgs } from './config.ts'

describe('parseArgs', () => {
  it('parses required options with defaults', () => {
    const { config, error } = parseArgs(['--cmd', 'codex exec x', '--resume', 'codex exec resume --last'])
    expect(error).toBeUndefined()
    expect(config).toMatchObject({
      cmd: 'codex exec x',
      resumeCmd: 'codex exec resume --last',
      maxResumes: 3,
      stallTimeoutMs: 600_000,
    })
    expect(config?.backoff.initialDelayMs).toBe(1000)
    expect(config?.backoff.maxDelayMs).toBe(30_000)
  })

  it('returns an error without --cmd/--resume', () => {
    const { config, error } = parseArgs([])
    expect(config).toBeUndefined()
    expect(error).toContain('--cmd')
  })

  it('parses skip-exit-codes as a set', () => {
    const { config } = parseArgs([
      '--cmd', 'x',
      '--resume', 'y',
      '--skip-exit-codes', '130, 1',
    ])
    expect(config?.skipExitCodes).toEqual(new Set([130, 1]))
  })

  it('shows help on -h', () => {
    const { error } = parseArgs(['-h'])
    expect(error).toContain('Usage:')
  })
})
