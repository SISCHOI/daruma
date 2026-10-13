/**
 * Client-side wire types and RPC wrapper for the `/dsh-daruma` channel.
 * Structural types only — no monorepo-internal imports.
 */

export type ChannelState = 'HEALTHY' | 'COOLDOWN' | 'PROBE'

export interface ChannelHealthView {
  channel: string
  state: ChannelState
  failures: number
  /** Epoch ms when the channel's cooldown ends; `0` when not cooling. */
  cooldownUntilMs: number
}

export interface StatusView {
  current: string | null
  backup: { provider: string; model: string } | null
  channels: ChannelHealthView[]
  failoverCount: number
  failoverHistory: Array<{ from: string; to: string; reason: string; at: number }>
  providers: string[]
}

export interface CandidateView {
  provider: string
  model: string
}

export interface RpcResult<T = unknown> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** One unary call on the daruma channel. */
export type Rpc = (endpoint: string, payload?: unknown) => Promise<RpcResult>

export interface DarumaApi {
  status(): Promise<StatusView>
  listCandidates(provider: string): Promise<CandidateView[]>
  setBackup(provider: string, model: string): Promise<void>
  clearBackup(): Promise<void>
  /**
   * Fires after a backup write has landed. The settings page and the composer
   * control are separate React trees over this one object, so a write in
   * either of them tells the other to reload. A failed write does not fire.
   * Returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

export function createApi(rpc: Rpc): DarumaApi {
  const listeners = new Set<() => void>()
  const call = async <T>(endpoint: string, payload?: unknown): Promise<T> => {
    const result = (await rpc(endpoint, payload)) as RpcResult<T>
    if (!result.ok) {
      throw new Error(result.error?.message ?? `daruma rpc ${endpoint} failed`)
    }
    return result.value as T
  }
  // The write has already landed by the time this runs. One view that throws
  // while refreshing must not hide the change from the others, nor fail the
  // call the user just made.
  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // see above
      }
    }
  }

  return {
    status: () => call<StatusView>('status'),
    listCandidates: (provider) => call<CandidateView[]>('listCandidates', { provider }),
    setBackup: async (provider, model) => {
      await call<{ ok: boolean }>('setBackup', { provider, model })
      notify()
    },
    clearBackup: async () => {
      await call<{ ok: boolean }>('clearBackup')
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
