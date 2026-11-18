import { describe, expect, it, vi } from 'vitest'
import {
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import {
  channelIdOf,
  isRetryExhausted,
  toFailoverOptions,
  toFailureCode,
  toFailureSignal,
  type ReasoningCapabilityLookup,
} from './mapping.ts'
import { channelId, modelId, type Channel } from 'daruma-core'

const TARGET: Channel = { id: channelId('mt::glm-5.2'), provider: 'mt', model: modelId('glm-5.2') }

/**
 * One target's resolvable metadata. `efforts: undefined` models the real
 * case daruma hit in production: a route whose models advertise no reasoning
 * capability at all.
 */
function lookupReturning(efforts: readonly string[] | undefined): ReasoningCapabilityLookup {
  const info = {
    provider: 'mt',
    id: 'glm-5.2',
    name: 'GLM 5.2',
    ...(efforts === undefined
      ? {}
      : { reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } }),
  } as LlmResolvedModelInfo
  return { resolveModelInfo: async () => info }
}

describe('mapping', () => {
  it('maps known DSH codes to the domain taxonomy', () => {
    expect(toFailureCode('RATE_LIMIT')).toBe('RATE_LIMIT')
    expect(toFailureCode('SERVER')).toBe('SERVER')
    expect(toFailureCode('QUOTA')).toBe('QUOTA')
    // A provider refusing one request's shape must stay distinguishable from an
    // unknown failure: it routes by conversation, not by channel health.
    expect(toFailureCode('INVALID_REQUEST')).toBe('INVALID_REQUEST')
    // A channel whose provider has no adapter is a dead channel, not a hiccup.
    expect(toFailureCode('NO_ADAPTER')).toBe('NO_ADAPTER')
  })

  it('downgrades unknown codes to UNKNOWN', () => {
    expect(toFailureCode('NO_ADAPTERS_AT_ALL')).toBe('UNKNOWN')
    expect(toFailureCode('ABORTED')).toBe('UNKNOWN')
  })

  it('derives channel id from provider and model', () => {
    expect(channelIdOf('mt', 'deepseek-v4-pro')).toBe('mt::deepseek-v4-pro')
    expect(channelIdOf('mt', '')).toBe('mt')
  })

  it('builds a failure signal with status and message', () => {
    const signal = toFailureSignal(
      { code: 'RATE_LIMIT', status: 429, message: 'too fast' },
      channelId('mt::deepseek-v4-pro'),
      1234,
    )
    expect(signal).toEqual({
      code: 'RATE_LIMIT',
      status: 429,
      channel: 'mt::deepseek-v4-pro',
      occurredAtMs: 1234,
      message: 'too fast',
    })
  })

  it('marks the signal only when a retry budget was already spent', () => {
    const channel = channelId('mt::glm-5.3')
    // Absent, not `false`: a host with no retry owner keeps the old signal shape.
    expect('retryExhausted' in toFailureSignal({ code: 'RATE_LIMIT', message: 'slow down' }, channel, 1))
      .toBe(false)
    expect(toFailureSignal({ code: 'RATE_LIMIT', message: 'slow down' }, channel, 1, true))
      .toMatchObject({ retryExhausted: true })
  })

  describe('isRetryExhausted', () => {
    const normal: ResolvedRetryPolicy = {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
    const always: ResolvedRetryPolicy = {
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }

    it('reads arrival with a retryable code as a spent budget', () => {
      // The 2026-09-17 production shape: five same-channel RATE_LIMIT retries,
      // and only the last one is ever handed to daruma.
      expect(isRetryExhausted('RATE_LIMIT', normal)).toBe(true)
    })

    it('does not read a code the policy would never retry', () => {
      expect(isRetryExhausted('QUOTA', normal)).toBe(false)
    })

    it('does not read `always` mode as exhaustion', () => {
      // `always` mode consults its downstream listeners before deciding to
      // retry, so arrival there carries no information about the budget.
      expect(isRetryExhausted('RATE_LIMIT', always)).toBe(false)
    })

    it('does not read a failure no retry policy owned', () => {
      expect(isRetryExhausted('RATE_LIMIT', undefined)).toBe(false)
    })
  })

  describe('toFailoverOptions', () => {
    const base: GenerateOptions = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 4096,
      messages: [],
    }

    it('keeps an effort the target advertises, preserving every other field', async () => {
      const { options, effort } = await toFailoverOptions(base, TARGET, lookupReturning(['off', 'low', 'high']))

      expect(options).toEqual({ ...base, provider: 'mt', model: 'glm-5.2' })
      expect(effort).toEqual({ kind: 'kept', effort: 'high' })
    })

    it('drops an effort the target does not advertise', async () => {
      const { options, effort } = await toFailoverOptions(base, TARGET, lookupReturning(['off', 'low']))

      expect(options.provider).toBe('mt')
      expect(options.model).toBe('glm-5.2')
      expect(options.maxTokens).toBe(4096)
      expect('reasoningEffort' in options).toBe(false)
      expect(effort).toEqual({ kind: 'dropped-unsupported', effort: 'high', accepted: ['off', 'low'] })
    })

    it('drops an effort when the target advertises no reasoning capability at all', async () => {
      const { options, effort } = await toFailoverOptions(base, TARGET, lookupReturning(undefined))

      expect('reasoningEffort' in options).toBe(false)
      expect(effort).toEqual({ kind: 'dropped-unsupported', effort: 'high', accepted: [] })
    })

    it('drops an effort when the target capability cannot be resolved', async () => {
      const throwing: ReasoningCapabilityLookup = {
        resolveModelInfo: vi.fn().mockRejectedValue(new Error('NO_ADAPTER')),
      }
      const { options, effort } = await toFailoverOptions(base, TARGET, throwing)

      // Fail closed onto dispatch: an unverifiable target still gets a request
      // it can accept, rather than one validation rejects before I/O.
      expect('reasoningEffort' in options).toBe(false)
      expect(effort).toEqual({ kind: 'dropped-unverifiable', effort: 'high' })
    })

    it('drops an effort when no llm runtime is available', async () => {
      const { options, effort } = await toFailoverOptions(base, TARGET, undefined)

      expect('reasoningEffort' in options).toBe(false)
      expect(effort).toEqual({ kind: 'dropped-unverifiable', effort: 'high' })
    })

    it('never queries the runtime for a request that carries no effort', async () => {
      const withoutEffort: GenerateOptions = {
        provider: base.provider,
        model: base.model,
        maxTokens: base.maxTokens,
        messages: [],
      }
      const lookup: ReasoningCapabilityLookup = { resolveModelInfo: vi.fn() }
      const { options, effort } = await toFailoverOptions(withoutEffort, TARGET, lookup)

      expect(options).toEqual({ ...withoutEffort, provider: 'mt', model: 'glm-5.2' })
      expect(effort).toEqual({ kind: 'none-requested' })
      expect(lookup.resolveModelInfo).not.toHaveBeenCalled()
    })

    it('never mutates the caller request, which arrives deep-frozen', async () => {
      const frozen = Object.freeze({
        ...base,
        messages: Object.freeze([]) as unknown as GenerateOptions['messages'],
      }) as GenerateOptions
      const { options } = await toFailoverOptions(frozen, TARGET, lookupReturning(['off', 'low']))

      expect(options).not.toBe(frozen)
      expect(frozen.provider).toBe('deepseek-official')
      expect(frozen.reasoningEffort).toBe('high')
    })
  })
})
