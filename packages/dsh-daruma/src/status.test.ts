import { describe, expect, it } from 'vitest'
import { settingsBackupStorage, type LegacySettingsScope, type LegacySettingsService } from './status.ts'

const mockScope = (value: unknown): LegacySettingsScope => ({
  get: () => ({ backup: value }),
  update: async () => {},
})

const mockSettings = (scope: LegacySettingsScope): LegacySettingsService => ({
  register: () => scope,
  mutate: async () => {},
})

describe('StatusService.getBackup', () => {
  it('returns undefined when the section is absent', () => {
    const storage = settingsBackupStorage(mockSettings(mockScope({})))
    expect(storage.get()).toBeUndefined()
  })

  it('returns a valid backup selection', () => {
    const storage = settingsBackupStorage(mockSettings(mockScope({ provider: 'mt', model: 'glm-5.2' })))
    expect(storage.get()).toEqual({ provider: 'mt', model: 'glm-5.2' })
  })

  it('treats an empty-object backup as unset (settings quirk)', () => {
    const storage = settingsBackupStorage(mockSettings(mockScope({})))
    expect(storage.get()).toBeUndefined()
  })

  it('treats a backup with blank fields as unset', () => {
    const storage = settingsBackupStorage(mockSettings(mockScope({ provider: '', model: 'x' })))
    expect(storage.get()).toBeUndefined()
  })
})
