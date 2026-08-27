import { describe, expect, it } from 'vitest'
import { classifyOutcome } from './process.ts'

describe('classifyOutcome', () => {
  it('classifies clean exit as normal', () => {
    expect(classifyOutcome({ exitCode: 0, signal: null, stalled: false })).toBeNull()
  })

  it('classifies non-zero exit as PROCESS_EXITED', () => {
    expect(classifyOutcome({ exitCode: 1, signal: null, stalled: false })).toBe('PROCESS_EXITED')
  })

  it('classifies signal kill as PROCESS_EXITED', () => {
    expect(classifyOutcome({ exitCode: null, signal: 'SIGKILL', stalled: false })).toBe('PROCESS_EXITED')
  })

  it('classifies a stall as STALLED', () => {
    expect(classifyOutcome({ exitCode: null, signal: null, stalled: true })).toBe('STALLED')
  })
})
