/**
 * dsh-daruma client: registers a compact channel-status dock above the
 * composer (conversation.input.dock) with a "backup channel" panel that
 * lists candidate models and picks a backup. Built by tsdown into the
 * __ModuleLoader__ factory bundle at lib/client.js.
 */

import { createElement as h } from 'react'
import { en, zh } from './locales.ts'
import { createApi, type Rpc, type RpcResult } from './api.ts'
import { StatusDock } from './StatusDock.tsx'
import {
  createFailoverNoticeDefinition,
  FAILOVER_NOTICE_KIND,
  type ConversationDefinitionLike,
} from './failover-notice.ts'
import { FailoverNoticeRow } from './FailoverNoticeRow.tsx'

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

/**
 * Host conversation-event registry surface (`ctx.get('conversationEvents')`),
 * structurally typed — the real service comes from the web client runtime.
 */
interface ConversationEventsLike {
  register(definition: ConversationDefinitionLike): () => void
}

/**
 * Register the live failover notice: one conversation Definition claiming
 * `daruma/failover` events for the chat target, plus the keyed renderer for
 * its node kind. Absent or failing registrations degrade to nothing visible
 * (warn only) — the panel keeps working either way.
 */
function registerFailoverChatNotice(ctx: ClientContext): void {
  const registry = ctx.get('conversationEvents') as ConversationEventsLike | undefined
  if (registry === undefined) {
    console.warn('[dsh-daruma] conversation event registry unavailable — failover chat rows disabled')
  } else {
    try {
      ctx.effect(
        () => registry.register(createFailoverNoticeDefinition()),
        'dsh-daruma: failover notice definition',
      )
    } catch (error) {
      console.warn('[dsh-daruma] failover notice definition registration failed', error)
    }
  }
  ctx.slots.inject('conversation.chat.node', () => {
    try {
      // The keyed seat instantiates entries with props (node, t, …); the
      // structural slot type is narrower than the host's real registry.
      return ctx.slots.register(
        {
          name: 'conversation.chat.node',
          key: FAILOVER_NOTICE_KIND,
          locale: NS,
        },
        FailoverNoticeRow as unknown as () => unknown,
      )
    } catch (error) {
      console.warn('[dsh-daruma] failover notice renderer registration failed', error)
      return () => {}
    }
  })
}

export const name = 'dsh-daruma'
export const inject = ['slots', 'locale'] as const

export function apply(ctx: ClientContext): void {
  // Widen the backup-panel dialog: the primitives Modal card is fixed at
  // min(380px, 100%), which truncates long provider/model names. A global
  // class (not a CSS module) outranks the module-scoped `.dialog` rule.
  if (typeof document !== 'undefined') {
    const tagId = 'daruma-panel-style'
    if (document.querySelector(`style[data-daruma="${tagId}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.daruma = tagId
      style.textContent = '.daruma-wide-dialog.daruma-wide-dialog { width: min(560px, 100%); }'
      document.head.appendChild(style)
    }
  }

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

  registerFailoverChatNotice(ctx)
}
