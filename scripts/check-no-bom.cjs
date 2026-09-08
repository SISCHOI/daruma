// Repo hygiene guard: no tracked file may start with a UTF-8 BOM.
// Why: Windows PowerShell 5.1 `Set-Content -Encoding UTF8` always writes a
// BOM, and Node's JSON.parse / some loaders reject it — a BOM in
// packages/*/package.json broke production dsh web startup on 2026-09-08.
// Any file mutation on Windows must be done with BOM-less tooling
// (edit/write tools, Node fs.writeFileSync, or PS7+ utf8NoBOM).
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)

const offenders = []
for (const file of files) {
  const full = path.join(root, file)
  let bytes
  try {
    bytes = fs.readFileSync(full)
  } catch {
    continue // submodule/symlink oddities are not BOM concerns
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offenders.push(file)
  }
}

if (offenders.length > 0) {
  console.error('BOM guard failed — these tracked files start with EF BB BF:')
  for (const f of offenders) console.error('  ' + f)
  process.exit(1)
}
console.log(`BOM guard: ${files.length} tracked files clean`)
