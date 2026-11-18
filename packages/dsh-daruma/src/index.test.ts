/**
 * Plugin-level regression for the failover routing.
 *
 * Two production failures are covered here.
 *
 * 2026-09-11: a session on `deepseek-official/deepseek-v4-flash` with
 * `reasoningEffort: "high"` hit `CONTEXT_WINDOW_EXCEEDED`, daruma armed a
 * failover target whose route advertises no reasoning capability, and the
 * swapped request was refused by DSH's pre-dispatch validation
 * (`UNSUPPORTED_REASONING_EFFORT`) — a refusal raised outside
 * `agent/request-error`, so the turn died and the failover channel never
 * dispatched. The effort disposition itself is covered by `mapping.test.ts`.
 *
 * 2026-11-18: DSH 0.2.1-alpha.4 fixed the model selection at step preparation
 * and made an `agent/request` provider/model replacement a hard error, so the
 * switch itself killed every turn it was meant to save. Failover now happens on
 * the `llm/stream` routing waterfall, which is what these tests drive: the
 * loop's request stays untouched, only the executor changes.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  ReasoningEffortId,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from './index.ts'

const AGENT_ID = 'session-effort-1'
const OTHER_AGENT_ID = 'session-other-2'

/** The route the user selected; the loop's request always names it. */
const PRIMARY = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const
const PRIMARY_ID = 'deepseek-official::deepseek-v4-flash'
const TARGET_ID = 'mt::glm-5.2'

type Listener = (payload: unknown, next: () => unknown) => unknown

interface Harness {
  readonly ctx: Context
  readonly logs: string[]
  /** Requests this plugin re-dispatched itself, in order. */
  readonly routed: GenerateOptions[]
  /** Drive one registered promise waterfall listener. */
  readonly fire: (event: string, payload: unknown, next?: () => Promise<unknown>) => Promise<unknown>
  /** Drive the `llm/stream` waterfall listener and return its stream. */
  readonly stream: (options: GenerateOptions, next?: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  readonly dir: string
}

/** Model metadata for one target; `efforts: undefined` means "no reasoning". */
function modelInfo(efforts: readonly string[] | undefined): LlmResolvedModelInfo {
  return {
    provider: 'mt',
    id: 'glm-5.2',
    name: 'GLM 5.2',
    ...(efforts === undefined
      ? {}
      : { reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } }),
  } as LlmResolvedModelInfo
}

/** One clean chunk, so a redirected stream is distinguishable from the adapter's. */
function routedStream(): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'from the failover target' }
  })()
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The single request this plugin re-dispatched itself. */
function firstRouted(h: Harness): GenerateOptions {
  const first = h.routed[0]
  if (first === undefined) throw new Error('no request was re-dispatched')
  return first
}

/** A request exactly as the agent loop hands it to the LLM runtime. */
function loopRequest(
  sessionId: string = AGENT_ID,
  overrides: Partial<GenerateOptions> = {},
): GenerateOptions {
  return markAgentLoopRequest({
    ...PRIMARY,
    messages: [],
    sessionId: sessionId as GenerateOptions['sessionId'],
    ...overrides,
  })
}

const dirs: string[] = []

