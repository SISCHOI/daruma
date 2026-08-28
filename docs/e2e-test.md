# End-to-end failover test

Verifies `dsh-daruma` actually fails over at runtime: the primary channel returns
429, daruma trips it and switches to the fallback channel, and the task
completes.

## One-command web test environment

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-daruma-test.ps1
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

`~/.dsh/profiles/daruma-headless/cordis.patch.yml`:

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
```

The `settings.path` points at the profile-local file, so the global
`~/.dsh/settings.yaml` is never touched.

## 3. Run the task

```bash
$env:MOCK_API_KEY='dummy'   # PowerShell; use `export` on Unix
dsh --profile daruma-headless "Reply with exactly: OK"
```

Expected output: `mock completion from mock-b`, exit code 0. The mock server
log shows the failover sequence:

```
[mock] request model=mock-a stream=true -> 429
[mock] request model=mock-b stream=true -> 200
```
