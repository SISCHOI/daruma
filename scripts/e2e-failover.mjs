#!/usr/bin/env node
/**
 * Cross-platform failover end-to-end check (Windows / Linux / macOS).
 *
 * Builds a throwaway DSH home in the OS temp directory, links this checkout's
 * daruma packages into a headless profile, points that profile at the mock LLM
 * server (`mock-a` answers 429, every other model answers 200), runs one task,
 * and asserts that daruma really failed over:
 *
 *   1. the task output is `mock completion from mock-b` and exits 0;
 *   2. the profile-local failover log has a `boot` line and a `failover` line
 *      `mock::mock-a -> mock::mock-b` with reason `RATE_LIMIT`;
 *   3. the profile-local health file marks `mock::mock-a` as `COOLDOWN`.
 *
 * Nothing outside the temp home is written; the production `~/.dsh` is never
 * touched.
 *
 * Usage:
 *   node scripts/e2e-failover.mjs [--dsh <command|path-to-bin.js>] [--keep]
 * Env:
 *   DSH_BIN        default for --dsh
 *   E2E_MOCK_PORT  mock LLM port (default 3099)
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const isWindows = process.platform === 'win32'

function parseArgs(argv) {
  const options = { dsh: process.env.DSH_BIN ?? 'dsh', keep: false, mockPort: Number(process.env.E2E_MOCK_PORT ?? 3099) }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dsh') options.dsh = argv[++i]
    else if (arg === '--mock-port') options.mockPort = Number(argv[++i])
    else if (arg === '--keep') options.keep = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

/** `dsh` on PATH, or an explicit path to the CLI entry (`…/lib/bin.js`). */
function dshCommand() {
  const target = options.dsh
  if (target.endsWith('.js') || target.endsWith('.mjs')) {
    return { command: process.execPath, prefixArgs: [target] }
  }
  return { command: target, prefixArgs: [] }
}

/**
 * Reject a setup that cannot work before anything is spawned: WSL interop
 * appends the Windows PATH, so a bare `dsh` can resolve to the Windows install
 * under `/mnt/…`, whose platform binaries (sharp, koffi) fail to load under
 * Linux with a boot error that reads like a daruma problem.
 */
function assertUsableHost() {
  const target = options.dsh
  if (process.platform !== 'win32' && target.startsWith('/mnt/')) {
    console.error(`refusing --dsh ${target}: that is a Windows install reached through WSL interop`)
    console.error('install the host inside the Linux distro and put its bin directory first on PATH, e.g.')
    console.error('  npm install --global @deepseek-ai/dsh@0.1.0-rc.7')
    console.error('  export PATH="$(npm prefix --global)/bin:$PATH"')
    process.exit(2)
  }
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

function linkDirectory(target, path) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, isWindows ? 'junction' : 'dir')
}

/** Parse a JSON file, returning `{}` when it is missing or malformed. */
function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

async function waitForServer(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'probe', messages: [] }),
      })
      if (response.ok) return true
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  return false
}

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// Validate the setup before allocating anything, so a refusal leaves no
// orphaned mock server behind.
assertUsableHost()
const { command, prefixArgs } = dshCommand()

const scratch = mkdtempSync(join(tmpdir(), 'daruma-e2e-'))
const dshHome = join(scratch, 'home')
const profile = 'daruma-e2e'
const profileDir = join(dshHome, 'profiles', profile)
const stateFile = join(profileDir, 'channel-health.json')
const logFile = join(profileDir, 'failover-log.jsonl')
const mockPort = options.mockPort

