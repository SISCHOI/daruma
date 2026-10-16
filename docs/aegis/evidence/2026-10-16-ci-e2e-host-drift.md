# Failover e2e: 0.2.x coverage, and the 0.1.x host boot break (2026-10-16)

> Branch: `fix/ci-e2e-host-matrix` (from `main` @ `09c0fd2`)
> Trigger: after the DSH 0.2 compatibility merge, `main` sat red — four e2e jobs failing while all
> six `verify` jobs passed.

## What was red and why it mattered

| job | state before |
|---|---|
| `failover e2e (ubuntu/macos, dsh 0.1.0-rc.7)` | failure |
| `failover e2e (ubuntu/macos, dsh 0.1.5-rc.2)` | failure |
| `verify (3 OS × node 22/24)` | success |

The e2e matrix had no 0.2.x entry, so the compatibility this line of work targets had never been
exercised in CI at all. The red jobs were the 0.1.x ones, which the same suite covered before the
merge.

## Root cause: the 2026-09-22 core batch 【实测】

The 0.1.x hosts die inside their **own** profile boot, before any task runs:

```
Error: dsh: user patch-layer watching requires the Cordis HMR service
    at watchUserPatches (…/dsh-app-boot/lib/index.js:764:28)
    at runProfile (…/dsh/lib/profile-boot-*.js:264:9)
```

`dsh` 0.1.x's `runProfile` loads `@deepseek-ai/cordis-plugin-hmr` and then requires the `hmr`
service in order to watch the profile patch layer (`profile-boot-*.js:256-273`). The plugin's
constructor in the 2026-09-22 batch gained a hard requirement:

```js
if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service");
```

Those CLIs never pass `--expose-internals`, and Node refuses that flag through `NODE_OPTIONS`
(`--expose-internals is not allowed in NODE_OPTIONS`, measured). The service therefore never
registers, the watch call throws, and boot ends — daruma's own boot line is written first, so the
plugin loads; the host kills itself afterwards.

Publish dates put the drift between the last green run (2026-09-17) and the first red one
(2026-10-13):

| package | 2026-09-22 | previous |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.3, 4.0.4 | 4.0.2 (08-30) |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.4, 1.0.5 | 1.0.3 (08-30) |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.18, 1.0.19 | 1.0.17 (08-30) |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.5, 1.1.6 | 1.1.4 (08-30) |

Both 0.1.x hosts declare all four through caret ranges, so an install today picks the new batch.

**Not a daruma regression**【实测】: the pre-merge e2e script (`git show 48914ef:scripts/e2e-failover.mjs`)
fails identically against the same host tree — same six failures, same HMR error. The plugin is
compatible; the host's own post-boot step is not.

## Fix

1. **e2e matrix now covers the hosts the README claims**: `0.2.0-rc.2` and `0.2.1-alpha.2` join
   `0.1.0-rc.7` and `0.1.5-rc.2`, on ubuntu and macOS.
2. **Each entry runs two modes**: the plain failover run and the seeded-backup run (`--backup`),
   so the backup-channel storage of each host generation is exercised.
3. **The host installs into a throwaway project instead of `--global`**, which is what allows the
   0.1.x lines to hold the core batch at its pre-09-22 versions (cordis 4.0.2, loader 1.0.3,
   timer 1.1.4, hmr 1.0.17). The set is peer-consistent and satisfies both hosts' declared ranges:
   cordis 4.0.2 peers loader `^1.0.3`; loader 1.0.3 and timer 1.1.4 peer cordis `^4.0.2`;
   `dsh-app-boot` peers cordis `^4.0.1`, loader `^1.0.2`, hmr `^1.0.16`.
   Do **not** reach for `--legacy-peer-deps` here: `dsh-app-boot` declares that whole set as
   `peerDependencies`, so skipping peers leaves the host without `@deepseek-ai/cordis-plugin-group`
   and it dies on module resolution instead (measured — first CI attempt).
4. The 0.2.x lines take the default resolution: they pull `@deepseek-ai/dsh-hmr` rather than
   `cordis-plugin-hmr` and boot fine on the current batch.

## Verification

Local (Windows, node 24.19.0), every host in both modes:

| host | plain failover | seeded backup |
|---|---|---|
| `0.1.0-rc.7` (pinned core batch) | 7/7 | 7/7 |
| `0.2.0-rc.2` | 7/7 | 7/7 |
| `0.2.1-alpha.2` | 7/7 | 7/7 |

`0.1.0-rc.7` unpinned fails 6/7 with the HMR error above (before the fix), and passes 7/7 with
the pinned batch after it — the pin is what moves it.

CI (branch `fix/ci-e2e-host-matrix`):

| run | result |
|---|---|
| `38889708939` (first attempt) | 0.2.x 4/4 green; 0.1.x red with the peer-skip error |
| `38891026340` | 13/14 green; `macos-latest, dsh 0.1.0-rc.7` failed inside `npm install` itself — `JavaScript heap out of memory` after five minutes, and its rerun failed the same way, so it was not a one-off |
| `38892899329` (heap raised for the install step) | 14/14 green |

The macOS arm64 runner could not resolve the pinned tree inside npm's 2 GB default heap, so the
install step now runs with `--max-old-space-size=4096` and retries once.

## Open

- Hosts `>=0.3.0` remain out of the peer range on purpose.
- The 0.1.x pin is a reconstruction of the batch those hosts were validated against. If a future
  host line needs a newer cordis in the same matrix, the pin has to become per-entry rather than
  per-line.