function harness(options: {
  readonly efforts?: readonly string[] | undefined
  readonly throws?: boolean
  /** Override the budget of 1, so counted-failure paths can be exercised. */
  readonly failureBudget?: number
}): Harness {
  const logs: string[] = []
  const routed: GenerateOptions[] = []
  const listeners = new Map<string, Listener>()
  const dir = mkdtempSync(join(tmpdir(), 'daruma-failover-'))
  dirs.push(dir)
  const scope = { get: () => ({}), update: async () => {}, watch: () => () => {} }
  const ctx = {
    logger: {
      info: (message: string) => { logs.push(`info: ${message}`) },
      warn: (message: string) => { logs.push(`warn: ${message}`) },
      error: (message: string) => { logs.push(`error: ${message}`) },
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    inject: () => ({}),
    get: (name: string) => (name === 'settings' ? { register: () => scope, mutate: async () => {} } : undefined),
    settings: { register: () => scope, mutate: async () => {} },
    llm: {
      resolveModelInfo: async () => {
        if (options.throws === true) throw new Error('NO_ADAPTER')
        return modelInfo(options.efforts)
      },
      stream: (request: GenerateOptions) => {
        routed.push(request)
        return routedStream()
      },
    },
  } as unknown as Context

  apply(ctx, {
    channels: [{ provider: 'mt', model: 'glm-5.2' }],
    failureBudget: options.failureBudget ?? 1,
    cooldownMs: 30_000,
    giveUpBudget: 8,
    stateFile: join(dir, 'channel-health.json'),
  })

  return {
    ctx,
    logs,
    routed,
    dir,
    async fire(event, payload, next = async () => undefined) {
      const listener = listeners.get(event)
      if (listener === undefined) throw new Error(`no listener registered for ${event}`)
      return await listener(payload, next)
    },
    stream(options, next = () => routedStream()) {
      const listener = listeners.get('llm/stream')
      if (listener === undefined) throw new Error('no listener registered for llm/stream')
      return listener(options, next) as AsyncIterable<StreamChunk>
    },
  }
}

function agentStub(): Agent {
  return { id: AGENT_ID, session: { append: vi.fn() } } as unknown as Agent
}

/**
 * Dispatch one attempt on the primary route (records the current channel), then
 * trip the channel into a failover, leaving a target armed for the retry.
 */
async function armFailover(h: Harness, agent: Agent): Promise<void> {
  await drain(h.stream(loopRequest()))
  const action = await h.fire(
    'agent/request-error',
    {
      agent,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400, message: 'too long' },
      turn: 26,
      step: 1,
      provider: PRIMARY.provider,
    },
    async () => undefined,
  )
  expect(action).toEqual({ kind: 'retry' })
  expect(agent.session.append).not.toHaveBeenCalled()
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('dsh-daruma failover routing', () => {
  it('dispatches the retried attempt on the target instead of the failed channel', async () => {
    const h = harness({ efforts: ['off', 'low', 'high'] })
    const agent = agentStub()
    await armFailover(h, agent)

    const next = vi.fn(() => routedStream())
    const chunks = await drain(h.stream(loopRequest(), next))

    // The failed channel is never asked again: no `next()`, so the host did not
    // build a second request on the route that just broke.
    expect(next).not.toHaveBeenCalled()
    expect(h.routed).toHaveLength(1)
    expect(firstRouted(h)).toMatchObject({ provider: 'mt', model: 'glm-5.2' })
    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'from the failover target' }])
    expect(h.logs.some((line) => line.includes(`${PRIMARY_ID} -> ${TARGET_ID}`))).toBe(true)
  })

  it('leaves the caller request untouched, including its effort when the target takes it', async () => {
    const h = harness({ efforts: ['off', 'low', 'high'] })
    const agent = agentStub()
    await armFailover(h, agent)

    const request = loopRequest(AGENT_ID, { reasoningEffort: ReasoningEffortId('high') })
    await drain(h.stream(request))

    // The loop's request is read-only per the host contract, and the routed copy
    // keeps every field a failover must not re-shape.
    expect(request.provider).toBe(PRIMARY.provider)
    expect(request.model).toBe(PRIMARY.model)
    expect(firstRouted(h)).toMatchObject({
      provider: 'mt',
      model: 'glm-5.2',
      reasoningEffort: 'high',
      sessionId: AGENT_ID,
    })
  })

  it('drops an effort the failover target cannot take, so the retried request can dispatch', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    await armFailover(h, agent)

    await drain(h.stream(loopRequest(AGENT_ID, { reasoningEffort: ReasoningEffortId('high') })))

    expect(firstRouted(h).provider).toBe('mt')
    expect('reasoningEffort' in firstRouted(h)).toBe(false)
    expect(h.logs.some((line) => line.includes('does not accept reasoning effort "high"'))).toBe(true)
  })

  it('arms the target once: a later dispatch goes back to the host chain', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    await armFailover(h, agent)

    await drain(h.stream(loopRequest()))
    const next = vi.fn(() => routedStream())
    await drain(h.stream(loopRequest(), next))

    expect(next).toHaveBeenCalledTimes(1)
    expect(h.routed).toHaveLength(1)
  })

  it('does not redirect another session sharing the same failed route', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    await armFailover(h, agent)

    const otherNext = vi.fn(() => routedStream())
    await drain(h.stream(loopRequest(OTHER_AGENT_ID), otherNext))
    expect(otherNext).toHaveBeenCalledTimes(1)

    // The arm survives the unrelated call and still serves its own session.
    const next = vi.fn(() => routedStream())
    await drain(h.stream(loopRequest(), next))
    expect(next).not.toHaveBeenCalled()
    expect(h.routed).toHaveLength(1)
  })

  it('does not redirect a call the agent loop did not assemble', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    await armFailover(h, agent)

    // Compaction and session-title helpers reuse the same route without the
    // loop marker; a failover must not hijack them.
    const helperRequest: GenerateOptions = {
      ...PRIMARY,
      messages: [],
      sessionId: AGENT_ID as GenerateOptions['sessionId'],
    }
    const next = vi.fn(() => routedStream())
    await drain(h.stream(helperRequest, next))

    expect(next).toHaveBeenCalledTimes(1)
    expect(h.routed).toHaveLength(0)
  })
})

