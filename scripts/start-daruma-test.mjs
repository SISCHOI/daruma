#!/usr/bin/env node
/**
 * Cross-platform daruma web test environment (Windows / Linux / macOS).
 *
 * Starts the mock LLM server in the background, then runs the daruma web DSH
 * profile in the foreground; Ctrl+C stops dsh and kills the mock server.
 *
 * Usage:
 *   node scripts/start-daruma-test.mjs [--profile daruma-test] [--port 3082] [--mock-port 3099] [--dsh <command>]
 * Env:
 *   DSH_BIN  default for --dsh
 *
 * Then open the printed URL to see the daruma status dock and backup panel.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'

const options = { profile: 'daruma-test', port: 3082, mockPort: 3099, dsh: process.env.DSH_BIN ?? 'dsh' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--profile') options.profile = argv[++i]
  else if (arg === '--port') options.port = Number(argv[++i])
  else if (arg === '--mock-port') options.mockPort = Number(argv[++i])
  else if (arg === '--dsh') options.dsh = argv[++i]
}

const mock = spawn(process.execPath, [join(here, 'mock-llm-server.mjs'), String(options.mockPort)], {
  stdio: ['ignore', 'ignore', 'inherit'],
})
console.log(`mock LLM server started (pid ${mock.pid}) on :${options.mockPort}`)

const dshArgs = ['--profile', options.profile, '--port', String(options.port)]
const useShell = isWindows && !options.dsh.toLowerCase().endsWith('.exe')
const dsh = useShell
  ? spawn([options.dsh, ...dshArgs].map((part) => `"${part}"`).join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, MOCK_API_KEY: 'dummy' },
  })
  : spawn(options.dsh, dshArgs, { stdio: 'inherit', env: { ...process.env, MOCK_API_KEY: 'dummy' } })

dsh.on('error', (error) => {
  console.error(`could not start dsh (${options.dsh}): ${error.message}`)
  console.error('pass an explicit CLI with --dsh <command>, or install the dsh CLI on PATH')
  shutdown(1)
})

console.log(`starting dsh web on :${options.port} — Ctrl+C to stop`)

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  if (!mock.killed) mock.kill()
  if (!dsh.killed) dsh.kill()
  process.exitCode = code
}

dsh.on('exit', (code, signal) => {
  console.log(`dsh exited (code=${String(code)} signal=${String(signal)})`)
  shutdown(code ?? 0)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal}: stopping dsh and the mock server`)
    shutdown(0)
  })
}
