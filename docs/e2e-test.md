# End-to-end failover test

Verifies `dsh-daruma` actually fails over at runtime: the primary channel returns
429, daruma trips it and switches to the fallback channel, and the task
completes.

## One command, any OS (recommended)

```bash
pnpm run build          # the check runs the built lib/
pnpm run e2e:failover   # Windows, Linux, macOS — same script
```

`scripts/e2e-failover.mjs` creates a throwaway DSH home under the OS temp
directory, links this checkout's `dsh-daruma`/`daruma-core` into a headless
profile, starts the mock LLM server on `:3099`, runs one task and asserts:

1. the task prints `mock completion from mock-b` and exits 0,
2. the profile-local `failover-log.jsonl` has a `boot` line and a `failover`
   line `mock::mock-a -> mock::mock-b` with reason `RATE_LIMIT`,
3. the profile-local `channel-health.json` marks `mock::mock-a` as `COOLDOWN`
   and `mock::mock-b` as `HEALTHY`.

Useful flags: `--dsh <command|path-to-bin.js>` (test a specific host build),
`--mock-port <port>`, `--keep` (keep the temp home for inspection). The
production `~/.dsh` is never touched.

The manual walkthrough below is the same scenario step by step, for when you
want to watch it in the browser or debug a specific stage.

## One-command web test environment

Windows (PowerShell wrapper) and any OS (Node):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-daruma-test.ps1
```

```bash
pnpm run start:test
```

Starts the mock LLM server and the `daruma-test` DSH web profile together
(`http://127.0.0.1:3081`), then cleans both up on Ctrl+C. Open the browser to
see the channel-status dock and the backup-channel panel.

## Prerequisites

- A built `dsh-daruma` (`pnpm --filter dsh-daruma build`).
- A test profile with `dsh-daruma` linked in and a local mock provider
  (see below).

## 1. Start the mock LLM server

`scripts/mock-llm-server.mjs` serves an OpenAI-compatible endpoint:
`mock-a` returns 429, every other model returns a valid completion.

```bash
node scripts/mock-llm-server.mjs 3099
```

## 2. Create an isolated headless profile

```bash
dsh plugin --profile daruma-headless --help                # init
dsh plugin --profile daruma-headless add \
  link:./packages/daruma-core link:./packages/dsh-daruma   # link the plugin
```

Then edit `~/.dsh/profiles/daruma-headless/package.json` to add
`@deepseek-ai/dsh-headless` to `dsh.profile.bundles`, and write two files:

`~/.dsh/profiles/daruma-headless/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    mock:
      api: openai-completions
      apiKeyEnv: MOCK_API_KEY
      baseURL: http://127.0.0.1:3099/v1
      retryPolicy:
        mode: normal
        maxRetries: 0
      models:
        - { id: mock-a, contextWindow: 65536 }
        - { id: mock-b, contextWindow: 65536 }
agent-default-model:
  provider: mock
  model: mock-a
```

`~/.dsh/profiles/daruma-headless/cordis.patch.yml` (the profile lives under
`$DSH_HOME/profiles/…`; use whatever absolute paths your platform needs —
`C:/Users/<you>/…` on Windows, `/home/<you>/…` or `/Users/<you>/…` on
Linux/macOS):

```yaml
- id: settings
  name: '@deepseek-ai/dsh-settings-file'
  config:
    path: C:/Users/<you>/.dsh/profiles/daruma-headless/settings.yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - { provider: mock, model: mock-a }
      - { provider: mock, model: mock-b }
    failureBudget: 1
    # REQUIRED: isolate the state file (and its sibling failover log) from
    # production. Without this, mock channels pollute
    # ~/.dsh/daruma/channel-health.json and future audits read fake entries.
    stateFile: C:/Users/<you>/.dsh/profiles/daruma-headless/channel-health.json
```

The `settings.path` points at the profile-local file, so the global
`~/.dsh/settings.yaml` is never touched. The `stateFile` likewise keeps the
plugin's persisted health (and, since 0.1.4, the `failover-log.jsonl` written
next to it) inside the test profile instead of `~/.dsh/daruma/`. When
`stateFile` is left unset the plugin defaults to `$DSH_HOME/daruma/…` (or
`~/.dsh/daruma/…` when `DSH_HOME` is unset) on every platform.

## 3. Run the task

```bash
$env:MOCK_API_KEY='dummy'   # PowerShell; use `export MOCK_API_KEY=dummy` on Linux/macOS
dsh --profile daruma-headless "Reply with exactly: OK"
```

Expected output: `mock completion from mock-b`, exit code 0. The mock server
log shows the failover sequence:

```
[mock] request model=mock-a stream=true -> 429
[mock] request model=mock-b stream=true -> 200
```

## 4. Post-run assertions

After the task completes, verify three things:

1. **Production isolation.** `~/.dsh/daruma/channel-health.json` is unchanged
   (no `mock::` entries appeared; mock channels live only in the profile-local
   `stateFile`).
2. **Durable failover log.** The profile-local `failover-log.jsonl` (sibling of
   the configured `stateFile`) contains a `kind:"boot"` line and a
   `kind:"failover"` line with `"from":"mock::mock-a"`, `"to":"mock::mock-b"`,
   `"reason":"RATE_LIMIT"`.
3. **Success reset.** Run the task once more — this time with the primary
   healthy (restart the mock server so `mock-a` returns 200, or point
   `agent-default-model` at `mock-a` with a healthy server). After it
   completes, the profile-local `channel-health.json` shows `mock-a` back at
   `HEALTHY` with `consecutiveFailures: 0` — the `agent/pre-step` success hook
   closed the circuit that the first run had tripped.