let mockServer
try {
  write(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {
      'daruma-core': `link:${join(repoRoot, 'packages', 'daruma-core').replaceAll('\\', '/')}`,
      'dsh-daruma': `link:${join(repoRoot, 'packages', 'dsh-daruma').replaceAll('\\', '/')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-daruma'] } },
  }, null, 2)}\n`)
  write(join(profileDir, 'cordis.yml'), '[]\n')
  write(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  write(join(profileDir, 'settings.yaml'), `llm-pi-ai:
  providers:
    mock:
      api: openai-completions
      apiKeyEnv: MOCK_API_KEY
      baseURL: http://127.0.0.1:${mockPort}/v1
      retryPolicy:
        mode: normal
        maxRetries: 0
      models:
        - { id: mock-a, contextWindow: 65536 }
        - { id: mock-b, contextWindow: 65536 }
agent-default-model:
  provider: mock
  model: mock-a
`)
  write(join(profileDir, 'cordis.patch.yml'), `- id: settings
  name: '@deepseek-ai/dsh-settings-file'
  config:
    path: ${join(profileDir, 'settings.yaml').replaceAll('\\', '/')}
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mock, model: mock-a }
      - { provider: mock, model: mock-b }
    failureBudget: 1
    stateFile: ${stateFile.replaceAll('\\', '/')}
    logFile: ${logFile.replaceAll('\\', '/')}
`)
  linkDirectory(join(repoRoot, 'packages', 'dsh-daruma'), join(profileDir, 'node_modules', 'dsh-daruma'))
  linkDirectory(join(repoRoot, 'packages', 'daruma-core'), join(profileDir, 'node_modules', 'daruma-core'))

  const built = existsSync(join(repoRoot, 'packages', 'dsh-daruma', 'lib', 'index.js'))
    && existsSync(join(repoRoot, 'packages', 'daruma-core', 'lib', 'index.js'))
  if (!built) {
    console.error('build first: pnpm --filter daruma-core --filter dsh-daruma run build')
    process.exit(2)
  }

  mockServer = spawn(process.execPath, [join(here, 'mock-llm-server.mjs'), String(mockPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  mockServer.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))
  if (!await waitForServer(mockPort)) throw new Error(`mock LLM server did not come up on :${mockPort}`)

  const task = 'Reply with exactly: OK'
  const args = [...prefixArgs, '--profile', profile, task]
  console.log(`running: ${command} ${args.join(' ')} (DSH_HOME=${dshHome})`)
  // Windows resolves `dsh` to `dsh.cmd`, which modern Node only launches
  // through a shell (CVE-2024-27980), so quote the whole line there.
  const useShell = isWindows && !command.toLowerCase().endsWith('.exe')
  const spawnOptions = {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: dshHome, MOCK_API_KEY: 'dummy' },
    encoding: 'utf8',
  }
  const run = useShell
    ? spawnSync([command, ...args].map((part) => `"${part}"`).join(' '), { ...spawnOptions, shell: true })
    : spawnSync(command, args, spawnOptions)

  const stdout = run.stdout ?? ''
  const stderr = run.stderr ?? ''
  console.log(`--- dsh stdout ---\n${stdout.trim()}`)
  if (stderr.trim() !== '') console.log(`--- dsh stderr ---\n${stderr.trim()}`)

  check('task exits 0', run.status === 0, `status=${String(run.status)} ${run.error?.message ?? ''}`)
  check('task text came from the fallback channel', stdout.includes('mock completion from mock-b'), stdout.trim().split('\n').at(-1) ?? '')

  const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const records = logText.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return {} } })
  const failover = records.find((record) => record.kind === 'failover')
  check('failover log has a boot line', records.some((record) => record.kind === 'boot'))
  check(
    'failover log records mock-a -> mock-b (RATE_LIMIT)',
    failover !== undefined && failover.from === 'mock::mock-a' && failover.to === 'mock::mock-b' && failover.reason === 'RATE_LIMIT',
    failover === undefined ? '(no failover line)' : JSON.stringify(failover),
  )

  const health = existsSync(stateFile) ? safeJson(stateFile) : {}
  check('tripped channel is persisted as COOLDOWN', health?.healths?.['mock::mock-a']?.state === 'COOLDOWN', JSON.stringify(health?.healths?.['mock::mock-a'] ?? null))
  check('fallback channel is HEALTHY', health?.healths?.['mock::mock-b']?.state === 'HEALTHY', JSON.stringify(health?.healths?.['mock::mock-b'] ?? null))
} catch (error) {
  console.error(`e2e aborted: ${error instanceof Error ? error.message : String(error)}`)
  failures.push('harness run')
} finally {
  if (mockServer !== undefined) mockServer.kill()
  if (options.keep) console.log(`kept temp home: ${dshHome}`)
  else rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nplatform=${process.platform} node=${process.version} dsh=${options.dsh}`)
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('failover e2e: all checks passed')
