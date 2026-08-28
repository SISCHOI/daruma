import { describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { probeCandidates } from './probe.ts'

function mockLlm(behavior: { ok: boolean; error?: string }): LlmRuntime {
  const prepareCall = vi.fn().mockResolvedValue({})
  const stream = vi.fn().mockImplementation(async function* () {
    if (!behavior.ok) throw new Error(behavior.error ?? 'probe failed')
    yield { type: 'text-delta', text: 'OK' }
  })
  return { prepareCall, stream } as unknown as LlmRuntime
}

describe('probeCandidates', () => {
  it('reports a working model as ok with a latency', async () => {
    const llm = mockLlm({ ok: true })
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'good' }], { timeoutMs: 5000 })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ provider: 'mock', model: 'good', ok: true })
    expect(results[0]?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a failing model with its error message', async () => {
    const llm = mockLlm({ ok: false, error: 'RATE_LIMIT: 429' })
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'bad' }], { timeoutMs: 5000 })
    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]?.error).toContain('RATE_LIMIT')
  })

  it('probes candidates sequentially in order', async () => {
    const llm = mockLlm({ ok: true })
    const candidates = [
      { provider: 'mock', model: 'a' },
      { provider: 'mock', model: 'b' },
      { provider: 'mock', model: 'c' },
    ]
    const results = await probeCandidates(llm, candidates, { timeoutMs: 5000 })
    expect(results.map((r) => r.model)).toEqual(['a', 'b', 'c'])
    expect(llm.prepareCall).toHaveBeenCalledTimes(3)
  })

  it('treats an empty stream as a failure (degenerate completion)', async () => {
    const prepareCall = vi.fn().mockResolvedValue({})
    const stream = vi.fn().mockImplementation(async function* () {
      // yields nothing
    })
    const llm = { prepareCall, stream } as unknown as LlmRuntime
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'empty' }], { timeoutMs: 5000 })
    expect(results[0]).toMatchObject({ ok: false })
  })
})
