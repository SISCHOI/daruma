/**
 * The watch loop: run a command, detect non-human interruption, and resume
 * with bounded backoff. Tool-agnostic — codex and claude-code both go through
 * `--cmd` / `--resume`.
 */

import { backoffDelayMs, type BackoffPlan } from 'daruma-core'
import { classifyOutcome, type ProcessOutcome, type ProcessRunner } from './process.ts'

export interface RunnerDeps {
  readonly runner: ProcessRunner
  readonly skipExitCodes: ReadonlySet<number>
  readonly rand?: () => number
  readonly log?: (message: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

export interface RunOptions {
  readonly cmd: string
  readonly resumeCmd: string
  readonly maxResumes: number
  readonly stallTimeoutMs: number
  readonly backoff: BackoffPlan
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run the primary command and, on non-human interruption, resume up to
 * `maxResumes` times. Returns the process exit code (0 on any successful
 * completion, 1 on give-up).
 */
export async function run(
  options: RunOptions,
  deps: RunnerDeps,
): Promise<number> {
  const { log = () => {} } = deps
  const sleep = deps.sleep ?? defaultSleep
  const rand = deps.rand ?? Math.random

  let outcome = await deps.runner.run(options.cmd, {
    stallTimeoutMs: options.stallTimeoutMs,
  })
  if (isAcceptable(outcome, deps.skipExitCodes)) {
    log('daruma-watch: primary command finished normally')
    return 0
  }

  log(`daruma-watch: interruption detected (${describe(outcome)})`)

  for (let attempt = 0; attempt < options.maxResumes; attempt++) {
    const delayMs = backoffDelayMs(options.backoff, attempt, rand)
    log(
      `daruma-watch: resuming in ${delayMs}ms (attempt ${attempt + 1}/${options.maxResumes})`,
    )
    await sleep(delayMs)

    outcome = await deps.runner.run(options.resumeCmd, {
      stallTimeoutMs: options.stallTimeoutMs,
    })
    if (isAcceptable(outcome, deps.skipExitCodes)) {
      log('daruma-watch: resumed run finished normally')
      return 0
    }
    log(`daruma-watch: resume attempt ${attempt + 1} interrupted (${describe(outcome)})`)
  }

  log(`daruma-watch: giving up after ${options.maxResumes} resume attempts`)
  return 1
}

function isAcceptable(
  outcome: ProcessOutcome,
  skipExitCodes: ReadonlySet<number>,
): boolean {
  const code = classifyOutcome(outcome)
  if (code === null) return true
  // A non-zero exit code listed in --skip-exit-codes means "intentional stop".
  if (code === 'PROCESS_EXITED' && outcome.exitCode !== null && skipExitCodes.has(outcome.exitCode)) {
    return true
  }
  return false
}

function describe(outcome: ProcessOutcome): string {
  if (outcome.stalled) return 'stalled'
  if (outcome.signal) return `signal ${outcome.signal}`
  return `exit code ${outcome.exitCode}`
}
