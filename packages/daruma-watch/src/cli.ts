#!/usr/bin/env node
/**
 * daruma-watch CLI entry point.
 *
 *   daruma-watch --cmd "<command>" --resume "<command>" [options]
 *       Run a command and resume it on non-human interruption.
 *
 *   daruma-watch codex sessions [--interrupted] [--json] [--dir <path>]
 *       List Codex sessions (CLI + VS Code extension share one store).
 *
 *   daruma-watch codex resume <session-id> [--codex <bin>]
 *       Resume a Codex session non-interactively.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs as utilParseArgs, type ParseArgsConfig } from 'node:util'
import { parseArgs, HELP } from './config.ts'
import { run } from './runner.ts'
import { runInteractive, spawnWatchProcess } from './process.ts'
import { scanCodexSessions } from './codex-sessions.ts'

const CODEX_HOME = join(homedir(), '.codex')

type FlagSpec = NonNullable<ParseArgsConfig['options']>

function parseFlags(args: string[], options: FlagSpec, allowPositionals = false) {
  const { values, positionals } = utilParseArgs({
    args,
    options,
    allowPositionals,
    strict: true,
  })
  return { values, positionals }
}

async function codexCommand(args: string[]): Promise<number> {
  const sub = args[0]
  if (sub === 'sessions') return codexSessions(args.slice(1))
  if (sub === 'resume') return codexResume(args.slice(1))
  process.stderr.write(CODEX_HELP)
  return 2
}

function codexSessions(args: string[]): number {
  const { values } = parseFlags(args, {
    interrupted: { type: 'boolean', short: 'i' },
    json: { type: 'boolean' },
    dir: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  })
  if (values.help) {
    process.stdout.write(CODEX_HELP)
    return 0
  }
  const dir = (values.dir as string | undefined) ?? join(CODEX_HOME, 'sessions')
  const indexFile = join(CODEX_HOME, 'session_index.jsonl')
  const sessions = scanCodexSessions(dir, indexFile)
  const filtered = values.interrupted
    ? sessions.filter((s) => s.status === 'interrupted')
    : sessions

  if (values.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n')
    return 0
  }

  if (filtered.length === 0) {
    process.stdout.write('no sessions found\n')
    return 0
  }
  for (const s of filtered) {
    const name = s.name ? `  ${s.name}` : ''
    const origin = s.originator ? `  [${s.originator}]` : ''
    process.stdout.write(`${s.status.padEnd(11)} ${s.id}${origin}${name}\n`)
  }
  return 0
}

function codexResume(args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(
    args,
    {
      codex: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    true,
  )
  if (values.help) {
    process.stdout.write(CODEX_HELP)
    return Promise.resolve(0)
  }
  const id = positionals[0]
  if (!id) {
    process.stderr.write('missing <session-id>\n\n' + CODEX_HELP)
    return Promise.resolve(2)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    process.stderr.write(`invalid session id: ${id}\n`)
    return Promise.resolve(2)
  }
  const codexBin = (values.codex as string | undefined) ?? 'codex'
  return runInteractive(`${codexBin} exec resume ${id}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'codex') {
    process.exit(await codexCommand(argv.slice(1)))
  }

  const { config, error } = parseArgs(argv)
  if (error) {
    process.stderr.write(error)
    process.exit(2)
  }
  if (!config) {
    process.exit(2)
  }

  const code = await run(
    {
      cmd: config.cmd,
      resumeCmd: config.resumeCmd,
      maxResumes: config.maxResumes,
      stallTimeoutMs: config.stallTimeoutMs,
      backoff: config.backoff,
    },
    {
      runner: spawnWatchProcess,
      skipExitCodes: config.skipExitCodes,
      log: (message) => console.error(message),
    },
  )
  process.exit(code)
}

const CODEX_HELP = `daruma-watch codex — inspect and resume Codex sessions.

Codex stores every session (CLI, VS Code extension, Desktop) in one place
(~/.codex/sessions). These commands work for sessions from any surface.

Usage:
  daruma-watch codex sessions [--interrupted] [--json] [--dir <path>]
  daruma-watch codex resume <session-id> [--codex <bin>]

Options:
  -i, --interrupted   List only interrupted sessions.
      --json          Emit JSON.
      --dir <path>    Sessions directory (default ~/.codex/sessions).
      --codex <bin>   Codex binary for resume (default "codex").
  -h, --help          Show this help.

${HELP}
`

void main()
