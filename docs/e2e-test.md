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
`--mock-port <port>`, `--failure-budget <n>` (default 1), `--max-retries <n>`
(default 0), `--keep` (keep the temp home for inspection). The production
`~/.dsh` is never touched.

> On Windows, pass the CLI's JS entry rather than a `dsh.ps1` shim: the script
> launches the host through a shell, and `cmd` cannot run a PowerShell script —
> the symptom is a silent `exit 0` with no output and no boot line.
> `--dsh C:\Users\<you>\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js`.

### Retry-exhaustion escalation

`--failure-budget 3` is the run that distinguishes the escalation from ordinary
counting. The in-box `dsh-llm-retry` spends the channel's retry budget before
daruma is consulted, so one failing turn is one failure to daruma; without the
escalation a `failureBudget` of 3 would need three failing turns and the run
would produce no failover line at all. `--max-retries 5` additionally reproduces
the production shape (the whole retry budget burned before delegation):

```bash
node scripts/e2e-failover.mjs --dsh <bin.js> --failure-budget 3 --max-retries 5
```

Expect: `mock completion from mock-b`, exit 0, a failover line whose
`reason` is `RATE_LIMIT` **and** `retryExhausted` is `true`, and
`mock::mock-a` persisted as `COOLDOWN` with `consecutiveFailures: 1`.

> **Running inside WSL?** WSL appends the Windows PATH, so a bare `dsh` can
> resolve to the **Windows** install under `/mnt/c/…`; Linux node then fails to
> load its `sharp`/`koffi` binaries. The script refuses such a host before
> starting anything (exit 2) and prints the fix — install the host inside the
> distro and put its bin directory first on PATH:
>
> ```bash
> npm install --global @deepseek-ai/dsh@0.1.0-rc.7
> export PATH="$(npm prefix --global)/bin:$PATH"
> pnpm run e2e:failover
> ```

The manual walkthrough below is the same scenario step by step, for when you
want to watch it in the browser or debug a specific stage.

### Testing an older host line

`--dsh <path>` exists so a host can be installed per test line instead of
globally. That matters because an old host's caret ranges drift under it: `dsh`
0.1.x pulls `cordis`, `cordis-plugin-loader`, `cordis-plugin-timer` and
`cordis-plugin-hmr` through `^` ranges, and the 2026-09-22 batch of those four
broke every 0.1.x CLI's headless boot:

```
Error: dsh: user patch-layer watching requires the Cordis HMR service
    at watchUserPatches (…/dsh-app-boot/lib/index.js:764:28)
    at runProfile (…/dsh/lib/profile-boot-*.js:264:9)
```

The new `cordis-plugin-hmr` throws from its constructor unless
`ctx.loader.internal` exists — i.e. unless Node runs with `--expose-internals` —
and the 0.1.x CLIs never pass that flag. Node also refuses it through
`NODE_OPTIONS` (`--expose-internals is not allowed in NODE_OPTIONS`), so the
host cannot be rescued from the outside. Pin the batch those hosts were
validated against:

```bash
mkdir ~/dsh-host && cd ~/dsh-host
npm init -y
npm pkg set 'dependencies.@deepseek-ai/dsh=0.1.0-rc.7'
npm pkg set 'overrides.@deepseek-ai/cordis=4.0.2'
npm pkg set 'overrides.@deepseek-ai/cordis-plugin-loader=1.0.3'
npm pkg set 'overrides.@deepseek-ai/cordis-plugin-timer=1.1.4'
npm pkg set 'overrides.@deepseek-ai/cordis-plugin-hmr=1.0.17'
npm install
node scripts/e2e-failover.mjs --dsh "$PWD/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

The set is peer-consistent: `cordis` 4.0.2 peers loader `^1.0.3`; loader 1.0.3
and timer 1.1.4 peer `cordis ^4.0.2`; `dsh-app-boot` peers `cordis ^4.0.1`,
loader `^1.0.2`, hmr `^1.0.16`. Do **not** reach for `--legacy-peer-deps`:
`dsh-app-boot` declares that whole set as `peerDependencies`, so skipping peers
leaves the host without `@deepseek-ai/cordis-plugin-group` and it dies on module
resolution instead. The 0.2.x lines need no pin — they use
`@deepseek-ai/dsh-hmr` rather than `cordis-plugin-hmr` and boot on the current
batch.

On CI's macOS arm64 runners, resolving the pinned tree can exceed npm's 2 GB
default heap (`JavaScript heap out of memory` after ~5 minutes). Install with
`NODE_OPTIONS=--max-old-space-size=4096` there.

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
