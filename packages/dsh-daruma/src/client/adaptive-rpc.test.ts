/**
 * Client transport switching: the legacy channel while it answers, the `/api`
 * tunnel once the host's `rpc.handle` route turns out not to exist.
 *
 * The distinction these cover is the whole point of the adapter: only a
 * route miss (404/405) may move a call to the fallback carrier. Everything else
 * — auth, a failing handler, a dropped connection — has to surface unchanged,
 * or the panel would silently reroute real errors to a second transport.
 */

import { describe, expect, it } from 'vitest'
import {
  createAdaptiveRpc,
  FALLBACK_CHANNEL,
  FALLBACK_ENDPOINT,
  isChannelRouteMiss,
  LEGACY_CHANNEL,
} from './adaptive-rpc.ts'

interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** A connection whose `rpc.call` answers per channel, recording every call. */
function connection(
  answer: (channel: string, endpoint: string, payload: unknown) => unknown,
): { connection: { rpc: { call: (c: string, e: string, p: unknown) => Promise<unknown> } }; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    connection: {
      rpc: {
        call: async (channel: string, endpoint: string, payload: unknown) => {
          calls.push({ channel, endpoint, payload })
          return await answer(channel, endpoint, payload)
        },
      },
    },
  }
}

const OK = { ok: true, value: { fine: true } }
const routeMiss = () => new Error('transport failure for /dsh-daruma/status: HTTP 404')

describe('isChannelRouteMiss', () => {
  it('matches the 404/405 route-miss shapes the browser caller throws', () => {
    expect(isChannelRouteMiss(new Error('transport failure for /dsh-daruma/status: HTTP 404'))).toBe(true)
    expect(isChannelRouteMiss(new Error('transport failure for /dsh-daruma/status: HTTP 405'))).toBe(true)
  })

  it('leaves every other failure on its own transport', () => {
    expect(isChannelRouteMiss(new Error('transport failure for /dsh-daruma/status: HTTP 500'))).toBe(false)
    expect(isChannelRouteMiss(new Error('transport failure for /dsh-daruma/status: HTTP 401'))).toBe(false)
    // No word boundary after the digits: "HTTP 4040" is not a 404.
    expect(isChannelRouteMiss(new Error('HTTP 4040'))).toBe(false)
    expect(isChannelRouteMiss('HTTP 404')).toBe(false)
    expect(isChannelRouteMiss(undefined)).toBe(false)
  })
})

describe('createAdaptiveRpc', () => {
  it('serves the legacy channel while it answers', async () => {
    const { connection: conn, calls } = connection(() => OK)
    const rpc = createAdaptiveRpc(conn)

    await expect(rpc('status')).resolves.toEqual(OK)
    expect(calls).toEqual([{ channel: LEGACY_CHANNEL, endpoint: 'status', payload: {} }])
  })

  it('tunnels through /api after the first route miss', async () => {
    const { connection: conn, calls } = connection((channel) => {
      if (channel === LEGACY_CHANNEL) throw routeMiss()
      return OK
    })
    const rpc = createAdaptiveRpc(conn)

    await expect(rpc('status', { sessionId: 's1' })).resolves.toEqual(OK)
    expect(calls).toEqual([
      { channel: LEGACY_CHANNEL, endpoint: 'status', payload: { sessionId: 's1' } },
      {
        channel: FALLBACK_CHANNEL,
        endpoint: FALLBACK_ENDPOINT,
        payload: { method: 'status', payload: { sessionId: 's1' } },
      },
    ])
  })

  it('stays on the fallback for the rest of the page lifetime', async () => {
    const { connection: conn, calls } = connection((channel) => {
      if (channel === LEGACY_CHANNEL) throw routeMiss()
      return OK
    })
    const rpc = createAdaptiveRpc(conn)

    await rpc('status')
    await rpc('listCandidates', { provider: 'mt' })
    expect(calls.filter((call) => call.channel === LEGACY_CHANNEL)).toHaveLength(1)
    expect(calls.filter((call) => call.channel === FALLBACK_CHANNEL)).toHaveLength(2)
  })

  it('rethrows a non-route-miss failure without trying the fallback', async () => {
    const { connection: conn, calls } = connection(() => {
      throw new Error('transport failure for /dsh-daruma/status: HTTP 500')
    })
    const rpc = createAdaptiveRpc(conn)

    await expect(rpc('status')).rejects.toThrow(/HTTP 500/u)
    expect(calls).toHaveLength(1)
  })

  it('surfaces a fallback failure as-is', async () => {
    const { connection: conn } = connection((channel) => {
      if (channel === LEGACY_CHANNEL) throw routeMiss()
      throw new Error('transport failure for /api/dsh-daruma/status: HTTP 401')
    })
    const rpc = createAdaptiveRpc(conn)

    await expect(rpc('status')).rejects.toThrow(/HTTP 401/u)
  })
})
