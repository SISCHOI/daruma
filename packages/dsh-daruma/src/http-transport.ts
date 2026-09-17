/**
 * `/api/dsh-daruma` Fetch-route fallback for hosts whose generic channel
 * RPC registry is broken (`0.1.5-alpha.1` … `0.1.5-rc.2` dropped `webServer`
 * from the connection plugin's own inject list, so every
 * `connection.rpc.handle()` caller throws `cannot get property "webServer"
 * without inject`).
 *
 * The fallback registers an exact Fetch route through
 * `connection.fetch.register`, whose registration path never touches the web
 * server context: the host itself mounts the shared `/api` carrier inside its
 * own `ctx.inject(['webServer'], …)` scope and applies the Host/Origin fence
 * plus browser authentication before any `/api/*` handler runs. The handler
 * below adds a loopback authority guard (defense in depth) and speaks the
 * same `client-request` / `server-response` envelope as the built-in channel
 * transport, so the browser caller keeps using `connection.rpc.call`.
 *
 * Wire shape verified against `@deepseek-ai/dsh-client-connection@0.1.5-*`
 * (`rpcFetchHandler` / `endpointFromPath` / browser `parseConnectionResponse`)
 * and against the real-plane-verified dsh-im management RPC.
 */

import type { RpcResult } from './rpc.ts'

/** The exact Fetch route used by the fallback transport. */
export const HTTP_FALLBACK_CHANNEL = '/api/dsh-daruma'

/** Endpoint segment the host derives from the fallback route path. */
const FALLBACK_ENDPOINT = 'dsh-daruma'

/** Structural shape of the host connection's exact Fetch registry. */
export interface FetchRegisterConnection {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch(request: unknown): Promise<unknown>
    }): unknown
  }
}

/** The dispatch contract shared with the legacy channel (`src/rpc.ts`). */
export type RpcDispatch = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult>

/** Errors thrown by the known host regression — the only fallback trigger. */
export function isBrokenRpcHandleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('webServer') && message.includes('without inject')
}

/** Structural request surface used by the loopback guard. */
interface GuardedRequest {
  headers: { get(name: string): string | null }
}

function isLoopbackAuthority(authority: string | null | undefined): boolean {
  if (authority === null || authority === undefined || authority === '') return false
  let hostname: string
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/'
      || url.search !== '' || url.hash !== '') return false
    hostname = url.hostname.replace(/\.$/u, '')
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.slice(1).every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Loopback-only guard mirroring the host's own request fence semantics: the
 * request must target a loopback authority, and an explicit `Origin` (browser
 * cross-frame scenarios) must also be loopback. The host already applied its
 * Host/Origin trust fence and browser authentication before this handler;
 * this is defense in depth, not the primary gate.
 */
export function isLoopbackRequest(request: GuardedRequest): boolean {
  if (!isLoopbackAuthority(request.headers.get('host'))) return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && isLoopbackAuthority(url.host)
  } catch {
    return false
  }
}

/** The connection surface pieces the fallback needs. */
export function hasFetchRegistry(
  connection: unknown,
): connection is FetchRegisterConnection {
  const candidate = connection as FetchRegisterConnection | undefined
  return candidate !== undefined
    && typeof candidate.fetch?.register === 'function'
}

interface ClientRequestMessage {
  type: unknown
  /** Narrowed by `parseClientRequest` before a message is ever returned. */
  rpcId: string
  method: unknown
  payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseClientRequest(raw: unknown): ClientRequestMessage | undefined {
  if (!isRecord(raw)) return undefined
  const message = raw as unknown as ClientRequestMessage
  if (message.type !== 'client-request') return undefined
  if (typeof message.rpcId !== 'string') return undefined
  if (message.method !== FALLBACK_ENDPOINT) return undefined
  // Same shape the host transport forwards: { method, payload } call tuple.
  if (!isRecord(message.payload) || typeof (message.payload as Record<string, unknown>).method !== 'string'
    || !Object.hasOwn(message.payload as Record<string, unknown>, 'payload')) return undefined
  return message
}

/**
 * Register the fallback route. Returns `true` when the route is mounted (the
 * disposer is tied to a context effect), `false` when the host lacks the
 * registry or refuses the registration — the caller decides how loudly to
 * fail in that case.
 */
export function mountHttpFallback(
  ctx: {
    effect(callback: () => unknown, label?: string): void
    logger: { info(message: string): void; warn(message: string): void }
  },
  connection: unknown,
  dispatch: RpcDispatch,
): boolean {
  if (!hasFetchRegistry(connection)) return false
  try {
    const dispose = connection.fetch.register({
      path: HTTP_FALLBACK_CHANNEL,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: unknown) {
        return handleFallbackRequest(request, dispatch)
      },
    })
    ctx.effect(() => dispose, 'dsh-daruma: /api/dsh-daruma fetch fallback route')
    ctx.logger.info(
      'dsh-daruma: generic channel RPC unavailable on this host; '
      + `panel mounted through the ${HTTP_FALLBACK_CHANNEL} carrier`,
    )
    return true
  } catch {
    return false
  }
}

async function handleFallbackRequest(
  request: unknown,
  dispatch: RpcDispatch,
): Promise<unknown> {
  const req = request as GuardedRequest & {
    json(): Promise<unknown>
    signal: AbortSignal
  }
  if (!isLoopbackRequest(req)) return new Response('forbidden', { status: 403 })
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const message = parseClientRequest(raw)
  if (message === undefined) {
    return envelopeResponse(typeof (raw as ClientRequestMessage | undefined)?.rpcId === 'string'
      ? (raw as ClientRequestMessage).rpcId as string
      : 'invalid-request', {
      ok: false,
      error: { code: 'bad-request', message: 'invalid daruma request', details: {} },
    })
  }
  const call = message.payload as { method: string; payload: unknown }
  let result: RpcResult
  try {
    result = await dispatch(call.method, call.payload, req.signal)
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  // The browser response validator requires `details` on failures —
  // normalize before hitting the wire so panel error paths render. A dispatch
  // that already set one keeps its value.
  const normalized: RpcResult = result.ok
    ? result
    : { ok: false, error: { ...result.error, details: result.error.details ?? {} } }
  return envelopeResponse(message.rpcId, normalized)
}

function envelopeResponse(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}
