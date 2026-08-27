/**
 * JSON-file implementation of the domain's `ChannelHealthStore` port.
 *
 * Persistence is best-effort: a corrupt or unreadable state file makes the
 * store start fresh rather than crashing the plugin.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChannelHealth, ChannelHealthStore, ChannelId } from 'daruma-core'

interface StoredState {
  healths?: Record<string, ChannelHealth>
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
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredState
      for (const [key, health] of Object.entries(raw.healths ?? {})) {
        this.healths.set(key as ChannelId, health as ChannelHealth)
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
      writeFileSync(this.file, JSON.stringify({ healths }, null, 2))
    } catch {
      // Persistence failure must not take down the plugin.
    }
  }
}
