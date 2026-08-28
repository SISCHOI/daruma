# start-daruma-test.ps1 — one command to start the daruma web test environment.
#
# Launches the mock LLM server in the background, then starts the daruma-test
# DSH web profile in the foreground; Ctrl+C stops dsh and kills the mock server.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-daruma-test.ps1
#   (or right-click → Run with PowerShell)
#
# Then open http://127.0.0.1:3081 in your browser to see the daruma status
# dock and the backup-channel panel.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$mockPort = 3099
$dshPort = 3081
$mockScript = Join-Path $root 'scripts\mock-llm-server.mjs'

if (-not (Test-Path $mockScript)) {
    Write-Host "mock server script not found: $mockScript" -ForegroundColor Red
    exit 1
}

# 1. Start the mock LLM server as a hidden background process.
$mockProc = Start-Process -FilePath 'node' -ArgumentList @($mockScript, "$mockPort") -PassThru -WindowStyle Hidden
Write-Host "mock LLM server started (pid $($mockProc.Id)) on :$mockPort" -ForegroundColor Cyan

# 2. The daruma-test profile's mock provider reads this env var.
$env:MOCK_API_KEY = 'dummy'

try {
    # 3. Start the DSH web profile (foreground; Ctrl+C to stop).
    Write-Host "starting dsh web on :$dshPort — Ctrl+C to stop" -ForegroundColor Cyan
    & dsh.cmd --profile daruma-test --port $dshPort
}
finally {
    # 4. Clean up the mock server on exit.
    if (-not $mockProc.HasExited) {
        Stop-Process -Id $mockProc.Id -Force
        Write-Host 'mock LLM server stopped' -ForegroundColor Cyan
    }
}
