/**
 * Daruma status service: the user-chosen backup channel.
 *
 * Two host generations store it differently:
 *
 * - DSH 0.1.x ships a namespaced settings service (`register` / `mutate`), and
 *   the backup lives in its `daruma` namespace as it always has.
 * - DSH 0.2.x replaced that service with Config forms over the profile patch
 *   (`SettingsForms`: `describe` / `update` / `mutate`, no `register`). Editing
 *   daruma's own Config there reloads the plugin, which would discard the
 *   in-memory failover state on every backup pick, so the backup is kept in a
 *   small JSON file next to the channel-health state instead.
 *
 * The host's settings service is detected by shape, so nothing here imports a
 * runtime value from `@deepseek-ai/dsh-settings` (0.1.5 does not export
 * `settingsNamespace`, and 0.2 does not export `SettingsProvider`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Namespace of the legacy (0.1.x) settings section. */
export const DARUMA_NS = 'daruma'

const backupShape = z.object({
  provider: z.string(),
  model: z.string(),
})

/** The legacy `daruma:` settings namespace schema. */
export const DarumaSettingsSchema = z.object({
  backup: backupShape,
})

export interface BackupSelection {
  readonly provider: string
  readonly model: string
}

/** True when a value is a usable backup selection (non-empty strings). */
export function isValidBackup(value: unknown): value is BackupSelection {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<BackupSelection>
  return typeof candidate.provider === 'string' && candidate.provider !== ''
    && typeof candidate.model === 'string' && candidate.model !== ''
}

/** Where a backup selection is read from and written to. */
export interface BackupStorage {
  /** Which storage is in use, for the boot log. */
  readonly kind: 'settings-namespace' | 'file'
  get(): BackupSelection | undefined
  set(selection: BackupSelection): Promise<void>
  clear(): Promise<void>
}

/** The registered section handle of the 0.1.x settings service. */
export interface LegacySettingsScope {
  get(): { backup?: unknown } | undefined
  update(patch: object): Promise<void>
}

/** Structural shape of the 0.1.x namespaced settings service. */
export interface LegacySettingsService {
  register(ns: string, schema: unknown): LegacySettingsScope
  mutate(ns: string, ops: readonly { op: 'unset'; path: readonly string[] }[]): Promise<void>
}

/** Whether the host's `settings` service is the 0.1.x namespaced provider. */
export function isLegacySettingsService(value: unknown): value is LegacySettingsService {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<'register' | 'mutate', unknown>>
  return typeof candidate.register === 'function' && typeof candidate.mutate === 'function'
}

/** Backup storage over the 0.1.x `daruma` settings namespace. */
export function settingsBackupStorage(settings: LegacySettingsService): BackupStorage {
  const scope = settings.register(DARUMA_NS, DarumaSettingsSchema)
  return {
    kind: 'settings-namespace',
    get() {
      // The settings layer can resolve an absent section to an empty object;
      // any selection without non-empty provider/model counts as unset.
      const backup = scope.get()?.backup
      return isValidBackup(backup) ? { provider: backup.provider, model: backup.model } : undefined
    },
    async set(selection) {
      await scope.update({ backup: { provider: selection.provider, model: selection.model } })
    },
    async clear() {
      await settings.mutate(DARUMA_NS, [{ op: 'unset', path: ['backup'] }])
    },
  }
}

/**
 * Backup storage in a JSON file (`{ "backup": { provider, model } }`).
 *
 * Read once and cached; writes go through a temp file and a rename, like the
 * channel-health store. Unlike that store, a failed write is reported to the
 * caller: the user picked a backup in the UI and should see it did not stick.
 * A missing, unreadable, or malformed file reads as "no backup".
 */
export function fileBackupStorage(file: string): BackupStorage {
  let loaded = false
  let current: BackupSelection | undefined

  const load = (): void => {
    if (loaded) return
    loaded = true
    try {
      if (!existsSync(file) || !statSync(file).isFile()) return
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { backup?: unknown }
      if (isValidBackup(raw.backup)) current = { provider: raw.backup.provider, model: raw.backup.model }
    } catch {
      // Corrupt file: no backup.
    }
  }

  const persist = (next: BackupSelection | undefined): void => {
    mkdirSync(dirname(file), { recursive: true })
    const serialized = `${JSON.stringify(next === undefined ? {} : { backup: next }, null, 2)}\n`
    const temporary = `${file}.tmp-${process.pid}`
    writeFileSync(temporary, serialized, { mode: 0o600 })
    try {
      renameSync(temporary, file)
    } catch {
      writeFileSync(file, serialized, { mode: 0o600 })
      try { unlinkSync(temporary) } catch { /* best effort cleanup */ }
    }
    try { chmodSync(file, 0o600) } catch { /* not supported everywhere */ }
  }

  return {
    kind: 'file',
    get() {
      load()
      return current
    },
    async set(selection) {
      load()
      const next = { provider: selection.provider, model: selection.model }
      persist(next)
      current = next
    },
    async clear() {
      load()
      persist(undefined)
      current = undefined
    },
  }
}

export class StatusService {
  constructor(private readonly storage: BackupStorage) {}

  /** Which storage holds the backup on this host. */
  get storageKind(): BackupStorage['kind'] {
    return this.storage.kind
  }

  getBackup(): BackupSelection | undefined {
    return this.storage.get()
  }

  async setBackup(selection: BackupSelection): Promise<void> {
    await this.storage.set(selection)
  }

  async clearBackup(): Promise<void> {
    await this.storage.clear()
  }
}

/**
 * Pick the backup storage the host supports.
 *
 * @param settings - the host's `settings` service, whatever generation it is.
 * @param backupFile - file used when the host has no namespaced settings.
 */
export function mountStatus(settings: unknown, backupFile: string): StatusService {
  return new StatusService(
    isLegacySettingsService(settings) ? settingsBackupStorage(settings) : fileBackupStorage(backupFile),
  )
}
