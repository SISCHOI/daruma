/**
 * Daruma status service: the `daruma` settings namespace (user-chosen backup
 * channel) plus the runtime status snapshot surface.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@deepseek-ai/dsh-settings'

export const DARUMA_NS = settingsNamespace('daruma')

const backupShape = z.object({
  provider: z.string(),
  model: z.string(),
})

/** The `daruma:` settings namespace schema. */
export const DarumaSettingsSchema = z.object({
  backup: backupShape,
})

export interface DarumaSettings {
  backup?: { provider: string; model: string }
}

export interface BackupSelection {
  readonly provider: string
  readonly model: string
}

/** True when a value is a usable backup selection (non-empty strings). */
function isValidBackup(value: unknown): value is BackupSelection {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<BackupSelection>
  return typeof candidate.provider === 'string' && candidate.provider !== ''
    && typeof candidate.model === 'string' && candidate.model !== ''
}

export class StatusService {
  constructor(
    private readonly settings: SettingsProvider,
    private readonly scope: SettingsScope<DarumaSettings>,
  ) {}

  getBackup(): BackupSelection | undefined {
    const backup = this.scope.get().backup
    // The settings layer can resolve an absent section to an empty object;
    // treat any selection without non-empty provider/model as unset.
    return isValidBackup(backup) ? backup : undefined
  }

  async setBackup(selection: BackupSelection): Promise<void> {
    await this.scope.update({ backup: selection })
  }

  async clearBackup(): Promise<void> {
    await this.settings.mutate(DARUMA_NS, [{ op: 'unset', path: ['backup'] }])
  }
}

/** Register the namespace and return the service. */
export function mountStatus(ctx: Context): StatusService {
  const scope = ctx.settings.register(DARUMA_NS, DarumaSettingsSchema as never) as unknown as SettingsScope<DarumaSettings>
  return new StatusService(ctx.settings, scope)
}
