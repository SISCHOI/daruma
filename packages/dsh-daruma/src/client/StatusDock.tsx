/**
 * DarumaStatusDock: a compact channel-status row above the composer. Shows the
 * current channel, the backup selection, per-channel health dots, and the
 * failover count; opens the backup-channel panel.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelState, DarumaApi, StatusView } from './api.ts'
import { BackupPanel } from './BackupPanel.tsx'

type Translate = (key: string) => string

const STATE_DOT: Record<ChannelState, 'done' | 'warning' | 'ongoing' | 'error'> = {
  HEALTHY: 'done',
  COOLDOWN: 'error',
  PROBE: 'warning',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 8px',
  fontSize: '12px',
  lineHeight: '16px',
  overflowX: 'auto',
}

const metaStyle: React.CSSProperties = { color: 'var(--dsw-text-secondary, #888)', whiteSpace: 'nowrap' }

export function StatusDock(props: { api: DarumaApi; t: Translate }): React.JSX.Element {
  const [status, setStatus] = useState<StatusView | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const value = await props.api.status()
      setStatus(value)
    } catch {
      // keep last good snapshot; the dock stays quiet on RPC failure
    }
  }, [props.api])

  useEffect(() => {
    void load()
  }, [load])

  const t = props.t

  return (
    <div className="daruma-status-dock" style={rowStyle}>
      {status === null ? (
        <span style={metaStyle}>{t('empty')}</span>
      ) : (
        <>
          {status.current !== null && (
            <span style={metaStyle}>
              {t('current')}: <strong>{status.current}</strong>
            </span>
          )}
          <span style={metaStyle}>
            {t('backup')}:{' '}
            {status.backup !== null
              ? `${status.backup.provider}/${status.backup.model}`
              : t('backupNone')}
          </span>
          {status.channels.map((channel) => (
            <Pill key={channel.channel} title={channel.channel}>
              <StateDot state={STATE_DOT[channel.state]} size={8} />
              <span style={{ marginLeft: 4 }}>{channel.channel}</span>
            </Pill>
          ))}
          {status.failoverCount > 0 && (
            <span style={metaStyle}>
              {t('failoverCount')}: {status.failoverCount}
            </span>
          )}
          {status.failoverHistory.length > 0 && (() => {
            const last = status.failoverHistory[status.failoverHistory.length - 1]
            return last !== undefined ? (
              <span style={metaStyle} title={`${t('lastFailover')}: ${last.from} → ${last.to} (${last.reason})`}>
                {t('lastFailover')}: {last.from} → {last.to}
              </span>
            ) : null
          })()}
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => setPanelOpen(true)} title={t('backupManageHint')}>
        {t('backupManage')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void load()} title={t('refresh')}>
        {t('refresh')}
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
    </div>
  )
}
