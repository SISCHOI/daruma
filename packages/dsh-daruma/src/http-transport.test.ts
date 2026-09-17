import { describe, expect, it, vi } from 'vitest'
import {
  HTTP_FALLBACK_CHANNEL,
  isBrokenRpcHandleError,
  isLoopbackRequest,
  mountHttpFallback,
  type RpcDispatch,
} from './http-transport.ts'

interface Harness {
  readonly effects: string[]
  readonly infos: string[]
  readonly warns: string[]
}

function harness(): Harness & {
  ctx: {
    effect(callback: () => unknown, label?: string): void
    logger: { info(message: string): void; warn(message: string): void }
  }
} {
  const effects: string[] = []
  const infos: string[] = []
  const warns: string[] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '(unlabeled)')
      callback()
    },
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
  }
  return { ctx, effects, infos, warns }
}

interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch(request: unknown): Promise<unknown>
}

function connectionWithFetch(register: (route: Route) => unknown): { connection: unknown; routes: Route[] } {
  const routes: Route[] = []
  const connection = {
    fetch: {
      register: (route: Route) => {
        routes.push(route)
        return register(route)
      },
    },
  }
  return { connection, routes }
}

/**
 * The one registered route. `noUncheckedIndexedAccess` makes `routes[0]`
 * possibly-undefined; every case here registers exactly one route, and a
 * missing one is a broken test rather than a branch worth tolerating.
 */
function firstRoute(routes: readonly Route[]): Route {
  const route = routes[0]
  if (route === undefined) throw new Error('no route registered')
  return route
}

/** Minimal fetch-shaped request double (host requests carry headers/json/signal). */
function requestDouble(body: unknown, headers: Record<string, string>): unknown {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    signal: new AbortController().signal,
  }
}

const okDispatch: RpcDispatch = async () => ({ ok: true, value: { fine: true } })

function clientRequest(payload: unknown): unknown {
  return { type: 'client-request', rpcId: 'rpc-1', method: 'dsh-daruma', payload }
}

describe('isBrokenRpcHandleError', () => {
  it('matches the 0.1.5 regression message', () => {
    expect(isBrokenRpcHandleError(new Error('cannot get property "webServer" without inject'))).toBe(true)
  })

  it('rejects unrelated failures', () => {
    expect(isBrokenRpcHandleError(new Error('channel /dsh-daruma is already registered'))).toBe(false)
    expect(isBrokenRpcHandleError(new Error('webServer exploded'))).toBe(false)
    expect(isBrokenRpcHandleError('without inject')).toBe(false)
  })
})

describe('mountHttpFallback', () => {
  it('registers the /api route, ties the disposer to an effect, and logs', () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})

    expect(mountHttpFallback(h.ctx, connection, okDispatch)).toBe(true)
    expect(routes).toHaveLength(1)
    const route = firstRoute(routes)
    expect(route.path).toBe(HTTP_FALLBACK_CHANNEL)
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    expect(h.effects).toEqual(['dsh-daruma: /api/dsh-daruma fetch fallback route'])
    expect(h.warns).toEqual([])
    expect(h.infos[0]).toContain('/api/dsh-daruma')
  })

  it('returns false without touching effects when the host has no fetch registry', () => {
    const h = harness()
    expect(mountHttpFallback(h.ctx, { rpc: {} }, okDispatch)).toBe(false)
    expect(h.effects).toEqual([])
    expect(h.warns).toEqual([])
  })

  it('returns false when the host refuses the registration', () => {
    const h = harness()
    const { connection } = connectionWithFetch(() => {
      throw new Error('connection: exact Fetch route "/api/dsh-daruma" is already registered')
    })
    expect(mountHttpFallback(h.ctx, connection, okDispatch)).toBe(false)
    expect(h.effects).toEqual([])
  })
})

