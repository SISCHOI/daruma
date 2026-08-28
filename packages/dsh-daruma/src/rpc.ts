/**
 * `/dsh-daruma` RPC channel: status snapshot, candidate discovery, model
 * probing, and backup-channel management for the client UI.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Channel, ChannelId } from 'daruma-core'
import type { RecoveryEngine } from './engine.ts'
import type { StatusService } from './status.ts'
import { probeCandidates, type Candidate } from './probe.ts'

export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface RpcDeps {
  readonly engine: RecoveryEngine
  readonly currentChannel: ReadonlyMap<string, ChannelId>
  readonly status: StatusService
  readonly getLlm: () => LlmRuntime | undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** `{ provider?, models? }` — candidates to probe. */
function isProbePayload(value: unknown): value is { provider?: string; models?: string[] } {
  if (!isRecord(value)) return false
  if (value.provider !== undefined && !isString(value.provider)) return false
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) return false
    for (const model of value.models) if (!isString(model)) return false
  }
  return true
}

/** `{ provider, model }` — a backup selection. */
function isBackupPayload(value: unknown): value is { provider: string; model: string } {
  return isRecord(value) && isString(value.provider) && value.provider !== ''
    && isString(value.model) && value.model !== ''
}

/** Discover candidate models for a provider via the adapter's model directory. */
async function listCandidates(
  llm: LlmRuntime,
  provider: string,
): Promise<Candidate[]> {
  let models: LlmModelInfo[] = []
  try {
    models = await llm.listModels(provider)
  } catch {
    // Adapter does not advertise a model directory; fall back to the
    // current channel's provider list from config.
    return []
  }
  return models.map((info) => ({ provider, model: info.id }))
}

export function mountRpc(ctx: Context, deps: RpcDeps): void {
  const connection = ctx.get('connection') as
    | { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>, options: { authority: 'loopback' }): () => Promise<void> } }
    | undefined
  if (connection === undefined) return // no web transport (headless)

  const dispatch = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> => {
    try {
      switch (endpoint) {
        case 'status': {
          const sessionId = isRecord(payload) && isString(payload.sessionId) ? payload.sessionId : undefined
          const current = sessionId !== undefined ? deps.currentChannel.get(sessionId) : undefined
          const backup = deps.status.getBackup()
          return {
            ok: true,
            value: {
              current: current ?? null,
              backup: backup ?? null,
              channels: deps.engine.listHealth(),
              failoverCount: deps.engine.failoverCount,
            },
          }
        }
        case 'listCandidates': {
          const provider = isRecord(payload) && isString(payload.provider) ? payload.provider : undefined
          if (provider === undefined) throw new Error('bad-request: listCandidates needs a provider')
          const llm = deps.getLlm()
          if (llm === undefined) throw new Error('llm service unavailable')
          return { ok: true, value: await listCandidates(llm, provider) }
        }
        case 'testCandidates': {
          if (!isProbePayload(payload)) throw new Error('bad-request: testCandidates payload is invalid')
          const llm = deps.getLlm()
          if (llm === undefined) throw new Error('llm service unavailable')
          const provider = payload.provider ?? ''
          const models = payload.models ?? []
          if (provider === '' || models.length === 0) {
            throw new Error('bad-request: testCandidates needs provider and at least one model')
          }
          const candidates: Candidate[] = models.map((model) => ({ provider, model }))
          return { ok: true, value: await probeCandidates(llm, candidates, { timeoutMs: 60_000 }, signal) }
        }
        case 'setBackup': {
          if (!isBackupPayload(payload)) throw new Error('bad-request: setBackup needs {provider, model}')
          await deps.status.setBackup({ provider: payload.provider, model: payload.model })
          return { ok: true, value: { ok: true } }
        }
        case 'clearBackup': {
          await deps.status.clearBackup()
          return { ok: true, value: { ok: true } }
        }
        default:
          throw new Error(`bad-request: unknown endpoint ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      const message = messageOf(error)
      const code = message.startsWith('bad-request:') ? 'bad-request' : 'internal'
      return {
        ok: false,
        error: { code, message: message.replace(/^bad-request: /u, '') },
      }
    }
  }

  const dispose = connection.rpc.handle('/dsh-daruma', dispatch, { authority: 'loopback' })
  ctx.effect(() => dispose, 'dsh-daruma: /dsh-daruma rpc channel')
}

// Reference to keep Channel import meaningful for consumers of the RPC shape.
export type { Channel }
