#!/usr/bin/env node
/**
 * daruma-watch CLI entry point.
 */

import { parseArgs } from './config.ts'
import { run } from './runner.ts'
import { spawnWatchProcess } from './process.ts'

async function main(): Promise<void> {
  const { config, error } = parseArgs(process.argv.slice(2))
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

void main()
