#!/usr/bin/env node
/**
 * Lab-only probe: does the daruma web panel RPC (/dsh-daruma/*) work on a live
 * DSH web host? Builds an isolated DSH_HOME in the OS temp dir, boots the web
 * profile, signs in with the launch token, then drives
 * status -> listCandidates -> setBackup -> status -> clearBackup -> status
 * and checks backup-channel.json on disk after each write.
 *
 * Usage: node .dsh-lab/web-rpc-probe.mjs <path-to-bin.js> [port]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = resolve(process.argv[2])
const port = Number(process.argv[3] ?? 3191)
const hostVersion = JSON.parse(readFileSync(join(dirname(bin), '..', 'package.json'), 'utf8')).version

const scratch = mkdtempSync(join(tmpdir(), 'daruma-webprobe-'))
const dshHome = join(scratch, 'home')
const profile = 'daruma-web-probe'
const dir = join(dshHome, 'profiles', profile)
const fwd = (p) => p.replaceAll('\\', '/')
const backupFile = join(dir, 'backup-channel.json')

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8') }
write(join(dir, 'package.json'), `${JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: {
    'daruma-core': `link:${fwd(join(repoRoot, 'packages', 'daruma-core'))}`,
    'dsh-daruma': `link:${fwd(join(repoRoot, 'packages', 'dsh-daruma'))}`,
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-daruma'] } },
}, null, 2)}\n`)
write(join(dir, 'cordis.yml'), '[]\n')
write(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
write(join(dir, 'cordis.patch.yml'), `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mock
    model: mock-a
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      mock:
        api: openai-completions
        apiKeyEnv: MOCK_API_KEY
        baseURL: http://127.0.0.1:3199/v1
        models:
          - { id: mock-a, contextWindow: 65536 }
          - { id: mock-b, contextWindow: 65536 }
          - { id: mock-c, contextWindow: 65536 }
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mock, model: mock-a }
      - { provider: mock, model: mock-b }
    stateFile: ${fwd(join(dir, 'channel-health.json'))}
    logFile: ${fwd(join(dir, 'failover-log.jsonl'))}
`)
for (const pkg of ['dsh-daruma', 'daruma-core']) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages', pkg), join(dir, 'node_modules', pkg), process.platform === 'win32' ? 'junction' : 'dir')
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const child = spawn(process.execPath, [bin, '--profile', profile, '--no-open', '--port', String(port)], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: dshHome, MOCK_API_KEY: 'dummy' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

try {
  const deadline = Date.now() + 120_000
  let token
  while (Date.now() < deadline && token === undefined) {
    await new Promise((done) => setTimeout(done, 500))
    token = output.match(/token=([A-Za-z0-9_-]+)/u)?.[1]
    if (child.exitCode !== null) break
  }
  if (token === undefined) throw new Error(`no launch token; host output:\n${output.slice(-1500)}`)
  const base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  check('launch token exchanged for a session cookie', login.status === 303 && cookie !== '', `HTTP ${login.status}`)

  // Same routing as the panel client (src/client/adaptive-rpc.ts): the generic
  // `/dsh-daruma` channel first, then the sticky `/api/dsh-daruma` tunnel on a
  // 404/405 route miss.
  let n = 0
  let route = 'legacy'
  const routesSeen = new Set()
  const post = async (path, envelope) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(envelope),
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = undefined }
    return { status: response.status, body, text }
  }
  const call = async (method, payload = {}) => {
    if (route === 'legacy') {
      const legacy = await post(`/dsh-daruma/${method}`, { type: 'client-request', rpcId: `probe-${++n}`, method, payload })
      if (legacy.status !== 404 && legacy.status !== 405) { routesSeen.add(`legacy:${legacy.status}`); return legacy }
      routesSeen.add(`legacy-miss:${legacy.status}`)
      route = 'fallback'
    }
    const tunneled = await post('/api/dsh-daruma', {
      type: 'client-request', rpcId: `probe-${++n}`, method: 'dsh-daruma', payload: { method, payload },
    })
    routesSeen.add(`fallback:${tunneled.status}`)
    return tunneled
  }

  const s1 = await call('status')
  const v1 = s1.body?.result?.value
  check('status answers over /dsh-daruma', s1.status === 200 && s1.body?.result?.ok === true, `HTTP ${s1.status} ${s1.text.slice(0, 160)}`)
  check('status lists the configured channels', Array.isArray(v1?.channels) && v1.channels.length >= 0 && v1?.backup === null, JSON.stringify({ backup: v1?.backup, providers: v1?.providers }))
  check('status knows provider "mock"', Array.isArray(v1?.providers) && v1.providers.includes('mock'), JSON.stringify(v1?.providers))

  const lc = await call('listCandidates', { provider: 'mock' })
  const models = (lc.body?.result?.value ?? []).map((entry) => entry.model)
  check('listCandidates returns the mock models', lc.body?.result?.ok === true && models.includes('mock-c'), JSON.stringify(models))

  const set = await call('setBackup', { provider: 'mock', model: 'mock-c' })
  check('setBackup succeeds', set.body?.result?.ok === true, set.text.slice(0, 160))
  const onDisk = existsSync(backupFile) ? JSON.parse(readFileSync(backupFile, 'utf8')) : null
  check('backup-channel.json written', onDisk?.backup?.provider === 'mock' && onDisk?.backup?.model === 'mock-c', JSON.stringify(onDisk))

  const s2 = await call('status')
  check('status reports the new backup', s2.body?.result?.value?.backup?.model === 'mock-c', JSON.stringify(s2.body?.result?.value?.backup))

  const clear = await call('clearBackup')
  check('clearBackup succeeds', clear.body?.result?.ok === true, clear.text.slice(0, 160))
  const afterClear = existsSync(backupFile) ? JSON.parse(readFileSync(backupFile, 'utf8')) : null
  check('backup-channel.json cleared', afterClear !== null && afterClear.backup === undefined, JSON.stringify(afterClear))

  const s3 = await call('status')
  check('status reports no backup', s3.body?.result?.value?.backup === null, JSON.stringify(s3.body?.result?.value?.backup))

  // Unauthenticated request on whichever route actually served the panel.
  const anonPath = route === 'legacy' ? '/dsh-daruma/status' : '/api/dsh-daruma'
  const anonBody = route === 'legacy'
    ? { type: 'client-request', rpcId: 'anon', method: 'status', payload: {} }
    : { type: 'client-request', rpcId: 'anon', method: 'dsh-daruma', payload: { method: 'status', payload: {} } }
  const anon = await fetch(`${base}${anonPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(anonBody),
  })
  check(`request without session cookie is rejected (${anonPath})`, anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`)
  console.log(`route used: ${route} (${[...routesSeen].join(', ')})`)
} catch (error) {
  check('probe run', false, error instanceof Error ? error.message : String(error))
} finally {
  const lines = output.split('\n')
  const darumaLines = lines.filter((line) => /daruma/u.test(line) && !/token=/u.test(line))
  console.log(`--- host log: daruma lines (${darumaLines.length}) ---\n${darumaLines.slice(0, 12).join('\n')}`)
  console.log(`--- host log tail ---\n${lines.filter((line) => !/token=/u.test(line)).slice(-15).join('\n')}`)
  child.kill()
  await new Promise((done) => setTimeout(done, 1500))
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok).length
console.log(`\nhost=${hostVersion} checks=${results.length} failed=${failed}`)
process.exit(failed === 0 ? 0 : 1)
