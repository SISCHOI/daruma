/**
 * daruma-watch — Daruma watchdog daemon for Codex CLI and Claude Code.
 */

export { parseArgs, HELP } from './config.ts'
export type { WatchConfig } from './config.ts'

export { classifyOutcome, spawnWatchProcess } from './process.ts'
export type { ProcessOutcome, ProcessRunner } from './process.ts'

export { run } from './runner.ts'
export type { RunOptions, RunnerDeps } from './runner.ts'

export { scanCodexSessions, sessionIdFromFilename, loadSessionNames } from './codex-sessions.ts'
export type { CodexSession, CodexSessionStatus } from './codex-sessions.ts'
