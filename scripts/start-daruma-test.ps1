# start-daruma-test.ps1 — Windows entry point for the daruma web test environment.
#
# The launcher itself is scripts/start-daruma-test.mjs so that Windows, Linux
# and macOS all share one implementation; this wrapper only keeps the familiar
# PowerShell invocation working.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-daruma-test.ps1
#   (or right-click → Run with PowerShell)
#
# Then open http://127.0.0.1:3082 in your browser to see the daruma status
# dock and the backup-channel panel. On Linux/macOS use:
#   node scripts/start-daruma-test.mjs

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-daruma-test.mjs'
if (-not (Test-Path $launcher)) {
    Write-Host "launcher not found: $launcher" -ForegroundColor Red
    exit 1
}

& node $launcher @args
exit $LASTEXITCODE
