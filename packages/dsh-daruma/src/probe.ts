/**
 * Model probing: send a minimal request to each candidate model and measure
 * availability and latency. Used by the "test backup channels" UI.
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
  readonly latencyMs: number
  readonly error?: string
}

export interface ProbeOptions {
  readonly timeoutMs?: number
  readonly maxTokens?: number
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

async function probeOne(
  llm: LlmRuntime,
  candidate: Candidate,
  options: ProbeOptions,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const started = Date.now()
  const maxTokens = options.maxTokens ?? 16
  const timeoutMs = options.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fused = signal !== undefined ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let text = ''
  try {
    await llm.prepareCall({ provider: candidate.provider, model: candidate.model, maxTokens }, fused)
    for await (const chunk of llm.stream({
      provider: candidate.provider,
      model: candidate.model,
      maxTokens,
      messages: [probeMessage()],
      signal: fused,
    })) {
      if (chunk.type === 'text-delta') text += (chunk as StreamChunk & { text?: string }).text ?? ''
    }
    return { ...candidate, ok: text.trim().length > 0, latencyMs: Date.now() - started }
  } catch (error) {
    return { ...candidate, ok: false, latencyMs: Date.now() - started, error: messageOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe candidates sequentially (providers throttle concurrent requests). */
export async function probeCandidates(
  llm: LlmRuntime,
  candidates: readonly Candidate[],
  options: ProbeOptions = {},
  signal?: AbortSignal,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const candidate of candidates) {
    results.push(await probeOne(llm, candidate, options, signal))
  }
  return results
}
