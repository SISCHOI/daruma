import { describe, expect, it, vi } from 'vitest'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { StatusService } from './status.ts'

function makeScope(value: unknown): SettingsScope<never> {
  return {
    get: () => value,
    watch: () => () => {},
    update: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  } as unknown as SettingsScope<never>
}

const settings = { mutate: vi.fn().mockResolvedValue(undefined) } as unknown as SettingsProvider

describe('StatusService.getBackup', () => {
  it('returns undefined when the section is absent', () => {
    const service = new StatusService(settings, makeScope({}))
    expect(service.getBackup()).toBeUndefined()
  })

  it('returns a valid backup selection', () => {
    const service = new StatusService(settings, makeScope({ backup: { provider: 'mt', model: 'glm-5.2' } }))
    expect(service.getBackup()).toEqual({ provider: 'mt', model: 'glm-5.2' })
  })

  it('treats an empty-object backup as unset (settings quirk)', () => {
    const service = new StatusService(settings, makeScope({ backup: {} }))
    expect(service.getBackup()).toBeUndefined()
  })

  it('treats a backup with blank fields as unset', () => {
    const service = new StatusService(settings, makeScope({ backup: { provider: '', model: 'x' } }))
    expect(service.getBackup()).toBeUndefined()
  })
})
