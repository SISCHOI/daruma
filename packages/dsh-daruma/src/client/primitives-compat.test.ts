/**
 * Guards the host-primitives contract the panel depends on.
 *
 * The two client generations export different sized-icon names —
 * `IconCheckOutline16` through `0.1.x`, `IconCheckOutlineMedium`/`Regular` from
 * `0.2`. Importing a name the host does not export yields `undefined`, and
 * rendering it throws inside the slot, which takes the whole control down
 * without a trace. That is exactly what happened on `0.2` until the dock moved
 * to `StateDot`, an export both generations carry.
 *
 * The mock below mirrors the `0.2` export set (dot and layout primitives only),
 * so re-introducing a generation-specific icon import fails here rather than
 * silently blanking the panel on a real host.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: unknown }) => props.children ?? null,
  Modal: (props: { children?: unknown }) => props.children ?? null,
  Pill: (props: { children?: unknown }) => props.children ?? null,
  StateDot: () => null,
}))

const { StatusDock } = await import('./StatusDock.tsx')
const { BackupPanel, BackupSettings } = await import('./BackupPanel.tsx')

const t = (key: string): string => key
const api = { status: async () => null } as never

describe('rendering against the 0.2 primitives export set', () => {
  it('renders the composer status control', () => {
    const html = renderToStaticMarkup(createElement(StatusDock, { api, t }))
    expect(html).toContain('backupNone')
  })

  it('renders the settings picker inline', () => {
    const html = renderToStaticMarkup(createElement(BackupSettings, { api, t }))
    expect(html).toContain('providerPlaceholder')
  })

  it('renders the modal picker', () => {
    const html = renderToStaticMarkup(
      createElement(BackupPanel, { api, t, status: null, onClose: () => {} }),
    )
    expect(html).toContain('providerPlaceholder')
  })
})
