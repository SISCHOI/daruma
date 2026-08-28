# Deploying daruma into the live web profile

Steps to enable daruma failover on the production DSH web profile (the one
serving `http://127.0.0.1:3080`).

## 1. Install the plugin (link for local dev)

```powershell
dsh plugin --profile web add `
  link:C:/Users/shanzhiyu/code/daruma/packages/daruma-core `
  link:C:/Users/shanzhiyu/code/daruma/packages/dsh-daruma
```

`daruma-core` installs as a plain dependency (no `dsh.bundle`), `dsh-daruma`
joins the profile's bundle stack. Once published to npm, replace the `link:`
paths with `dsh-daruma` (core comes along as a dependency).

## 2. Configure the failover chain

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-daruma
  name: dsh-daruma
  config:
    channels:
      - provider: deepseek-official
        model: deepseek-v4-pro
      - provider: mt
        model: glm-5.3
      - provider: mt-cc
        model: claude-3-5-haiku-latest
    failureBudget: 3
    cooldownMs: 30000
    giveUpBudget: 8
```

`channels` is the fallback chain: when the channel in use trips, daruma tries
each remaining entry in order. The chain above reflects the local
`~/.dsh/settings.yaml` at the time of writing (default `deepseek-v4-pro`,
`mt` channel's `glm-5.3`, `mt-cc`'s `claude-3-5-haiku-latest`) — adjust to your
current model selection.

## 3. Restart the web profile

Installing a new bundle is not hot-reloaded — restart DSH:

```powershell
# stop the running dsh web, then:
dsh web
```

The daruma status control appears at the right end of the composer tool row
(next to the model selector); the `/dsh-daruma` RPC channel starts serving.

## 4. Verify

```powershell
# status RPC (after restart)
$body = '{"type":"client-request","rpcId":"v","method":"status","payload":{}}'
Invoke-WebRequest -Uri http://127.0.0.1:3080/dsh-daruma/status `
  -Method POST -ContentType 'application/json' -Body $body
```

Expect `channels` with your chain and `providers` with the known provider
names.

## Rollback

```powershell
# remove the daruma entry from web/cordis.patch.yml (backup kept as
# cordis.patch.yml.bak-daruma), then:
dsh plugin --profile web remove dsh-daruma daruma-core
```
