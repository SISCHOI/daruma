/**
 * `/dsh-daruma` RPC channel: status snapshot, candidate discovery, and
 * backup-channel management for the client UI.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Channel, ChannelId } from 'daruma-core'
import type { RecoveryEngine } from './engine.ts'
import { isBrokenRpcHandleError, mountHttpFallback } from './http-transport.ts'
import type { StatusService } from './status.ts'

export type RpcResult =
  | { ok: true; value: unknown }
  | {
    ok: false
    /**
     * The host's response envelope validates failures against
     * `dsh-client-connection`'s `rpcErrorSchema`, which requires a `details`
     * record; the browser's `parseConnectionResponse` throws
     * `connection: invalid server-response failure` without one — on **both**
     * transports (`rpc.handle` and the `/api` fallback) since they share that
     * parser. Optional in the type so a foreign dispatch cannot be forced to
     * invent one, but every failure daruma owns sets it.
     */
    error: { code: string; message: string; details?: Record<string, unknown> }
  }

export interface RpcDeps {
  readonly engine: RecoveryEngine
  readonly currentChannel: ReadonlyMap<string, ChannelId>
  readonly status: StatusService
  readonly getLlm: () => LlmRuntime | undefined
  /** The host's `settings` service, of either generation (see `readPiAiSection`). */
  readonly getSettings: () => unknown
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

function isIdentifier(value: unknown): value is string {
  return isString(value) && value.trim() !== '' && value.length <= 256
}

/** `{ provider, model }` — a backup selection. */
function isBackupPayload(value: unknown): value is { provider: string; model: string } {
  return isRecord(value) && isIdentifier(value.provider)
    && isIdentifier(value.model)
}

/** The `llm-pi-ai` settings section shape (providers → models). */
interface PiAiSection {
  providers?: Record<string, { models?: readonly { id?: string }[] }>
}

/**
 * Read the `llm-pi-ai` provider section from whichever settings service the
 * host ships: 0.1.x answers `get(ns)`; 0.2.x has no `get` and exposes plugin
 * Config forms through `describe()`, one row per profile entry id.
 */
export function readPiAiSection(settings: unknown): PiAiSection | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined
  const service = settings as { get?: unknown; describe?: unknown }
  try {
    if (typeof service.get === 'function') {
      return (service.get as (ns: string) => unknown).call(settings, 'llm-pi-ai') as PiAiSection | undefined
    }
    if (typeof service.describe === 'function') {
      const rows = (service.describe as (options: { redactSecrets: boolean }) => unknown)
        .call(settings, { redactSecrets: true })
      if (!Array.isArray(rows)) return undefined
      const row = rows.find((entry) => isRecord(entry) && entry.ns === 'llm-pi-ai') as { value?: unknown } | undefined
      return isRecord(row?.value) ? (row.value as PiAiSection) : undefined
    }
  } catch {
    // settings unavailable
  }
  return undefined
}

/** Known provider names: configured channels, registered routes, settings providers. */
function knownProviders(deps: RpcDeps): string[] {
  const names = new Set<string>()
  for (const channel of deps.engine.channels) names.add(channel.provider)
  try {
    for (const info of deps.getLlm()?.listProviders() ?? []) names.add(info.id)
  } catch {
    // registry unavailable — configured channels still known
  }
  for (const provider of Object.keys(readPiAiSection(deps.getSettings())?.providers ?? {})) names.add(provider)
  return [...names]
}

/**
 * Discover candidate models for a provider: the adapter's model directory
 * first, then the `llm-pi-ai` settings section as a fallback.
 */
interface CandidateEntry {
  readonly provider: string
  readonly model: string
}

async function listCandidates(
  llm: LlmRuntime,
  provider: string,
  settings?: unknown,
): Promise<CandidateEntry[]> {
  try {
    const models: LlmModelInfo[] = await llm.listModels(provider)
    if (models.length > 0) return models.map((info) => ({ provider, model: info.id }))
  } catch {
    // fall through to the settings model directory
  }
  const models = readPiAiSection(settings)?.providers?.[provider]?.models
  if (Array.isArray(models) && models.length > 0) {
    return models
      .map((model) => model?.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .map((model) => ({ provider, model }))
  }
  return []
}

export function mountRpc(ctx: Context, deps: RpcDeps): void {
  const connection = ctx.get('connection') as
    | { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>, options: { authority: 'loopback' }): () => Promise<void> } }
    | undefined
  // Callers mount from an injection callback (src/host-mount.ts), so the
  // service is present here; the guard only covers a composition that dropped
  // the transport between injection and mount.
  if (connection === undefined) return

  const dispatch = async (endpoint: string, payload: unknown, _signal: AbortSignal): Promise<RpcResult> => {
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
              failoverHistory: deps.engine.history,
              providers: knownProviders(deps),
            },
          }
        }
        case 'listCandidates': {
          const provider = isRecord(payload) && isIdentifier(payload.provider) ? payload.provider : undefined
          if (provider === undefined) throw new Error('bad-request: listCandidates needs a provider')
          const llm = deps.getLlm()
          if (llm === undefined) throw new Error('llm service unavailable')
          return { ok: true, value: await listCandidates(llm, provider, deps.getSettings()) }
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
        error: { code, message: message.replace(/^bad-request: /u, ''), details: {} },
      }
    }
  }

  try {
    const dispose = connection.rpc.handle('/dsh-daruma', dispatch, { authority: 'loopback' })
    ctx.effect(() => dispose, 'dsh-daruma: /dsh-daruma rpc channel')
  } catch (error) {
    // Known host regression: 0.1.5-alpha.1 … rc.2 dropped `webServer` from the
    // connection plugin's own inject list while `rpc.handle()` still registers
    // its route through the service context, so the call throws for every
    // caller. On exactly that failure, mount the panel through the shared
    // `/api` Fetch carrier instead (see src/http-transport.ts). Anything else
    // still fails loudly instead of leaving the panel silently empty.
    if (isBrokenRpcHandleError(error) && mountHttpFallback(ctx, connection, dispatch)) return
    ctx.logger.warn(
      `dsh-daruma: /dsh-daruma rpc channel could not be registered (${messageOf(error)}); `
      + 'the status dock and backup picker stay disabled on this host generation',
    )
  }
}

// Reference to keep Channel import meaningful for consumers of the RPC shape.
export type { Channel }
