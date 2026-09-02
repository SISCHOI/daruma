/**
 * JSON-file implementation of the domain's `ChannelHealthStore` port.
 *
 * Persistence is best-effort: a corrupt or unreadable state file makes the
 * store start fresh rather than crashing the plugin.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChannelHealth, ChannelHealthStore, ChannelId } from 'daruma-core'

interface StoredState {
  healths?: Record<string, ChannelHealth>
}

function isHealth(value: unknown, key: string): value is ChannelHealth {
  if (typeof value !== 'object' || value === null) return false
  const h = value as Partial<ChannelHealth>
  return h.channel === key
    && (h.state === 'HEALTHY' || h.state === 'COOLDOWN' || h.state === 'PROBE')
    && Number.isSafeInteger(h.consecutiveFailures) && (h.consecutiveFailures as number) >= 0
    && Number.isFinite(h.cooldownUntilMs) && (h.cooldownUntilMs as number) >= 0
    && Number.isFinite(h.updatedAtMs) && (h.updatedAtMs as number) >= 0
}

export class JsonFileChannelHealthStore implements ChannelHealthStore {
  private readonly healths = new Map<ChannelId, ChannelHealth>()
  private loaded = false

  constructor(private readonly file: string) {}

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      if (!statSync(this.file).isFile()) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredState
      for (const [key, health] of Object.entries(raw.healths ?? {})) {
        if (isHealth(health, key)) this.healths.set(key as ChannelId, health)
      }
    } catch {
      // Corrupt state: start fresh.
    }
  }

  load(channel: ChannelId): ChannelHealth | undefined {
    this.ensureLoaded()
    return this.healths.get(channel)
  }

  save(health: ChannelHealth): void {
    this.ensureLoaded()
    this.healths.set(health.channel, health)
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const healths: Record<string, ChannelHealth> = {}
      for (const [key, health] of this.healths) healths[key] = health
      const temporary = `${this.file}.tmp-${process.pid}`
      const serialized = JSON.stringify({ healths }, null, 2)
      writeFileSync(temporary, serialized, { mode: 0o600 })
      try {
        renameSync(temporary, this.file)
      } catch {
        // Keep a compatibility fallback for filesystems where replacement
        // rename is unavailable.
        writeFileSync(this.file, serialized, { mode: 0o600 })
        try { unlinkSync(temporary) } catch { /* best effort cleanup */ }
      }
      chmodSync(this.file, 0o600)
    } catch {
      // Persistence failure must not take down the plugin.
    }
  }
}
