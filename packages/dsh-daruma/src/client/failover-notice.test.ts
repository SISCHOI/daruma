import { describe, expect, it } from 'vitest'
import {
  createFailoverNoticeDefinition,
  failoverNoticeCopy,
  FAILOVER_EVENT_TYPE,
  FAILOVER_NOTICE_KIND,
  fillTemplate,
  parseFailoverNotice,
  type ConversationContextLike,
  type RawSessionEventLike,
} from './failover-notice.ts'
import { en, zh } from './locales.ts'

/** t() bound to one dictionary (keys fall back to themselves). */
function translate(dict: Record<string, string>): (key: string) => string {
  return (key) => dict[key] ?? key
}

const zhT = translate(zh as Record<string, string>)
const enT = translate(en as Record<string, string>)

/** A plausible server-emitted daruma/failover payload. */
const PAYLOAD = {
  from: 'mt::glm-5.3',
  to: 'deepseek-official::deepseek-v4-flash',
  reason: 'RATE_LIMIT',
  at: 1_725_000_000_000,
  turn: 3,
  step: 1,
  failoverCount: 2,
  giveUpBudget: 3,
}

function failoverEvent(data: unknown, seq = 41): RawSessionEventLike {
  return { type: FAILOVER_EVENT_TYPE, seq, time: 1_725_000_000_000, data }
}

function context(event: RawSessionEventLike): ConversationContextLike {
  return {
    key: `${FAILOVER_NOTICE_KIND}:${event.seq}`,
    kind: FAILOVER_NOTICE_KIND,
    id: String(event.seq),
    start: { event, location: { kind: 'turn', turn: { turn: 3 } } },
  }
}

describe('parseFailoverNotice', () => {
  it('carries the failover facts through', () => {
    const parsed = parseFailoverNotice(PAYLOAD)
    expect(parsed).toEqual({
      from: 'mt::glm-5.3',
      to: 'deepseek-official::deepseek-v4-flash',
      reason: 'RATE_LIMIT',
      at: 1_725_000_000_000,
      turn: 3,
      step: 1,
      count: 2,
      budget: 3,
    })
  })

  it('rejects non-record payloads', () => {
    for (const raw of [undefined, null, 'mt', 42, ['mt']]) {
      expect(parseFailoverNotice(raw)).toBeNull()
    }
  })

  it('rejects payloads without a source or target channel', () => {
    expect(parseFailoverNotice({ ...PAYLOAD, from: undefined })).toBeNull()
    expect(parseFailoverNotice({ ...PAYLOAD, to: '' })).toBeNull()
  })

  it('defaults a missing reason and clips over-long channel ids', () => {
    const parsed = parseFailoverNotice({
      ...PAYLOAD,
      from: 'x'.repeat(200),
      reason: undefined,
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.from).toBe(`${'x'.repeat(80)}…`)
    expect(parsed?.reason).toBe('FAILURE')
  })
})

describe('fillTemplate', () => {
  it('substitutes named placeholders and leaves unknown ones intact', () => {
    expect(fillTemplate('{a} -> {b} ({unknown})', { a: '1', b: '2' })).toBe('1 -> 2 ({unknown})')
  })
})

describe('failoverNoticeCopy', () => {
  const data = parseFailoverNotice(PAYLOAD)!

  it('renders the zh one-liner and detail', () => {
    const { line, detail } = failoverNoticeCopy(data, zhT)
    expect(line).toBe('mt::glm-5.3 请求失败（RATE_LIMIT）→ 本次尝试 deepseek-official::deepseek-v4-flash')
    expect(detail).toBe('第 2/3 次失败切换 · turn 3 step 1')
  })

  it('renders the en one-liner and detail', () => {
    const { line, detail } = failoverNoticeCopy(data, enT)
    expect(line).toBe('mt::glm-5.3 failed (RATE_LIMIT) → trying deepseek-official::deepseek-v4-flash')
    expect(detail).toBe('failover 2/3 · turn 3 step 1')
  })
})

describe('failover notice definition', () => {
  const definition = createFailoverNoticeDefinition()

  it('declares the chat target under its own kind', () => {
    expect(definition.kind).toBe(FAILOVER_NOTICE_KIND)
    expect(definition.kind).not.toBe(FAILOVER_EVENT_TYPE)
    expect(definition.target).toBe('chat')
  })

  it('claims exactly daruma/failover events with a usable payload', () => {
    expect(definition.match(failoverEvent(PAYLOAD, 7))).toEqual({ id: '7', role: 'start' })
    expect(definition.match({ ...failoverEvent(PAYLOAD), type: 'user/message' })).toBeNull()
    expect(definition.match(failoverEvent({ from: 'only-one-side' }))).toBeNull()
  })

  it('starts with the parsed failover facts', () => {
    const match = definition.match(failoverEvent(PAYLOAD))
    expect(match).not.toBeNull()
    const state = definition.start(context(failoverEvent(PAYLOAD)), { event: failoverEvent(PAYLOAD) })
    expect(state.to).toBe('deepseek-official::deepseek-v4-flash')
    expect(state.count).toBe(2)
  })

  it('builds a settled chat node anchored at the event seq', () => {
    const event = failoverEvent(PAYLOAD, 41)
    const node = definition.buildViewNode(context(event))
    expect(node).not.toBeNull()
    expect(node).toEqual({
      key: `${FAILOVER_NOTICE_KIND}:41`,
      kind: FAILOVER_NOTICE_KIND,
      id: '41',
      target: 'chat',
      anchorSeq: 41,
      location: { kind: 'turn', turn: { turn: 3 } },
      visibility: 'visible',
      data: expect.objectContaining({ from: 'mt::glm-5.3', count: 2 }),
    })
  })

  it('builds nothing without a start match or a usable payload', () => {
    expect(definition.buildViewNode({ key: 'k', kind: FAILOVER_NOTICE_KIND, id: '41' })).toBeNull()
    expect(definition.buildViewNode(context(failoverEvent({ nope: true }, 42)))).toBeNull()
  })
})
