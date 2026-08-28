/**
 * Codex session discovery and interruption detection.
 *
 * Codex stores every session — from the CLI, the VS Code extension, and the
 * Desktop app — as a JSONL "rollout" file under `<codex-home>/sessions/`:
 *
 *   sessions/<year>/<month>/<day>/rollout-<timestamp>-<session-uuid>.jsonl
 *
 * The session id used by `codex exec resume <id>` is the UUID in the filename.
 * The first line is `session_meta` (cwd, originator, model_provider); the last
 * `event_msg` carries the terminal state. A session whose last event is not
 * `task_complete` is considered interrupted.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type CodexSessionStatus = 'completed' | 'interrupted'

export interface CodexSession {
  readonly id: string
  readonly name?: string
  readonly status: CodexSessionStatus
  readonly updatedAtMs: number
  readonly path: string
  readonly cwd?: string
  readonly originator?: string
  readonly modelProvider?: string
}

const UUID_PATTERN =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export function sessionIdFromFilename(filename: string): string | null {
  const match = UUID_PATTERN.exec(filename)
  return match ? (match[1] ?? null) : null
}

interface RolloutLine {
  readonly type?: string
  readonly payload?: { readonly type?: string }
}

interface SessionMeta {
  readonly cwd?: string
  readonly originator?: string
  readonly model_provider?: string
}

function readLine(filePath: string, first: boolean): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return null
    return first ? (lines[0] ?? null) : (lines[lines.length - 1] ?? null)
  } catch {
    return null
  }
}

function parseMeta(filePath: string): SessionMeta | null {
  const first = readLine(filePath, true)
  if (!first) return null
  try {
    const obj = JSON.parse(first) as { type?: string; payload?: SessionMeta }
    if (obj.type !== 'session_meta') return null
    return obj.payload ?? null
  } catch {
    return null
  }
}

function classifyStatus(filePath: string): CodexSessionStatus {
  const last = readLine(filePath, false)
  if (!last) return 'interrupted'
  try {
    const obj = JSON.parse(last) as RolloutLine
    // A session that recorded no event (file ends at session_meta), or whose
    // last event is not a task completion, is interrupted.
    if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
      return 'completed'
    }
    return 'interrupted'
  } catch {
    return 'interrupted'
  }
}

/** Load `session_index.jsonl` (id → thread_name) for human-friendly names. */
export function loadSessionNames(indexFile: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    const content = readFileSync(indexFile, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { id?: string; thread_name?: string }
        if (obj.id && obj.thread_name) names.set(obj.id, obj.thread_name)
      } catch {
        // skip malformed index lines
      }
    }
  } catch {
    // missing/unreadable index is fine
  }
  return names
}

export function scanCodexSessions(
  sessionsDir: string,
  indexFile?: string,
): CodexSession[] {
  const names = indexFile ? loadSessionNames(indexFile) : new Map<string, string>()
  const sessions: CodexSession[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      const id = sessionIdFromFilename(entry.name)
      if (id === null) continue

      const meta = parseMeta(path)
      const name = names.get(id)
      sessions.push({
        id,
        ...(name !== undefined ? { name } : {}),
        status: classifyStatus(path),
        updatedAtMs: statSync(path).mtimeMs,
        path,
        ...(meta?.cwd !== undefined ? { cwd: meta.cwd } : {}),
        ...(meta?.originator !== undefined ? { originator: meta.originator } : {}),
        ...(meta?.model_provider !== undefined ? { modelProvider: meta.model_provider } : {}),
      })
    }
  }

  walk(sessionsDir)
  return sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}
