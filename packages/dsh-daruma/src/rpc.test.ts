import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountRpc, type RpcDeps } from './rpc.ts'

interface Harness {
  readonly ctx: Context
  readonly warns: string[]
  readonly effects: string[]
}

function harness(connection: unknown): Harness {
  const warns: string[] = []
  const effects: string[] = []
  const ctx = {
    get: (name: string) => (name === 'connection' ? connection : undefined),
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '(unlabeled)')
      callback()
    },
    logger: {
      warn: (message: string) => { warns.push(message) },
      info: () => {},
    },
  } as unknown as Context
  return { ctx, warns, effects }
}

function deps(): RpcDeps {
  return {
    engine: {
      channels: [],
      listHealth: () => [],
      failoverCount: 0,
      history: [],
      giveUpBudget: 8,
    },
    currentChannel: new Map(),
    status: {
      getBackup: () => undefined,
      setBackup: async () => {},
      clearBackup: async () => {},
    },
    getLlm: () => undefined,
    getSettings: () => undefined,
  } as unknown as RpcDeps
}

describe('mountRpc', () => {
  it('registers the /dsh-daruma channel and ties its disposer to an effect', () => {
    const channels: string[] = []
    const connection = {
      rpc: {
        handle: (channel: string) => {
          channels.push(channel)
          return async () => {}
        },
      },
    }
    const { ctx, warns, effects } = harness(connection)

    mountRpc(ctx, deps())

    expect(channels).toEqual(['/dsh-daruma'])
    expect(effects).toEqual(['dsh-daruma: /dsh-daruma rpc channel'])
    expect(warns).toEqual([])
  })

  it('warns instead of throwing when the host refuses the channel registration', () => {
    const connection = {
      rpc: {
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
    }
    const { ctx, warns, effects } = harness(connection)

    expect(() => mountRpc(ctx, deps())).not.toThrow()
    expect(effects).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('could not be registered')
    expect(warns[0]).toContain('without inject')
  })

  it('does nothing when the host composes no web transport', () => {
    const { ctx, warns, effects } = harness(undefined)
    mountRpc(ctx, deps())
    expect(effects).toEqual([])
    expect(warns).toEqual([])
  })
})
