/**
 * DarumaStatus: a compact control at the right end of the composer tool row,
 * next to the model selector. Shows overall channel health and the backup
 * selection; clicking it opens the backup-channel panel.
 */

import { useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DarumaApi } from './api.ts'
import { overallState, type Dot } from './health.ts'
import { useLiveStatus } from './live-status.ts'
import { BackupPanel } from './BackupPanel.tsx'

type Translate = (key: string) => string

const controlStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const iconColor: Record<Dot, string> = {
  done: 'var(--dsw-text-success, #30a46c)',
  warning: 'var(--dsw-text-warning, #f5a524)',
  error: 'var(--dsw-text-danger, #e5484d)',
  ongoing: 'var(--dsw-text-secondary, #888)',
}

/**
 * Status glyph.
 *
 * `StateDot` is the one status primitive whose export name survived the client
 * rename between host generations — the sized icons did not (`IconCheckOutline16`
 * exists through `0.1.x`, `IconCheckOutlineMedium` from `0.2`), and importing a
 * name the host does not export yields `undefined`, which throws inside the slot
 * render and takes the whole control down with it. The coloured dot is the
 * fallback for a host that ever drops `StateDot` too.
 */
function StatusIcon(props: { state: Dot }): React.JSX.Element {
  if (typeof StateDot === 'function') {
    return (
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <StateDot state={props.state} />
      </span>
    )
  }
  return (
    <span
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: iconColor[props.state],
      }}
    />
  )
}

export function StatusDock(props: { api: DarumaApi; t: Translate }): React.JSX.Element {
  const [panelOpen, setPanelOpen] = useState(false)
  // Health still drifts with traffic, so keep the slow poll; a backup change
  // arrives through the api subscription instead of waiting for that poll.
  const { status, reload } = useLiveStatus(props.api, 30_000)

  const t = props.t
  const backupLabel = status?.backup !== null && status?.backup !== undefined
    ? `${status.backup.provider}/${status.backup.model}`
    : t('backupNone')

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={t('backupManageHint')}
        onClick={() => setPanelOpen(true)}
        style={controlStyle}
      >
        <StatusIcon state={overallState(status?.channels ?? null, Date.now())} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('backup')}: {backupLabel}
        </span>
      </Button>
      {panelOpen && (
        <BackupPanel
          api={props.api}
          t={t}
          status={status}
          onClose={() => {
            setPanelOpen(false)
            reload()
          }}
        />
      )}
    </>
  )
}
