/**
 * Model probing: send minimal requests to each candidate model and measure
 * availability and latency. Used by the "test backup channels" UI.
 *
 * Each model is probed several times (default 3) and marked ok only when at
 * least half of the attempts succeed, so a single network blip cannot decide
 * availability.
 *
 * This makes real provider calls — callers should confirm with the user and
 * keep the candidate list small.
 */

import { randomUUID } from 'node:crypto'
import type { LlmRuntime, Message, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface Candidate {
  readonly provider: string
  readonly model: string
}

export interface ProbeResult extends Candidate {
  readonly ok: boolean
  /** Average latency of successful attempts (0 when all failed). */
  readonly latencyMs: number
  /** Successful attempts out of `attempts`. */
  readonly successCount: number
  readonly attempts: number
  readonly error?: string
}

export interface ProbeOptions {
  readonly timeoutMs?: number
  readonly maxTokens?: number
  /** Probe attempts per model; default 3. */
  readonly attempts?: number
  /** Minimum successful attempts to mark ok; default ceil(attempts/2). */
  readonly minSuccess?: number
  /** Concurrent probes; sequential when 1. Default 5. */
  readonly concurrency?: number
}

export interface ProbeProgress {
  readonly done: number
  readonly total: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function probeMessage(): Message {
  return {
    id: randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text: 'Reply with exactly: OK' }],
    source: { kind: 'user' },
  }
}

/** One single-attempt probe with a hard timeout race. */
async function probeOnce(
  llm: LlmRuntime,
  candidate: Candidate,
  options: ProbeOptions,
  signal?: AbortSignal,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  const maxTokens = options.maxTokens ?? 16
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const fused = signal !== undefined ? AbortSignal.any([signal, controller.signal]) : controller.signal

  let timer: ReturnType<typeof setTimeout> | undefined
  // Hard timeout via race: some adapter streams ignore the abort signal and
  // would otherwise hang `for await` forever (and stall the whole probe).
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  const collect = (async (): Promise<string> => {
    await llm.prepareCall({ provider: candidate.provider, model: candidate.model, maxTokens }, fused)
    let text = ''
    for await (const chunk of llm.stream({
      provider: candidate.provider,
      model: candidate.model,
      maxTokens,
      messages: [probeMessage()],
      signal: fused,
    })) {
      if (chunk.type === 'text-delta') text += (chunk as StreamChunk & { text?: string }).text ?? ''
    }
    return text
  })()

  try {
    const text = await Promise.race([collect, timeout])
    return { ok: text.trim().length > 0, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: messageOf(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Probe one candidate `attempts` times; ok when at least `minSuccess` pass. */
async function probeOne(
  llm: LlmRuntime,
  candidate: Candidate,
  options: ProbeOptions,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const attempts = options.attempts ?? 3
  const minSuccess = options.minSuccess ?? Math.ceil(attempts / 2)
  let successCount = 0
  let latencySum = 0
  let lastError: string | undefined
  for (let i = 0; i < attempts; i++) {
    const attempt = await probeOnce(llm, candidate, options, signal)
    if (attempt.ok) {
      successCount++
      latencySum += attempt.latencyMs
    } else {
      lastError = attempt.error
    }
    if (signal?.aborted) break
  }
  return {
    ...candidate,
    ok: successCount >= minSuccess,
    latencyMs: successCount > 0 ? Math.round(latencySum / successCount) : 0,
    successCount,
    attempts,
    ...(lastError !== undefined && successCount === 0 ? { error: lastError } : {}),
  }
}

/**
 * Probe candidates with bounded concurrency (default 5) and per-model hard
 * timeouts. Progress fires after each model settles, in completion order.
 */
export async function probeCandidates(
  llm: LlmRuntime,
  candidates: readonly Candidate[],
  options: ProbeOptions = {},
  signal?: AbortSignal,
  onProgress?: (progress: ProbeProgress) => void,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(candidates.length)
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, candidates.length))
  let next = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      const candidate = candidates[index]
      if (candidate === undefined) return
      results[index] = await probeOne(llm, candidate, options, signal)
      done++
      onProgress?.({ done, total: candidates.length })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}
