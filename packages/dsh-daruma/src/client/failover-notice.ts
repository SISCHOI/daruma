/**
 * Pure failover-notice logic for the daruma web client.
 *
 * Bridges the server-appended `daruma/failover` session event into a visible
 * row inside the DSH conversation window. Host chat rendering is
 * definition-driven and out-of-repo event types are never rendered on their
 * own (the host fallback only claims append-surface events), so the client
 * registers its own conversation definition (kind {@link FAILOVER_NOTICE_KIND},
 * target `chat`) plus a keyed renderer for that kind.
 *
 * This module is framework- and DOM-free on purpose: the event contract and
 * the produced chat node are unit-testable without mounting a browser.
 */

/** Session event type appended by the daruma server on every channel switch. */
export const FAILOVER_EVENT_TYPE = 'daruma/failover'

/** Chat node kind (conversation-definition kind + renderer key) used here. */
export const FAILOVER_NOTICE_KIND = 'daruma-failover'

/** Display data carved out of one `daruma/failover` session event. */
export interface FailoverNoticeData {
  /** Channel id the request failed on, e.g. `mt::glm-5.3`. */
  readonly from: string
  /** Channel id recovery switched to. */
  readonly to: string
  /** Stable failure code, e.g. `RATE_LIMIT`. */
  readonly reason: string
  /** Epoch ms of the failover decision. */
  readonly at: number
  /** Turn containing the failed request. */
  readonly turn: number
  /** Step containing the failed request attempt. */
  readonly step: number
  /** Scope failover count AFTER this decision (1-based on first failover). */
  readonly count: number
  /** Scope give-up budget the count counts against. */
  readonly budget: number
}

/** Structural view of a raw session event (host types stay server-side). */
export interface RawSessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
}

/** One accepted match, as the host engine hands it to a Definition. */
export interface ConversationMatchLike {
  readonly event: RawSessionEventLike
  readonly location?: unknown
}

/**
 * Engine-owned Context handed to Definition hooks — the structural subset
 * this client reads (host types live server-side in `@deepseek-ai/*`).
 */
export interface ConversationContextLike {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly state?: unknown
  readonly start?: ConversationMatchLike
}

/** The final chat node this Definition materializes (structural subset). */
export interface ChatNodeLike {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: unknown
  readonly visibility: 'visible'
  readonly data: FailoverNoticeData
}

/** Minimal host conversation-definition surface this client registers. */
export interface ConversationDefinitionLike {
  readonly kind: string
  readonly target: 'chat'
  match(event: RawSessionEventLike): { readonly id: string; readonly role: 'start' | 'update' } | null
  start(context: ConversationContextLike, match: ConversationMatchLike): FailoverNoticeData
  update(context: ConversationContextLike, match: ConversationMatchLike): FailoverNoticeData
  buildViewNode(context: ConversationContextLike): ChatNodeLike | null
}

/** Display length caps mirroring the server-side event assembly. */
const CHANNEL_LIMIT = 80
const REASON_LIMIT = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim a payload string, clipping over-long values with an ellipsis. */
function clip(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Defensively parse one `daruma/failover` payload into display data.
 * Returns `null` when the payload is not a usable failover record, so a
 * malformed event never renders (and is never claimed by this definition).
 */
export function parseFailoverNotice(raw: unknown): FailoverNoticeData | null {
  if (!isRecord(raw)) return null
  const from = clip(raw.from, CHANNEL_LIMIT)
  const to = clip(raw.to, CHANNEL_LIMIT)
  if (from === undefined || to === undefined) return null
  const reason = clip(raw.reason, REASON_LIMIT) ?? 'FAILURE'
  const at = finiteNumber(raw.at)
  return {
    from,
    to,
    reason,
    at: at === 0 ? Date.now() : at,
    turn: finiteNumber(raw.turn),
    step: finiteNumber(raw.step),
    count: finiteNumber(raw.failoverCount),
    budget: finiteNumber(raw.giveUpBudget),
  }
}

/** Replace `{key}` placeholders with matching values; unknown keys stay. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? values[name] ?? '' : match,
  )
}

/** Human copy for one failover row, built from the bound daruma dictionary. */
export interface FailoverNoticeCopy {
  /** The one-liner rendered inside the conversation flow. */
  readonly line: string
  /** Longer context shown on hover (budget usage, turn/step). */
  readonly detail: string
}

/** Compose the row copy through the daruma locale dictionary. */
export function failoverNoticeCopy(
  data: FailoverNoticeData,
  t: (key: string) => string,
): FailoverNoticeCopy {
  const line = fillTemplate(t('failoverNoticeLine'), {
    from: data.from,
    to: data.to,
    reason: data.reason,
  })
  const detail = fillTemplate(t('failoverNoticeDetail'), {
    count: String(data.count),
    budget: String(data.budget),
    turn: String(data.turn),
    step: String(data.step),
  })
  return { line, detail }
}

/**
 * The conversation Definition claiming `daruma/failover` events for the chat
 * target. One failover = one context (id = its event seq) = one settled row,
 * anchored at the event's own log position so it lands inline in the flow.
 */
export function createFailoverNoticeDefinition(): ConversationDefinitionLike {
  const start = (_context: ConversationContextLike, match: ConversationMatchLike): FailoverNoticeData => {
    const parsed = parseFailoverNotice(match.event.data)
    if (parsed === null) {
      throw new Error(
        `daruma failover notice: unparseable ${FAILOVER_EVENT_TYPE} event at seq ${match.event.seq}`,
      )
    }
    return parsed
  }
  return {
    kind: FAILOVER_NOTICE_KIND,
    target: 'chat',
    match: (event) => {
      if (event.type !== FAILOVER_EVENT_TYPE) return null
      if (parseFailoverNotice(event.data) === null) return null
      return { id: String(event.seq), role: 'start' }
    },
    start,
    // Every claimed event is a standalone start; keep update total for safety.
    update: (context, match) => start(context, match),
    buildViewNode: (context) => {
      const match = context.start
      if (match === undefined) return null
      const data = parseFailoverNotice(match.event.data)
      if (data === null) return null
      return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: 'chat',
        anchorSeq: match.event.seq,
        location: match.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data,
      }
    },
  }
}
