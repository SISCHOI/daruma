# daruma-watch

Daruma watchdog daemon for Codex CLI and Claude Code — detects non-human
interruption and resumes the session.

## Usage

```bash
npx daruma-watch \
  --cmd "codex exec -m gpt-5.6-sol 'finish the migration'" \
  --resume "codex exec resume --last" \
  --max-resumes 3 \
  --stall-timeout 600000
```

For Claude Code:

```bash
npx daruma-watch \
  --cmd "claude -p 'finish the migration'" \
  --resume "claude --resume <session-id>" \
  --max-resumes 3
```

## Behavior

1. Run `--cmd`; forward its output.
2. If it exits 0 → done.
3. If it is killed by a signal, exits non-zero, or stalls (no output for
   `--stall-timeout`) → resume with `--resume` after bounded exponential
   backoff.
4. Repeat up to `--max-resumes`, then give up.

`--skip-exit-codes 130,1` marks exit codes that mean "intentional" and must not
trigger a resume.

## Options

```
--cmd <string>            Command to run (required).
--resume <string>         Command to resume with (required).
--max-resumes <n>         Max resume attempts (default 3).
--stall-timeout <ms>      Idle time before the process is considered stalled (default 600000).
--backoff-initial <ms>    Backoff initial delay (default 1000).
--backoff-max <ms>        Backoff max delay (default 30000).
--skip-exit-codes <list>  Comma-separated exit codes meaning "intentional".
```

## Development

```bash
pnpm --filter daruma-watch build
pnpm --filter daruma-watch test
```
