/**
 * Append-only JSONL log of daruma's recovery decisions.
 *
 * The harness does not yet persist out-of-repo session events, and the web
 * server's stdout (where the ctx.logger.warn lines go) is not captured to
 * disk — so without this file a channel switch leaves **no auditable trace**.
 * Every failover / give-up / boot is therefore appended here as one JSON
 * line, giving post-hoc audits (like the 2026-09-08 one) a durable record.
 *
 * Failure semantics: logging must never break recovery. Every I/O error is
 * swallowed; the worst case is a missing or truncated line, never a lost
 * failover.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'

/** Rotate when the log exceeds this size (kept to one `.1` generation). */
export const FAILOVER_LOG_ROTATE_BYTES = 2 * 1024 * 1024

/** One JSONL record. `kind` discriminates the payload shape. */
export type FailoverLogRecord =
  | {
    readonly kind: 'failover'
    /** Epoch ms of the decision. */
    readonly t: number
    readonly agentId: string
    /** Channel the request failed on. */
    readonly from: string
    /** Channel recovery switched to. */
    readonly to: string
    /** Stable failure code, e.g. `RATE_LIMIT`. */
    readonly reason: string
    /** HTTP status of the failed request, when available. */
    readonly status?: number
    /** Turn / step of the failed request. */
    readonly turn?: number
    readonly step?: number
    /** Scope failover count AFTER this decision. */
    readonly failoverCount?: number
    /** Scope give-up budget the count counts against. */
    readonly giveUpBudget?: number
  }
  | {
    readonly kind: 'give-up'
    readonly t: number
    readonly agentId: string
    readonly from: string
    /** `give-up-budget-exhausted` or `no-routable-fallback`. */
    readonly reason: string
    readonly status?: number
    readonly turn?: number
    readonly step?: number
    readonly failoverCount?: number
    readonly giveUpBudget?: number
  }
  | {
    readonly kind: 'boot'
    readonly t: number
    /** Plugin process id, to correlate with server restarts. */
    readonly pid: number
    /** Configured chain channel ids, priority order. */
    readonly channels: readonly string[]
    /** Configured budgets, for interpreting later records. */
    readonly failureBudget: number
    readonly cooldownMs: number
    readonly giveUpBudget: number
  }

export class JsonlFailoverLogStore {
  constructor(private readonly file: string) {}

  /** Append one record; rotate first when over budget. Never throws. */
  append(record: FailoverLogRecord): void {
    try {
      this.rotateIfNeeded()
      mkdirSync(dirnameOf(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // A lost log line must never take down recovery.
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size < FAILOVER_LOG_ROTATE_BYTES) return
      renameSync(this.file, `${this.file}.1`)
    } catch {
      // Missing file, or Windows lock on rename: keep appending (no rotation).
    }
  }
}

function dirnameOf(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index <= 0 ? '.' : file.slice(0, index)
}
