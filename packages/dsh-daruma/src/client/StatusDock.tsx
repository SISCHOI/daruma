/**
 * DarumaStatus: a compact control at the right end of the composer tool row,
 * next to the model selector. Shows overall channel health and the backup
 * selection; clicking it opens the backup-channel panel.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconCheckOutline16, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DarumaApi, StatusView } from './api.ts'
import { overallState, type Dot } from './health.ts'
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

/** Status glyph: a check when healthy, a warning otherwise. */
function StatusIcon(props: { state: Dot }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', color: iconColor[props.state], flexShrink: 0 }}>
      {props.state === 'done'
        ? <IconCheckOutline16 size={14} />
        : <IconWarningOutline16 size={14} />}
    </span>
  )
}

export function StatusDock(props: { api: DarumaApi; t: Translate }): React.JSX.Element {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const value = await props.api.status()
      setStatus(value)
    } catch {
      // keep last good snapshot; the control stays quiet on RPC failure
    }
  }, [props.api])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

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
            void load()
          }}
        />
      )}
    </>
  )
}
