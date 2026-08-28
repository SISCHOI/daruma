/**
 * Client-side wire types and RPC wrapper for the `/dsh-daruma` channel.
 * Structural types only — no monorepo-internal imports.
 */

export type ChannelState = 'HEALTHY' | 'COOLDOWN' | 'PROBE'

export interface ChannelHealthView {
  channel: string
  state: ChannelState
  failures: number
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

export interface ProbeResultView {
  provider: string
  model: string
  ok: boolean
  latencyMs: number
  error?: string
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
  testCandidates(provider: string, models: string[]): Promise<ProbeResultView[]>
  setBackup(provider: string, model: string): Promise<void>
  clearBackup(): Promise<void>
}

export function createApi(rpc: Rpc): DarumaApi {
  const call = async <T>(endpoint: string, payload?: unknown): Promise<T> => {
    const result = (await rpc(endpoint, payload)) as RpcResult<T>
    if (!result.ok) {
      throw new Error(result.error?.message ?? `daruma rpc ${endpoint} failed`)
    }
    return result.value as T
  }

  return {
    status: () => call<StatusView>('status'),
    listCandidates: (provider) => call<CandidateView[]>('listCandidates', { provider }),
    testCandidates: (provider, models) => call<ProbeResultView[]>('testCandidates', { provider, models }),
    setBackup: async (provider, model) => {
      await call<{ ok: boolean }>('setBackup', { provider, model })
    },
    clearBackup: async () => {
      await call<{ ok: boolean }>('clearBackup')
    },
  }
}
