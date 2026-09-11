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

## Publishing to npm

The workspace is a **pnpm** workspace, so publish from the package directory —
`npm publish --workspace packages/dsh-daruma` fails with `No workspaces found`.

```powershell
# 0. clean tree on main, up to date
git switch main; git pull --ff-only
git status --short        # must be empty

# 1. bump only the package that changed (daruma-core keeps its version when untouched)
#    packages/dsh-daruma/package.json -> "version": "x.y.z"

# 2. gates (a fresh clone needs the build first: the workspace packages resolve
#    each other through their built lib/)
pnpm install --frozen-lockfile
pnpm run build; pnpm run typecheck; pnpm run lint; pnpm run test; pnpm run check:no-bom

# 3. dry run from the package: runs prepublishOnly (BOM guard) and packs
cd packages\dsh-daruma
pnpm publish --dry-run --no-git-checks
# expect: "📦 dsh-daruma@x.y.z → https://registry.npmjs.org/" + "Skip publishing (dry run)"

# 4. publish (needs npm auth, see below)
pnpm publish
```

Verify afterwards:

```powershell
npm view dsh-daruma dist-tags --json          # latest must be the new version
npm view dsh-daruma@x.y.z dist.tarball        # then spot-check the tarball if needed
```

### npm auth

`~/.npmrc` may hold a `//registry.npmjs.org/:_authToken` that has since been
revoked — `npm whoami` then answers `E401` while the value still looks
configured. Two ways back in:

```powershell
# a) interactive web login (browser handoff); run it in a real terminal —
#    in a non-interactive shell npm falls back to a Username:/Password: prompt
npm login --auth-type web
# b) granular token, injected for one command only (never written to disk)
$env:NPM_TOKEN = 'npm_...'
pnpm publish --config.//registry.npmjs.org/:_authToken=$env:NPM_TOKEN
```

Retire stale tokens in the npm web UI (Access Tokens) instead of leaving them in
`~/.npmrc`.

### Logging in is not enough: publish needs a second factor

A successful login (`npm whoami` → `sischoi`) can still fail the publish itself:

```
[E403] 403 Forbidden - PUT https://registry.npmjs.org/dsh-daruma
Two-factor authentication or granular access token with bypass 2fa enabled is
required to publish packages.
```

npm now requires either a one-time password **per publish** or a granular token
that is allowed to bypass 2FA. Pick one:

```powershell
# a) pass a fresh 6-digit code from the authenticator (expires in ~30 s, so
#    run it yourself rather than relaying the code through someone else)
pnpm publish --otp=123456

# b) create a granular token in the npm web UI: Access Tokens -> Granular,
#    "Bypass 2FA" enabled, Packages = dsh-daruma, permission = Read and write
npm config set //registry.npmjs.org/:_authToken=<token>
pnpm publish          # no OTP prompt afterwards
```

Notes from the 0.1.7 release:

- `www.npmjs.com` can be unreachable from a mainland-China network while
  `registry.npmjs.org` still answers: web login links then have to be opened on
  another device (a phone session works — the CLI polls, so the browser does not
  have to be the publishing machine).
- The web-login URL is bound to the waiting CLI process; if that process exits
  the link stops working, so generate a fresh one instead of reusing it.
- `npm login --auth-type=legacy` also demands an OTP when the account has 2FA
  enabled, so it is not an OTP-free fallback.

### Rollback

Within 72 hours: `npm unpublish dsh-daruma@x.y.z`. After that the version number
cannot be reused — publish `x.y.(z+1)` with a revert instead.
