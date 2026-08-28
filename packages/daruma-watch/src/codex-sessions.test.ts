import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSessionNames, scanCodexSessions, sessionIdFromFilename } from './codex-sessions.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daruma-codex-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSession(filename: string, lines: string[]): void {
  const full = join(dir, filename)
  mkdirSync(join(dir), { recursive: true })
  writeFileSync(full, lines.map((l) => JSON.stringify(JSON.parse(l))).join('\n') + '\n')
}

const meta = (id: string, originator = 'codex_vscode') =>
  `{"timestamp":"2026-08-26T10:31:43.915Z","type":"session_meta","payload":{"session_id":"${id}","id":"${id}","cwd":"C:\\\\repo","originator":"${originator}","model_provider":"aiplan"}}`

const taskComplete =
  '{"timestamp":"2026-08-26T10:32:42.547Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}'

const turnAborted =
  '{"timestamp":"2026-08-26T10:32:42.547Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1"}}'

describe('sessionIdFromFilename', () => {
  it('extracts the UUID', () => {
    expect(sessionIdFromFilename('rollout-2026-08-26T18-31-43-01a03da0-30b0-7421-ad9d-6a97bd198e06.jsonl'))
      .toBe('01a03da0-30b0-7421-ad9d-6a97bd198e06')
  })

  it('rejects non-rollout names', () => {
    expect(sessionIdFromFilename('session_index.jsonl')).toBeNull()
    expect(sessionIdFromFilename('rollout-noid.jsonl')).toBeNull()
  })
})

describe('scanCodexSessions', () => {
  it('classifies a task_complete session as completed', () => {
    const id = '01a03da0-30b0-7421-ad9d-6a97bd198e06'
    writeSession(`rollout-2026-08-26T18-31-43-${id}.jsonl`, [meta(id), taskComplete])
    const sessions = scanCodexSessions(dir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id, status: 'completed', originator: 'codex_vscode' })
  })

  it('classifies a turn_aborted session as interrupted', () => {
    const id = '01a03da0-30b0-7421-ad9d-6a97bd198e06'
    writeSession(`rollout-2026-08-26T18-31-43-${id}.jsonl`, [meta(id), turnAborted])
    expect(scanCodexSessions(dir)[0]?.status).toBe('interrupted')
  })

  it('classifies a session_meta-only session as interrupted', () => {
    const id = '01a03da0-30b0-7421-ad9d-6a97bd198e06'
    writeSession(`rollout-2026-08-26T18-31-43-${id}.jsonl`, [meta(id)])
    expect(scanCodexSessions(dir)[0]?.status).toBe('interrupted')
  })

  it('scans nested year/month/day directories', () => {
    const id = '01a03da0-30b0-7421-ad9d-6a97bd198e06'
    const nested = join(dir, '2026', '08', '26')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, `rollout-2026-08-26T18-31-43-${id}.jsonl`),
      JSON.stringify(JSON.parse(meta(id))) + '\n' + JSON.stringify(JSON.parse(taskComplete)) + '\n')
    expect(scanCodexSessions(dir)).toHaveLength(1)
  })

  it('resolves names from session_index.jsonl', () => {
    const id = '01a03da0-30b0-7421-ad9d-6a97bd198e06'
    writeSession(`rollout-2026-08-26T18-31-43-${id}.jsonl`, [meta(id), taskComplete])
    writeFileSync(join(dir, 'session_index.jsonl'), `{"id":"${id}","thread_name":"Fix BOM"}\n`)
    const sessions = scanCodexSessions(dir, join(dir, 'session_index.jsonl'))
    expect(sessions[0]?.name).toBe('Fix BOM')
  })

  it('skips corrupt and unrelated files', () => {
    writeFileSync(join(dir, 'garbage.jsonl'), 'not json\n')
    writeFileSync(join(dir, 'session_index.jsonl'), 'also not json\n')
    expect(scanCodexSessions(dir)).toEqual([])
  })
})

describe('loadSessionNames', () => {
  it('maps ids to names and skips malformed lines', () => {
    const f = join(dir, 'index.jsonl')
    writeFileSync(f, '{"id":"a","thread_name":"one"}\nnot json\n{"id":"b"}\n')
    const names = loadSessionNames(f)
    expect(names.get('a')).toBe('one')
    expect(names.has('b')).toBe(false)
  })
})
