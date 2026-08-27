/**
 * Process outcome and termination classification.
 *
 * The runner depends only on `ProcessRunner` (a port) so tests can inject a
 * scripted implementation; `spawnWatchProcess` is the real Node adapter.
 */

import { spawn } from 'node:child_process'

export interface ProcessOutcome {
  /** Exit code, or `null` if killed by a signal or timeout. */
  readonly exitCode: number | null
  /** Signal name if killed by a signal, else `null`. */
  readonly signal: string | null
  /** True when the process was killed for stalling (idle too long). */
  readonly stalled: boolean
}

export interface ProcessRunner {
  run(command: string, opts: { stallTimeoutMs: number }): Promise<ProcessOutcome>
}

/** Classify a process outcome into a failure code, or `null` for normal exit. */
export function classifyOutcome(outcome: ProcessOutcome): 'PROCESS_EXITED' | 'STALLED' | null {
  if (outcome.stalled) return 'STALLED'
  if (outcome.exitCode === 0 && outcome.signal === null) return null
  return 'PROCESS_EXITED'
}

/**
 * Real runner: spawns through the shell, forwards output, and kills the
 * child if it produces no output for `stallTimeoutMs`.
 */
export const spawnWatchProcess: ProcessRunner = {
  run(command, { stallTimeoutMs }) {
    return new Promise<ProcessOutcome>((resolve) => {
      const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })

      let settled = false
      let lastActivity = Date.now()
      const outcome = (partial: Partial<ProcessOutcome>): ProcessOutcome => ({
        exitCode: null,
        signal: null,
        stalled: false,
        ...partial,
      })

      const finish = (result: ProcessOutcome): void => {
        if (settled) return
        settled = true
        clearInterval(timer)
        resolve(result)
      }

      const onData = (): void => {
        lastActivity = Date.now()
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk)
        onData()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk)
        onData()
      })

      // Stall watchdog: no output for stallTimeoutMs → kill and mark stalled.
      const timer = setInterval(() => {
        if (!settled && Date.now() - lastActivity >= stallTimeoutMs) {
          child.kill()
          finish(outcome({ stalled: true }))
        }
      }, Math.min(1000, stallTimeoutMs))

      child.on('error', (error) => {
        finish(outcome({ exitCode: 1, signal: null }))
        void error
      })
      child.on('exit', (code, signal) => {
        finish(outcome({ exitCode: code, signal }))
      })
    })
  },
}