/**
 * The 2026-09-17 production failure these cover: one turn burned five
 * same-channel retries on `RATE_LIMIT` (10:49:30–10:49:42), the failure then
 * reached daruma exactly once, and `failureBudget: 3` kept the channel routable
 * — so a saturated channel never switched while a terminal code switched on its
 * first failure.
 */
describe('dsh-daruma retry-exhaustion escalation', () => {
  const SPENT: ResolvedRetryPolicy = {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }
  const ALWAYS: ResolvedRetryPolicy = {
    mode: 'always',
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }

  /** One failed request, as the host hands it to the waterfall. */
  function failure(agent: Agent, retryPolicy?: ResolvedRetryPolicy): unknown {
    return {
      agent,
      failure: { code: 'RATE_LIMIT', status: 429, message: 'slow down' },
      turn: 1,
      step: 1,
      provider: PRIMARY.provider,
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
    }
  }

  it('fails over on the first failure once the retry budget is spent', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await drain(h.stream(loopRequest()))

    const action = await h.fire('agent/request-error', failure(agent, SPENT), async () => undefined)
    expect(action).toEqual({ kind: 'retry' })

    expect(await drain(h.stream(loopRequest()))).toEqual([
      { type: 'text-delta', index: 0, text: 'from the failover target' },
    ])
    expect(firstRouted(h)).toMatchObject({ provider: 'mt', model: 'glm-5.2' })

    // A post-hoc auditor must be able to tell an escalated switch from a counted
    // one, so the decision carries the escalation into the JSONL log.
    const lines = readFileSync(join(h.dir, 'failover-log.jsonl'), 'utf8').trim().split('\n')
    const failover = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === 'failover')
    expect(failover).toMatchObject({
      from: PRIMARY_ID,
      to: TARGET_ID,
      reason: 'RATE_LIMIT',
      retryExhausted: true,
      failoverCount: 1,
    })
  })

  it('still needs three failing turns when no retry budget was spent', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await drain(h.stream(loopRequest()))

    // No retryPolicy in the payload: nothing retried it, so it is one unit each.
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined)).toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined)).toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined))
      .toEqual({ kind: 'retry' })
  })

  it('does not read `always` mode as a spent budget', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await drain(h.stream(loopRequest()))

    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toEqual({ kind: 'retry' })
  })
})
