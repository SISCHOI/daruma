/**
 * Plugin-level regression for the failover swap.
 *
 * The production failure this covers (2026-09-11): a session on
 * `deepseek-official/deepseek-v4-flash` with `reasoningEffort: "high"` hit
 * `CONTEXT_WINDOW_EXCEEDED`, daruma armed a failover target whose route
 * advertises no reasoning capability, and the swapped request was refused by
 * DSH's pre-dispatch validation (`UNSUPPORTED_REASONING_EFFORT`) — a refusal
 * raised outside `agent/request-error`, so the turn died and the failover
 * channel never dispatched. These tests drive the real plugin hooks, so the
 * arms of the waterfall that matter (arming, swapping, logging) stay covered.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig, type LlmResolvedModelInfo, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from './index.ts'

const AGENT_ID = 'session-effort-1'

const BASE: LlmCallConfig = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('high'),
  maxTokens: 256_000,
}

type Listener = (payload: unknown, next: () => Promise<unknown>) => unknown

interface Harness {
  readonly ctx: Context
  readonly logs: string[]
  /** Drive one registered waterfall listener. */
  readonly fire: (event: string, payload: unknown, next?: () => Promise<unknown>) => Promise<unknown>
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

const dirs: string[] = []

function harness(options: {
  readonly efforts?: readonly string[] | undefined
  readonly throws?: boolean
  /** Override the budget of 1, so counted-failure paths can be exercised. */
  readonly failureBudget?: number
}): Harness {
  const logs: string[] = []
  const listeners = new Map<string, Listener>()
  const dir = mkdtempSync(join(tmpdir(), 'daruma-effort-'))
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
    settings: { register: () => scope, mutate: async () => {} },
    llm: {
      resolveModelInfo: async () => {
        if (options.throws === true) throw new Error('NO_ADAPTER')
        return modelInfo(options.efforts)
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
    dir,
    async fire(event, payload, next = async () => undefined) {
      const listener = listeners.get(event)
      if (listener === undefined) throw new Error(`no listener registered for ${event}`)
      return await listener(payload, next)
    },
  }
}

function agentStub(): Agent {
  return { id: AGENT_ID, session: { append: vi.fn() } } as unknown as Agent
}

/** Take one request on the base channel, then trip it into a failover. */
async function armFailover(h: Harness, agent: Agent): Promise<void> {
  await h.fire('agent/request', { agent }, async () => ({ ...BASE }))
  const action = await h.fire(
    'agent/request-error',
    {
      agent,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400, message: 'too long' },
      turn: 26,
      step: 1,
      provider: BASE.provider,
    },
    async () => undefined,
  )
  expect(action).toEqual({ kind: 'retry' })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('dsh-daruma failover swap', () => {
  it('drops an effort the failover target cannot take, so the retried request can dispatch', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    await armFailover(h, agent)

    const swapped = (await h.fire('agent/request', { agent }, async () => ({ ...BASE }))) as LlmCallConfig

    expect(swapped.provider).toBe('mt')
    expect(swapped.model).toBe('glm-5.2')
    expect(swapped.maxTokens).toBe(256_000)
    expect('reasoningEffort' in swapped).toBe(false)
    expect(h.logs.some((line) => line.includes('does not accept reasoning effort "high"'))).toBe(true)
  })

  it('keeps an effort the failover target advertises', async () => {
    const h = harness({ efforts: ['off', 'low', 'high'] })
    const agent = agentStub()
    await armFailover(h, agent)

    const swapped = (await h.fire('agent/request', { agent }, async () => ({ ...BASE }))) as LlmCallConfig

    expect(swapped).toMatchObject({ provider: 'mt', model: 'glm-5.2', reasoningEffort: 'high' })
    expect(h.logs.some((line) => line.includes('does not accept reasoning effort'))).toBe(false)
  })

  it('drops the effort when the target capability cannot be resolved', async () => {
    const h = harness({ throws: true })
    const agent = agentStub()
    await armFailover(h, agent)

    const swapped = (await h.fire('agent/request', { agent }, async () => ({ ...BASE }))) as LlmCallConfig

    expect('reasoningEffort' in swapped).toBe(false)
    expect(h.logs.some((line) => line.includes('could not resolve reasoning efforts'))).toBe(true)
  })

  it('passes a request without an effort through the swap untouched', async () => {
    const h = harness({ efforts: undefined })
    const agent = agentStub()
    const noEffort: LlmCallConfig = { provider: BASE.provider, model: BASE.model, maxTokens: BASE.maxTokens }
    await h.fire('agent/request', { agent }, async () => ({ ...noEffort }))
    await h.fire(
      'agent/request-error',
      { agent, failure: { code: 'RATE_LIMIT', status: 429, message: 'slow down' }, turn: 1, step: 1, provider: noEffort.provider },
      async () => undefined,
    )

    const swapped = (await h.fire('agent/request', { agent }, async () => ({ ...noEffort }))) as LlmCallConfig

    expect(swapped).toEqual({ ...noEffort, provider: 'mt', model: 'glm-5.2' })
    expect(h.logs.some((line) => line.includes('reasoning effort'))).toBe(false)
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
      provider: BASE.provider,
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
    }
  }

  it('fails over on the first failure once the retry budget is spent', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await h.fire('agent/request', { agent }, async () => ({ ...BASE }))

    const action = await h.fire('agent/request-error', failure(agent, SPENT), async () => undefined)
    expect(action).toEqual({ kind: 'retry' })

    const swapped = (await h.fire('agent/request', { agent }, async () => ({ ...BASE }))) as LlmCallConfig
    expect(swapped).toMatchObject({ provider: 'mt', model: 'glm-5.2' })

    // A post-hoc auditor must be able to tell an escalated switch from a counted
    // one, so the decision carries the escalation into the JSONL log.
    const lines = readFileSync(join(h.dir, 'failover-log.jsonl'), 'utf8').trim().split('\n')
    const failover = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === 'failover')
    expect(failover).toMatchObject({
      from: 'deepseek-official::deepseek-v4-flash',
      to: 'mt::glm-5.2',
      reason: 'RATE_LIMIT',
      retryExhausted: true,
      failoverCount: 1,
    })
  })

  it('still needs three failing turns when no retry budget was spent', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await h.fire('agent/request', { agent }, async () => ({ ...BASE }))

    // No retryPolicy in the payload: nothing retried it, so it is one unit each.
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined)).toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined)).toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent), async () => undefined))
      .toEqual({ kind: 'retry' })
  })

  it('does not read `always` mode as a spent budget', async () => {
    const h = harness({ failureBudget: 3 })
    const agent = agentStub()
    await h.fire('agent/request', { agent }, async () => ({ ...BASE }))

    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toBeUndefined()
    expect(await h.fire('agent/request-error', failure(agent, ALWAYS), async () => undefined))
      .toEqual({ kind: 'retry' })
  })
})
