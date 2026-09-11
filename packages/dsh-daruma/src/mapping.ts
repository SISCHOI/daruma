/**
 * Translation between DeepSeek Harness types and the daruma-core domain.
 *
 * DSH failure `code`s are stable provider-neutral strings; the domain
 * taxonomy mirrors them. Anything unknown is downgraded to `UNKNOWN`
 * (treated as retryable).
 */

import type { LlmCallConfig, LlmFailure, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
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

/**
 * The one read daruma makes of the LLM runtime before it swaps channels: the
 * target's own model metadata. Structural, so a test can answer it without a
 * runtime.
 */
export interface ReasoningCapabilityLookup {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/**
 * What became of the caller's reasoning effort when a request moved to a
 * failover target.
 *
 * DSH validates an explicit `reasoningEffort` against the **target's** own
 * capability and refuses the request before any provider I/O
 * (`UNSUPPORTED_REASONING_EFFORT`, raised from `LlmRuntime.prepareCall`). That
 * refusal happens during the loop's request assembly, outside
 * `agent/request-error`, so no plugin gets to recover from it: the turn dies
 * and the failover channel never dispatches. Carrying the caller's level across
 * the swap therefore breaks the failover exactly where it was meant to help,
 * so an effort the target cannot take is dropped instead — the target then
 * applies its own configured default.
 */
export type EffortDisposition =
  | { readonly kind: 'none-requested' }
  | { readonly kind: 'kept'; readonly effort: string }
  | { readonly kind: 'dropped-unsupported'; readonly effort: string; readonly accepted: readonly string[] }
  | { readonly kind: 'dropped-unverifiable'; readonly effort: string }

export interface FailoverConfig {
  /** The config to dispatch on the failover target. */
  readonly config: LlmCallConfig
  /** What happened to the caller's effort, for the server log. */
  readonly effort: EffortDisposition
}

/** One target's advertised efforts, or the fact that they could not be read. */
type AdvertisedEfforts =
  | { readonly kind: 'read'; readonly efforts: readonly string[] }
  | { readonly kind: 'unreadable' }

/**
 * Read the reasoning efforts `target` advertises.
 *
 * An adapter that reports no reasoning metadata (or no adapter at all) is
 * indistinguishable here from a failed lookup — both mean "no effort this
 * target is known to accept".
 */
async function readEfforts(
  lookup: ReasoningCapabilityLookup | undefined,
  target: Channel,
): Promise<AdvertisedEfforts> {
  if (lookup === undefined) return { kind: 'unreadable' }
  try {
    const info = await lookup.resolveModelInfo(target.provider, target.model)
    return { kind: 'read', efforts: (info.reasoning?.efforts ?? []).map((effort) => effort.id) }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** Copy a config without its reasoning-effort field (the value is never kept). */
function withoutEffort(config: LlmCallConfig): LlmCallConfig {
  const next = { ...config }
  delete next.reasoningEffort
  return next
}

/**
 * Route a request config onto a failover target in a shape that target accepts.
 *
 * Everything except the reasoning effort is copied verbatim: `maxTokens`,
 * temperature and stop sequences are request-header state the caller owns, and
 * a failover must not silently re-shape the task. The effort is the one field
 * the *target* owns, so an unusable one is dropped rather than passed on.
 *
 * @param config - the caller's request config, as it stood on the failed channel.
 * @param target - the channel recovery chose.
 * @param lookup - model-metadata source (`LlmRuntime`); `undefined` when the
 *   runtime is unavailable, which fails closed onto "drop the effort".
 * @returns the routed config plus what happened to the effort, for logging.
 */
export async function toFailoverConfig(
  config: LlmCallConfig,
  target: Channel,
  lookup?: ReasoningCapabilityLookup,
): Promise<FailoverConfig> {
  const routed: LlmCallConfig = { ...config, provider: target.provider, model: target.model }
  const requested = config.reasoningEffort
  if (requested === undefined) return { config: routed, effort: { kind: 'none-requested' } }

  const advertised = await readEfforts(lookup, target)
  if (advertised.kind === 'unreadable') {
    return { config: withoutEffort(routed), effort: { kind: 'dropped-unverifiable', effort: requested } }
  }
  if (advertised.efforts.includes(requested)) {
    return { config: routed, effort: { kind: 'kept', effort: requested } }
  }
  return {
    config: withoutEffort(routed),
    effort: { kind: 'dropped-unsupported', effort: requested, accepted: advertised.efforts },
  }
}
