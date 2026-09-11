import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountWithWebTransport, WEB_TRANSPORT_SERVICE } from './host-mount.ts'

interface Harness {
  readonly host: Context
  readonly logs: string[]
  readonly requested: string[][]
  /** True once the helper registered an injection callback. */
  readonly pending: () => boolean
  /** Deliver the named services to the registered callback. */
  readonly deliver: (services: Record<string, unknown>) => Context | undefined
}

function harness(): Harness {
  const logs: string[] = []
  const requested: string[][] = []
  let callback: ((injected: Context) => void) | undefined
  const host = {
    logger: { info: (message: string) => { logs.push(message) } },
    inject: (services: readonly string[], registered: (injected: Context) => void) => {
      requested.push([...services])
      callback = registered
      return {}
    },
  } as unknown as Context
  return {
    host,
    logs,
    requested,
    pending: () => callback !== undefined,
    deliver(services) {
      if (callback === undefined) return undefined
      const injected = { get: (name: string) => services[name] } as unknown as Context
      callback(injected)
      return injected
    },
  }
}

describe('mountWithWebTransport', () => {
  it('registers an injection for the web transport instead of reading it at apply time', () => {
    const { host, logs, requested, pending } = harness()
    let mounts = 0
    mountWithWebTransport(host, () => { mounts++ })

    expect(requested).toEqual([[WEB_TRANSPORT_SERVICE]])
    expect(pending()).toBe(true)
    // A host that has not provided the services yet mounts nothing — and must
    // not log a capability snapshot that reads as "unsupported".
    expect(mounts).toBe(0)
    expect(logs).toEqual([])
  })

  it('mounts once the transport is delivered, with capabilities read after injection', () => {
    const { host, logs, deliver } = harness()
    const mounted: Context[] = []
    mountWithWebTransport(host, (ctx) => { mounted.push(ctx) })

    const injected = deliver({
      connection: { rpc: { handle: () => () => Promise.resolve() } },
      conversationEvents: { register: () => () => {} },
    })

    expect(mounted).toEqual([injected])
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0]!.replace('dsh-daruma: host capabilities ', '')))
      .toEqual({ conversationEvents: true, rpc: true })
  })

  it('still mounts when the transport exposes no rpc surface, reporting it honestly', () => {
    const { host, logs, deliver } = harness()
    let mounts = 0
    mountWithWebTransport(host, () => { mounts++ })

    deliver({ connection: {} })

    expect(mounts).toBe(1)
    expect(JSON.parse(logs[0]!.replace('dsh-daruma: host capabilities ', '')))
      .toEqual({ conversationEvents: false, rpc: false })
  })
})
