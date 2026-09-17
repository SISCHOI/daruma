/**
 * Client transport for the daruma panel.
 *
 * Primary path: the legacy generic channel (`/dsh-daruma`) — served by
 * `rpc.handle` on hosts up to 0.1.2 and on 0.1.5 hosts patched by the
 * community fix.
 *
 * Fallback path: the `/api` shared carrier (`/api/dsh-daruma` exact route,
 * registered by the host-side fallback in `src/http-transport.ts`). The
 * browser caller switches on the first HTTP 404/405 — the route-miss shape of
 * the 0.1.5 `rpc.handle` regression — and sticks with the fallback for the
 * rest of the page lifetime, so the panel needs at most one failed request
 * per load. Auth failures (401/403) and handler errors surface as-is: they
 * say nothing about which transport should be used.
 *
 * Wire shape: exact Fetch routes match by URL path segment, and the shared
 * carrier validates that the envelope `method` equals that segment — so the
 * real endpoint and payload ride inside the payload tunnel, exactly like the
 * real-plane-verified dsh-im management RPC.
 */

import type { Rpc, RpcResult } from './api.ts'

/** Structural connection surface (host provides the real one). */
interface ConnectionLike {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
  }
}

/** Generic channel served by `connection.rpc.handle` where it works. */
export const LEGACY_CHANNEL = '/dsh-daruma'
/** Shared browser carrier the host itself mounts on every web-capable host. */
export const FALLBACK_CHANNEL = '/api'
/** Envelope method demanded by the exact `/api/dsh-daruma` route. */
export const FALLBACK_ENDPOINT = 'dsh-daruma'

/**
 * Whether a rejected legacy call means "the channel route does not exist on
 * this host" (switch to the fallback) rather than anything else. The browser
 * caller throws `transport failure for <channel>/<endpoint>: HTTP <status>`
 * when the response is not ok.
 */
export function isChannelRouteMiss(error: unknown): boolean {
  return error instanceof Error && /HTTP (404|405)\b/u.test(error.message)
}

function tunnelCall(
  connection: ConnectionLike,
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  return connection.rpc.call(FALLBACK_CHANNEL, FALLBACK_ENDPOINT, {
    method: endpoint,
    payload: payload ?? {},
  })
}

/** Build the panel `Rpc`: legacy channel first, sticky `/api` fallback. */
export function createAdaptiveRpc(connection: ConnectionLike): Rpc {
  let useFallback = false
  return (endpoint, payload) => {
    if (useFallback) {
      return tunnelCall(connection, endpoint, payload) as Promise<RpcResult>
    }
    return connection.rpc.call(LEGACY_CHANNEL, endpoint, payload ?? {}).catch(
      (error: unknown) => {
        if (!isChannelRouteMiss(error)) throw error
        useFallback = true
        return tunnelCall(connection, endpoint, payload) as Promise<RpcResult>
      },
    ) as Promise<RpcResult>
  }
}
