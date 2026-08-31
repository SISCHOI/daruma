/**
 * BackupChannelPanel: probe candidate models for a provider and pick one as
 * the failover backup. Rendered inside a primitives Modal.
 *
 * Probing runs in small batches so results and progress stream into the list
 * instead of blocking on all 30+ models at once.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconLoadingOutline16,
  IconPlayOutline16,
  IconWarningOutline16,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CandidateView, DarumaApi, ProbeResultView, StatusView } from './api.ts'

type Translate = (key: string) => string

/** Models probed per RPC round; results stream into the list after each batch. */
const BATCH = 6

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

/** Skip rendering rows outside the viewport while scrolling. */
const candidateRowStyle: React.CSSProperties = {
  ...rowStyle,
  contentVisibility: 'auto',
  containIntrinsicSize: '28px',
}

/** Shorten an error for inline display; full text rides the title tooltip. */
function shortError(message: string): string {
  return message.length > 36 ? `${message.slice(0, 33)}…` : message
}

/** Spin animation for the loading glyph (keyframes injected at client apply). */
const loadingSpinStyle: React.CSSProperties = {
  display: 'inline-flex',
  animation: 'daruma-spin 1s linear infinite',
}

/** One candidate row, memoized so per-model result updates only re-render it. */
const CandidateRow = memo(function CandidateRow(props: {
  candidate: CandidateView
  result: ProbeResultView | undefined
  busy: boolean
  testingOne: boolean
  t: Translate
  onSetBackup: (model: string) => void
  onTestOne: (model: string) => void
}): React.JSX.Element {
  const { candidate, result, busy, testingOne, t, onSetBackup, onTestOne } = props
  return (
    <div style={candidateRowStyle}>
      {result === undefined ? (
        <span style={{ width: 14, flexShrink: 0 }} />
      ) : result.ok ? (
        <span style={{ display: 'inline-flex', color: 'var(--dsw-text-success, #30a46c)', flexShrink: 0 }}>
          <IconCheckOutline16 size={14} />
        </span>
      ) : (
        <span style={{ display: 'inline-flex', color: 'var(--dsw-text-danger, #e5484d)', flexShrink: 0 }}>
          <IconWarningOutline16 size={14} />
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.model}</span>
      {result !== undefined && (
        <span style={noteStyle} title={result.error}>
          {result.ok ? t('resultOk') : t('resultFail')} · {result.latencyMs}ms
          {!result.ok && result.error !== undefined ? ` · ${shortError(result.error)}` : ''}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        title={t('testOne')}
        disabled={busy || testingOne}
        onClick={() => onTestOne(candidate.model)}
      >
        <span style={testingOne ? loadingSpinStyle : { display: 'inline-flex' }}>
          {testingOne ? <IconLoadingOutline16 size={14} /> : <IconPlayOutline16 size={14} />}
        </span>
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || testingOne} onClick={() => onSetBackup(candidate.model)}>
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
  const [tested, setTested] = useState(0)
  const [testingOne, setTestingOne] = useState<string | null>(null)
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
    setTested(0)
    const all: ProbeResultView[] = []
    try {
      // Stream results in batches: each RPC round probes BATCH models, then
      // the list updates so progress is visible instead of one long wait.
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH)
        const batchResults = await api.testCandidates(provider, batch.map((c) => c.model))
        all.push(...batchResults)
        setResults([...all])
        setTested(all.length)
      }
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

  /** Probe a single model and merge its result into the list. */
  const testOne = async (model: string): Promise<void> => {
    setTestingOne(model)
    setError(null)
    setNotice(null)
    try {
      const [result] = await api.testCandidates(provider, [model])
      if (result !== undefined) {
        setResults((prev) => [...(prev ?? []).filter((r) => r.model !== model), result])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTestingOne(null)
    }
  }

  // Stable callbacks so memoized CandidateRow props don't change every render.
  const handleSetBackup = useCallback((model: string) => void setBackup(model), [provider])
  const handleTestOne = useCallback((model: string) => void testOne(model), [provider])

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
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={testing ? loadingSpinStyle : { display: 'inline-flex' }}>
                    {testing ? <IconLoadingOutline16 size={14} /> : <IconPlayOutline16 size={14} />}
                  </span>
                  {testing ? `${t('testing')} ${tested}/${candidates.length}` : t('testAll')}
                </span>
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
                  testingOne={testingOne === candidate.model}
                  t={t}
                  onSetBackup={handleSetBackup}
                  onTestOne={handleTestOne}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
