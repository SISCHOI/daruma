/**
 * daruma-watch configuration and CLI argument parsing.
 */

import { parseArgs as utilParseArgs } from 'node:util'
import { DEFAULT_BACKOFF, type BackoffPlan } from 'daruma-core'

export interface WatchConfig {
  /** Full command to run (spawned through the shell). */
  readonly cmd: string
  /** Full command to resume with (spawned on non-human interruption). */
  readonly resumeCmd: string
  /** Maximum resume attempts before giving up. */
  readonly maxResumes: number
  /** Idle duration in ms before the process is considered stalled. */
  readonly stallTimeoutMs: number
  /** Backoff applied between resume attempts. */
  readonly backoff: BackoffPlan
  /** Exit codes that should NOT trigger a resume (treated as intentional). */
  readonly skipExitCodes: ReadonlySet<number>
}

const HELP = `daruma-watch — keep a coding-agent process alive across interruptions.

Usage:
  daruma-watch --cmd "<command>" --resume "<command>" [options]

Options:
  --cmd <string>            Command to run (required).
  --resume <string>         Command to resume with (required).
  --max-resumes <n>         Max resume attempts (default 3).
  --stall-timeout <ms>      Idle time before the process is considered stalled
                            and restarted (default 600000).
  --backoff-initial <ms>    Backoff initial delay (default 1000).
  --backoff-max <ms>        Backoff max delay (default 30000).
  --skip-exit-codes <list>  Comma-separated exit codes that mean "intentional"
                            and must not resume (default empty).
  -h, --help                Show this help.
`

export function parseArgs(argv: string[]): { config?: WatchConfig; error?: string } {
  const parsed = utilParseArgs({
    args: argv,
    options: {
      cmd: { type: 'string' },
      resume: { type: 'string' },
      'max-resumes': { type: 'string', default: '3' },
      'stall-timeout': { type: 'string', default: '600000' },
      'backoff-initial': { type: 'string', default: '1000' },
      'backoff-max': { type: 'string', default: '30000' },
      'skip-exit-codes': { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
    strict: true,
  })

  if (parsed.values.help) return { error: HELP }

  const cmd = parsed.values.cmd
  const resume = parsed.values.resume
  if (!cmd || !resume) {
    return { error: 'missing required options --cmd and --resume\n\n' + HELP }
  }

  const maxResumes = parsePositiveInt(parsed.values['max-resumes'])
  const stallTimeoutMs = parsePositiveInt(parsed.values['stall-timeout'])
  const initial = parsePositiveInt(parsed.values['backoff-initial'])
  const max = parsePositiveInt(parsed.values['backoff-max'])
  if (maxResumes === null || stallTimeoutMs === null || initial === null || max === null) {
    return { error: 'numeric options must be positive integers\n\n' + HELP }
  }

  const skipExitCodes = new Set<number>(
    (parsed.values['skip-exit-codes'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isInteger(n)),
  )

  return {
    config: {
      cmd,
      resumeCmd: resume,
      maxResumes,
      stallTimeoutMs,
      backoff: {
        initialDelayMs: initial,
        maxDelayMs: max,
        multiplier: DEFAULT_BACKOFF.multiplier,
        jitterRatio: DEFAULT_BACKOFF.jitterRatio,
      },
      skipExitCodes,
    },
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export { HELP }
