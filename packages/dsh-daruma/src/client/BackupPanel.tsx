/**
 * BackupChannelPanel: list candidate models for a provider and pick one as
 * the failover backup. Rendered inside a primitives Modal.
 *
 * No probing happens here anymore — the panel is a plain picker. Channel
 * health still updates from real traffic via the recovery engine.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CandidateView, DarumaApi, StatusView } from './api.ts'

type Translate = (key: string) => string

function deriveProvider(status: StatusView | null): string {
  if (status === null) return ''
  if (status.current !== null) return status.current.split('::')[0] ?? ''
  if (status.backup !== null) return status.backup.provider
  return status.providers[0] ?? ''
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px 0',
  fontSize: '13px',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
}

const noteStyle: React.CSSProperties = { color: 'var(--dsw-text-tertiary, #999)', fontSize: '12px' }

/** Clamp a long provider/model name so the row never wraps. */
const backupPillStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
}

const ellipsisStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const listStyle: React.CSSProperties = {
  maxHeight: 300,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  contain: 'content',
  willChange: 'scroll-position',
  overscrollBehavior: 'contain',
}

/** Skip rendering rows outside the viewport while scrolling. */
const candidateRowStyle: React.CSSProperties = {
  ...rowStyle,
  contentVisibility: 'auto',
  containIntrinsicSize: '28px',
}

/** One candidate row, memoized so selection changes only re-render it. */
const CandidateRow = memo(function CandidateRow(props: {
  candidate: CandidateView
  isBackup: boolean
  busy: boolean
  t: Translate
  onSetBackup: (model: string) => void
}): React.JSX.Element {
  const { candidate, isBackup, busy, t, onSetBackup } = props
  return (
    <div style={candidateRowStyle}>
      <span style={{ width: 14, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.model}</span>
      {isBackup && <Pill active>{t('currentBackupMark')}</Pill>}
      <Button size="sm" variant="ghost" disabled={isBackup || busy} onClick={() => onSetBackup(candidate.model)}>
        {t('setBackup')}
      </Button>
    </div>
  )
})

export function BackupPanel(props: {
  api: DarumaApi
  t: Translate
  status: StatusView | null
  onClose: () => void
}): React.JSX.Element {
  const { api, t, status, onClose } = props
  const [provider, setProvider] = useState(deriveProvider(status))
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Local overlay on the status-prop backup: applied optimistically after
  // set/clear so the row reflects the change without waiting for the parent
  // to re-fetch status. Cleared whenever a fresh status arrives.
  const [backupOverride, setBackupOverride] = useState<{ provider: string; model: string } | null | undefined>(undefined)

  // The effective backup shown in the panel: local override → status prop.
  const backupShown = backupOverride !== undefined ? backupOverride : status?.backup ?? null

  // O(1) lookup for the current backup model; re-built only when the effective backup changes.
  const backupModel = useMemo(
    () => (backupShown !== null && backupShown.provider === provider ? backupShown.model : null),
    [backupShown, provider],
  )

  const loadCandidates = async (): Promise<void> => {
    if (provider === '') return
    setLoading(true)
    setError(null)
    try {
      setCandidates(await api.listCandidates(provider))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (provider !== '') void loadCandidates()
  }, [provider])

  // A fresh status from the parent supersedes the local override.
  useEffect(() => {
    setBackupOverride(undefined)
  }, [status])

  const setBackup = async (model: string): Promise<void> => {
    setBusy(model)
    setError(null)
    try {
      await api.setBackup(provider, model)
      setBackupOverride({ provider, model })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const clearBackup = async (): Promise<void> => {
    setBusy('__clear__')
    setError(null)
    try {
      await api.clearBackup()
      setBackupOverride(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  // Stable callback so memoized CandidateRow props don't change every render.
  const handleSetBackup = useCallback((model: string) => void setBackup(model), [provider])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('backupManage')}
      className="daruma-wide-dialog"
      closeLabel={t('close')}
      description={t('backupManageHint')}
      footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}
    >
      <div style={sectionStyle}>
        {status !== null && status.failoverCount > 0 && (
          <div style={noteStyle}>
            {t('failoverCount')}: {status.failoverCount}
            {status.failoverHistory.length > 0 && (
              <>
                {' · '}
                {t('lastFailover')}: {status.failoverHistory.map((h) => `${h.from} → ${h.to}`).join(' · ')}
              </>
            )}
          </div>
        )}

        {backupShown !== null && (
          <div style={rowStyle}>
            <span style={{ flexShrink: 0 }}>{t('currentBackup')}:</span>
            <Pill active style={backupPillStyle} title={`${backupShown.provider}/${backupShown.model}`}>
              <span style={ellipsisStyle}>
                {backupShown.provider}/{backupShown.model}
              </span>
            </Pill>
            <Button size="sm" variant="ghost" style={{ flexShrink: 0 }} disabled={busy !== null} onClick={() => void clearBackup()}>{t('clearBackup')}</Button>
          </div>
        )}

        <div style={rowStyle}>
          {(status?.providers ?? []).length > 0 ? (
            <select
              value={provider}
              disabled={loading}
              onChange={(event) => setProvider(event.currentTarget.value)}
              style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
            >
              {status?.providers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          ) : (
            <input
              value={provider}
              placeholder={t('providerPlaceholder')}
              onChange={(event) => setProvider(event.currentTarget.value)}
              style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
            />
          )}
          <Button size="sm" variant="outline" onClick={() => void loadCandidates()} disabled={provider === '' || loading}>
            {loading ? t('loading') : t('loadCandidates')}
          </Button>
        </div>

        {error !== null && <div style={{ color: 'var(--dsw-text-danger, #e5484d)' }}>{error}</div>}

        {candidates !== null && (
          <>
            <div style={rowStyle}>
              <span>{t('candidates')} ({candidates.length})</span>
            </div>
            {candidates.length === 0 && <div style={noteStyle}>{t('noCandidates')}</div>}
            <div style={listStyle}>
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.model}
                  candidate={candidate}
                  isBackup={candidate.model === backupModel}
                  busy={busy !== null}
                  t={t}
                  onSetBackup={handleSetBackup}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
