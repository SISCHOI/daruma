/**
 * Translation between DeepSeek Harness types and the daruma-core domain.
 *
 * DSH failure `code`s are stable provider-neutral strings; the domain
 * taxonomy mirrors them and adds the watchdog codes. Anything unknown is
 * downgraded to `UNKNOWN` (treated as retryable).
 */

import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  channelId,
  type Channel,
  type ChannelId,
  type FailureCode,
  type FailureSignal,
} from 'daruma-core'

const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_CREDENTIAL',
  'PROCESS_EXITED',
  'STALLED',
])

export function toFailureCode(code: string): FailureCode {
  return (KNOWN_FAILURE_CODES.has(code) ? code : 'UNKNOWN') as FailureCode
}

/** Stable channel identity from a provider+model pair. */
export function channelIdOf(provider: string, model: string): ChannelId {
  return channelId(model ? `${provider}::${model}` : provider)
}

/** Channel identity of a resolved request config. */
export function channelIdOfConfig(config: LlmCallConfig): ChannelId {
  return channelIdOf(config.provider, config.model)
}

export function toFailureSignal(
  failure: LlmFailure,
  channel: ChannelId,
  occurredAtMs: number,
): FailureSignal {
  return {
    code: toFailureCode(failure.code),
    status: failure.status,
    channel,
    occurredAtMs,
    message: failure.message,
  }
}

/** Swap a request config onto a failover target channel. */
export function toCallConfig(config: LlmCallConfig, target: Channel): LlmCallConfig {
  return { ...config, provider: target.provider, model: target.model }
}
