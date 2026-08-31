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
    expect(results[0]).toMatchObject({
      provider: 'mock',
      model: 'good',
      ok: true,
      successCount: 3,
      attempts: 3,
    })
    expect(results[0]?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a failing model with its error message', async () => {
    const llm = mockLlm({ ok: false, error: 'RATE_LIMIT: 429' })
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'bad' }], { timeoutMs: 5000 })
    expect(results[0]).toMatchObject({ ok: false, successCount: 0, attempts: 3 })
    expect(results[0]?.error).toContain('RATE_LIMIT')
  })

  it('marks ok only when half the attempts succeed', async () => {
    // First attempt succeeds, the rest fail → 1/3 < 2 → not ok.
    const prepareCall = vi.fn().mockResolvedValue({})
    let attempt = 0
    const stream = vi.fn().mockImplementation(async function* () {
      attempt++
      if (attempt === 1) {
        yield { type: 'text-delta', text: 'OK' }
        return
      }
      throw new Error('RATE_LIMIT: 429')
    })
    const llm = { prepareCall, stream } as unknown as LlmRuntime
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'flaky' }], { timeoutMs: 5000 })
    expect(results[0]).toMatchObject({ ok: false, successCount: 1, attempts: 3 })
  })

  it('probes candidates with concurrency', async () => {
    const llm = mockLlm({ ok: true })
    const candidates = [
      { provider: 'mock', model: 'a' },
      { provider: 'mock', model: 'b' },
      { provider: 'mock', model: 'c' },
    ]
    const results = await probeCandidates(llm, candidates, { timeoutMs: 5000 })
    expect(results.map((r) => r.model)).toEqual(['a', 'b', 'c'])
    // 3 candidates × 3 attempts each.
    expect(llm.prepareCall).toHaveBeenCalledTimes(9)
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

  it('settles a hung stream via the hard timeout race', async () => {
    // A stream that never yields and never rejects: `for await` would hang
    // forever without the race timeout.
    const prepareCall = vi.fn().mockResolvedValue({})
    // A real async generator that awaits forever on its first chunk:
    // `for await` hangs here until the hard timeout fires.
    const stream = vi.fn().mockImplementation(async function* () {
      yield await new Promise<never>(() => {})
    })
    const llm = { prepareCall, stream } as unknown as LlmRuntime
    const started = Date.now()
    const results = await probeCandidates(llm, [{ provider: 'mock', model: 'hang' }], { timeoutMs: 50 })
    const elapsed = Date.now() - started
    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]?.error).toContain('timeout')
    expect(elapsed).toBeLessThan(2000)
  })
})
