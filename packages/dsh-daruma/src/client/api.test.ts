/**
 * The settings page and the composer control share one api object and none of
 * their React state. A backup write is the only moment the other surface can
 * learn about the change, so the notification is part of the write, not of
 * the view that happened to issue it.
 */

import { describe, expect, it } from 'vitest'
import { createApi, type Rpc, type RpcResult } from './api.ts'

function rpc(answer: (endpoint: string, payload: unknown) => RpcResult): Rpc {
  return async (endpoint, payload) => answer(endpoint, payload ?? null)
}

describe('backup change notification', () => {
  it('notifies every listener after a write lands, and nobody after it fails', async () => {
    let fail = false
    const api = createApi(rpc((endpoint) => {
      if (fail) return { ok: false, error: { code: 'internal', message: 'no' } }
      if (endpoint === 'setBackup' || endpoint === 'clearBackup') return { ok: true, value: { ok: true } }
      return { ok: false, error: { code: 'internal', message: 'unexpected' } }
    }))
    const seen: string[] = []
    const stop = api.subscribe(() => { seen.push('dock') })
    api.subscribe(() => { seen.push('settings') })

    await api.setBackup('mt', 'glm')
    fail = true
    await expect(api.clearBackup()).rejects.toThrow('no')
    fail = false
    await api.clearBackup()
    stop()
    await api.setBackup('mt', 'glm')

    expect(seen).toEqual(['dock', 'settings', 'dock', 'settings', 'settings'])
  })

  it('keeps notifying the other listeners when one of them throws', async () => {
    const api = createApi(rpc(() => ({ ok: true, value: { ok: true } })))
    const seen: string[] = []
    api.subscribe(() => { throw new Error('stale view') })
    api.subscribe(() => { seen.push('settings') })

    await expect(api.setBackup('mt', 'glm')).resolves.toBeUndefined()
    expect(seen).toEqual(['settings'])
  })
})