describe('fallback route handler', () => {
  it('dispatches a valid client-request and answers the host envelope', async () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const dispatch: RpcDispatch = async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { current: 'a/b' } }
    }
    mountHttpFallback(h.ctx, connection, dispatch)

    const response = await firstRoute(routes).fetch(
      requestDouble(clientRequest({ method: 'status', payload: { sessionId: 's1' } }), {
        'content-type': 'application/json',
        host: '127.0.0.1:3080',
      }),
    ) as Response
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(calls).toEqual([{ endpoint: 'status', payload: { sessionId: 's1' } }])
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { current: 'a/b' } },
    })
  })

  it('normalizes failure envelopes to carry details', async () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})
    const dispatch: RpcDispatch = async () => ({
      ok: false,
      error: { code: 'bad-request', message: 'listCandidates needs a provider' },
    })
    mountHttpFallback(h.ctx, connection, dispatch)

    const response = await firstRoute(routes).fetch(
      requestDouble(clientRequest({ method: 'listCandidates', payload: {} }), {
        'content-type': 'application/json;charset=utf-8',
        host: 'localhost:3080',
      }),
    ) as Response
    const body = await response.json() as { result: { ok: false; error: Record<string, unknown> } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('bad-request')
    expect(body.result.error.details).toEqual({})
  })

  it('converts a throwing dispatch into an internal failure envelope', async () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})
    mountHttpFallback(h.ctx, connection, async () => {
      throw new Error('boom')
    })

    const response = await firstRoute(routes).fetch(
      requestDouble(clientRequest({ method: 'clearBackup', payload: {} }), {
        'content-type': 'application/json',
        host: '127.0.0.1:3080',
      }),
    ) as Response
    const body = await response.json() as { result: { ok: boolean; error: Record<string, unknown> } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('internal')
    expect(body.result.error.message).toBe('boom')
    expect(body.result.error.details).toEqual({})
  })

  it('answers 403 off loopback, 415 on wrong content type, 400 on broken JSON', async () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})
    mountHttpFallback(h.ctx, connection, okDispatch)
    const fetchRoute = firstRoute(routes).fetch

    const forbidden = await fetchRoute(
      requestDouble(clientRequest({ method: 'status', payload: {} }), {
        'content-type': 'application/json',
        host: '192.168.1.5:3080',
      }),
    ) as Response
    expect(forbidden.status).toBe(403)

    const originCross = await fetchRoute(
      requestDouble(clientRequest({ method: 'status', payload: {} }), {
        'content-type': 'application/json',
        host: '127.0.0.1:3080',
        origin: 'http://evil.example.com',
      }),
    ) as Response
    expect(originCross.status).toBe(403)

    const unsupported = await fetchRoute(
      requestDouble(clientRequest({ method: 'status', payload: {} }), {
        'content-type': 'text/plain',
        host: '127.0.0.1:3080',
      }),
    ) as Response
    expect(unsupported.status).toBe(415)

    // A loopback request whose body is not JSON: the Host fence passes, so the
    // answer is the JSON parse (400) rather than the fence (403).
    const broken = await fetchRoute({
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json'
          if (name === 'host') return '127.0.0.1:3080'
          return null
        },
      },
      json: async () => {
        throw new Error('unexpected end')
      },
      signal: new AbortController().signal,
    }) as Response
    expect(broken.status).toBe(400)
  })

  it('answers a bad-request envelope for malformed client-request messages', async () => {
    const h = harness()
    const { connection, routes } = connectionWithFetch(() => async () => {})
    const dispatch = vi.fn<RpcDispatch>(okDispatch)
    mountHttpFallback(h.ctx, connection, dispatch)

    const cases: Array<{ body: unknown; rpcId: string }> = [
      { body: { type: 'other', rpcId: 'x', method: 'dsh-daruma', payload: {} }, rpcId: 'x' },
      { body: { type: 'client-request', rpcId: 7, method: 'dsh-daruma', payload: {} }, rpcId: 'invalid-request' },
      { body: { type: 'client-request', rpcId: 'x', method: 'other-channel', payload: {} }, rpcId: 'x' },
      { body: { type: 'client-request', rpcId: 'x', method: 'dsh-daruma', payload: 'nope' }, rpcId: 'x' },
      { body: { type: 'client-request', rpcId: 'x', method: 'dsh-daruma', payload: { method: 1, payload: {} } }, rpcId: 'x' },
    ]
    for (const { body, rpcId } of cases) {
      const response = await firstRoute(routes).fetch(
        requestDouble(body, { 'content-type': 'application/json', host: '127.0.0.1:3080' }),
      ) as Response
      const parsed = await response.json() as { rpcId: string; result: { ok: boolean } }
      expect(parsed.rpcId).toBe(rpcId)
      expect(parsed.result.ok).toBe(false)
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('isLoopbackRequest', () => {
  const headers = (map: Record<string, string>) => ({ headers: { get: (n: string) => map[n.toLowerCase()] ?? null } })

  it('accepts loopback host with no origin', () => {
    expect(isLoopbackRequest(headers({ host: '127.0.0.1:3080' }) as never)).toBe(true)
    expect(isLoopbackRequest(headers({ host: 'localhost' }) as never)).toBe(true)
    expect(isLoopbackRequest(headers({ host: '[::1]:3080' }) as never)).toBe(true)
  })

  it('accepts matching loopback origin, rejects non-loopback host or origin', () => {
    expect(isLoopbackRequest(headers({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' }) as never)).toBe(true)
    expect(isLoopbackRequest(headers({ host: '10.0.0.8:3080' }) as never)).toBe(false)
    expect(isLoopbackRequest(headers({ host: '127.0.0.1:3080', origin: 'https://evil.example' }) as never)).toBe(false)
  })
})
