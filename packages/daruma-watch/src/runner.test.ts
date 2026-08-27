import { describe, expect, it } from 'vitest'
import { run } from './runner.ts'
import type { ProcessOutcome, ProcessRunner } from './process.ts'

class ScriptedRunner implements ProcessRunner {
  readonly calls: string[] = []
  constructor(private outcomes: ProcessOutcome[]) {}

  run(command: string, _opts: { stallTimeoutMs: number }): Promise<ProcessOutcome> {
    this.calls.push(command)
    const next = this.outcomes.shift()
    if (next === undefined) throw new Error('scripted runner ran out of outcomes')
    return Promise.resolve(next)
  }
}

const ok = (): ProcessOutcome => ({ exitCode: 0, signal: null, stalled: false })
const fail = (code: number): ProcessOutcome => ({ exitCode: code, signal: null, stalled: false })
const killed = (): ProcessOutcome => ({ exitCode: null, signal: 'SIGKILL', stalled: false })
const stalled = (): ProcessOutcome => ({ exitCode: null, signal: null, stalled: true })

const baseOptions = {
  cmd: 'codex exec task',
  resumeCmd: 'codex exec resume --last',
  maxResumes: 3,
  stallTimeoutMs: 60_000,
  backoff: { initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2, jitterRatio: 0 },
}

const deps = {
  runner: undefined as unknown as ScriptedRunner,
  skipExitCodes: new Set<number>(),
  rand: () => 0.5,
  sleep: async () => {},
  log: () => {},
}

describe('run', () => {
  it('returns 0 without resume when the primary command finishes normally', async () => {
    const runner = new ScriptedRunner([ok()])
    const code = await run(baseOptions, { ...deps, runner })
    expect(code).toBe(0)
    expect(runner.calls).toEqual(['codex exec task'])
  })

  it('resumes once when the primary command fails and resume succeeds', async () => {
    const runner = new ScriptedRunner([fail(1), ok()])
    const code = await run(baseOptions, { ...deps, runner })
    expect(code).toBe(0)
    expect(runner.calls).toEqual(['codex exec task', 'codex exec resume --last'])
  })

  it('resumes on a signal kill', async () => {
    const runner = new ScriptedRunner([killed(), ok()])
    const code = await run(baseOptions, { ...deps, runner })
    expect(code).toBe(0)
    expect(runner.calls).toHaveLength(2)
  })

  it('resumes on a stall', async () => {
    const runner = new ScriptedRunner([stalled(), ok()])
    const code = await run(baseOptions, { ...deps, runner })
    expect(code).toBe(0)
    expect(runner.calls).toHaveLength(2)
  })

  it('gives up after maxResumes failed attempts', async () => {
    const runner = new ScriptedRunner([fail(1), fail(1), fail(1), fail(1)])
    const code = await run(baseOptions, { ...deps, runner })
    expect(code).toBe(1)
    // primary + 3 resume attempts
    expect(runner.calls).toHaveLength(4)
  })

  it('treats a skip-exit-code as intentional and does not resume', async () => {
    const runner = new ScriptedRunner([fail(130)])
    const code = await run(baseOptions, { ...deps, runner, skipExitCodes: new Set([130]) })
    expect(code).toBe(0)
    expect(runner.calls).toHaveLength(1)
  })
})
