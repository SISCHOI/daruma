/**
 * BackupChannelPanel: probe candidate models for a provider and pick one as
 * the failover backup. Rendered inside a primitives Modal.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Modal, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CandidateView, DarumaApi, ProbeResultView, StatusView } from './api.ts'

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

/** Shorten an error for inline display; full text rides the title tooltip. */
function shortError(message: string): string {
  return message.length > 36 ? `${message.slice(0, 33)}…` : message
}

/** One candidate row, memoized so per-model result updates only re-render it. */
const CandidateRow = memo(function CandidateRow(props: {
  candidate: CandidateView
  result: ProbeResultView | undefined
  busy: boolean
  t: Translate
  onSetBackup: (model: string) => void
}): React.JSX.Element {
  const { candidate, result, busy, t, onSetBackup } = props
  return (
    <div style={rowStyle}>
      <StateDot state={result === undefined ? 'ongoing' : result.ok ? 'done' : 'error'} size={8} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.model}</span>
      {result !== undefined && (
        <span style={noteStyle} title={result.error}>
          {result.ok ? t('resultOk') : t('resultFail')} · {result.latencyMs}ms
          {!result.ok && result.error !== undefined ? ` · ${shortError(result.error)}` : ''}
        </span>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSetBackup(candidate.model)}>
        {busy ? t('testing') : t('setBackup')}
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
  const [results, setResults] = useState<ProbeResultView[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // O(1) lookup for a model's probe result; re-built only when results change.
  const resultMap = useMemo(
    () => new Map((results ?? []).map((r) => [r.model, r] as const)),
    [results],
  )

  const loadCandidates = async (): Promise<void> => {
    if (provider === '') return
    setLoading(true)
    setError(null)
    setResults(null)
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

  const test = async (): Promise<void> => {
    if (candidates === null || candidates.length === 0) return
    setTesting(true)
    setError(null)
    setNotice(null)
    setResults(null)
    try {
      setResults(await api.testCandidates(provider, candidates.map((c) => c.model)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  const setBackup = async (model: string): Promise<void> => {
    setBusy(model)
    setError(null)
    try {
      await api.setBackup(provider, model)
      setNotice(t('setBackupDone') + `: ${provider}/${model}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const clearBackup = async (): Promise<void> => {
    setError(null)
    try {
      await api.clearBackup()
      setNotice(t('clearBackupDone'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Stable callback so memoized CandidateRow props don't change every render.
  const handleSetBackup = useCallback((model: string) => void setBackup(model), [provider])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('backupManage')}
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

        {status?.backup !== null && status?.backup !== undefined && (
          <div style={rowStyle}>
            <span>{t('currentBackup')}:</span>
            <Pill active>
              {status.backup.provider}/{status.backup.model}
            </Pill>
            <Button size="sm" variant="ghost" onClick={() => void clearBackup()}>{t('clearBackup')}</Button>
          </div>
        )}

        <div style={rowStyle}>
          {(status?.providers ?? []).length > 0 ? (
            <select
              value={provider}
              disabled={testing || loading}
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
              disabled={testing}
              onChange={(event) => setProvider(event.currentTarget.value)}
              style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
            />
          )}
          <Button size="sm" variant="outline" onClick={() => void loadCandidates()} disabled={provider === '' || loading || testing}>
            {loading ? t('testing') : t('loadCandidates')}
          </Button>
        </div>

        {error !== null && <div style={{ color: 'var(--dsw-text-danger, #e5484d)' }}>{error}</div>}
        {notice !== null && <div style={noteStyle}>{notice}</div>}

        {candidates !== null && (
          <>
            <div style={rowStyle}>
              <span>{t('candidates')} ({candidates.length})</span>
              <Button size="sm" variant="primary" onClick={() => void test()} disabled={testing || candidates.length === 0}>
                {testing ? `${t('testing')} (≤${candidates.length * 30}s)` : t('testAll')}
              </Button>
            </div>
            <div style={noteStyle}>{t('testNote')}</div>
            {candidates.length === 0 && <div style={noteStyle}>{t('noCandidates')}</div>}
            <div style={listStyle}>
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.model}
                  candidate={candidate}
                  result={resultMap.get(candidate.model)}
                  busy={busy === candidate.model}
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
