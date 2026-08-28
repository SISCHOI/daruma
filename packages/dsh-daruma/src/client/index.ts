/**
 * dsh-daruma client: registers a compact channel-status dock above the
 * composer (conversation.input.dock) with a "backup channel" panel that can
 * probe candidate models and pick a backup. Built by tsdown into the
 * __ModuleLoader__ factory bundle at lib/client.js.
 */

import { createElement as h } from 'react'
import { en, zh } from './locales.ts'
import { createApi, type Rpc, type RpcResult } from './api.ts'
import { StatusDock } from './StatusDock.tsx'

const NS = 'daruma'

type Translate = (key: string) => string

/** Structural client context (host provides the real cordis context). */
interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): Translate
  }
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
  get(service: string): unknown
}

/** Connection handle shape (from @deepseek-ai/dsh-client-connection). */
interface ConnectionLike {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
  }
}

export const name = 'dsh-daruma'
export const inject = ['slots', 'locale'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-daruma: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection === undefined) {
    console.warn('[dsh-daruma] web transport unavailable — client UI disabled')
    return
  }
  const rpc: Rpc = (endpoint, payload) =>
    connection.rpc.call('/dsh-daruma', endpoint, payload ?? {}) as Promise<RpcResult>
  const api = createApi(rpc)

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'daruma-status',
    order: 0,
    inject: () => ({ api, t }),
  }, () => h(StatusDock, { api, t })))
}
