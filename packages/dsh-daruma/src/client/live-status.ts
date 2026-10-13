/**
 * One status snapshot shared in shape, not in React state: the settings page
 * and the composer control each hold their own copy, and a backup write has
 * to invalidate both. A read that started earlier and returns later is
 * dropped, so it cannot paint the selection from before the write.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DarumaApi, StatusView } from './api.ts'

export function useLiveStatus(
  api: DarumaApi,
  pollMs?: number,
): { status: StatusView | null; reload: () => void } {
  const [status, setStatus] = useState<StatusView | null>(null)
  const request = useRef(0)

  const reload = useCallback((): void => {
    const ticket = ++request.current
    void api.status().then(
      (value) => { if (ticket === request.current) setStatus(value) },
      () => { /* keep the last good snapshot; the control stays quiet */ },
    )
  }, [api])

  useEffect(() => {
    reload()
    const timer = pollMs === undefined ? undefined : setInterval(reload, pollMs)
    const unsubscribe = api.subscribe(reload)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      unsubscribe()
    }
  }, [api, pollMs, reload])

  return { status, reload }
}
