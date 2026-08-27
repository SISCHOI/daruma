/**
 * dsh-daruma — Daruma resilience plugin for DeepSeek Harness.
 *
 * Mounts the recovery engine on the agent loop's two model-request extension
 * points:
 *
 * - `agent/request-error`: observe failures; when a channel trips, arm a
 *   failover target and own recovery by returning `{ kind: 'retry' }`.
 * - `agent/request`: swap the request config onto the armed target.
 *
 * It is intentionally downstream of the in-box `dsh-llm-retry`: that plugin
 * owns same-channel retry and delegates here (via `next()`) when it gives up,
 * so daruma only escalates after retry has exhausted its budget.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { channelIdOf, channelIdOfConfig, toCallConfig, toFailureSignal } from './mapping.ts'
import { resolveConfig, type PluginConfig } from './config.ts'
import { RecoveryEngine } from './engine.ts'
import { JsonFileChannelHealthStore } from './store.ts'
import type { Channel, ChannelId } from 'daruma-core'

export const name = 'dsh-daruma'
export const inject = ['agents'] as const

export function apply(ctx: Context, rawConfig: PluginConfig = {}): void {
  const config = resolveConfig(rawConfig)
  const store = new JsonFileChannelHealthStore(config.stateFile)
  const engine = new RecoveryEngine(config, store)

  // Per-agent channel currently in use (tracked from the last request).
  const currentChannel = new Map<string, ChannelId>()
  // Per-agent failover target armed on the previous failed request.
  const pending = new Map<string, Channel>()

  ctx.on('agent/request', async (payload, next) => {
    const current: LlmCallConfig = await next()
    const armed = pending.get(payload.agent.id)
    if (armed) {
      pending.delete(payload.agent.id)
      const swapped = toCallConfig(current, armed)
      currentChannel.set(payload.agent.id, channelIdOfConfig(swapped))
      ctx.logger.warn(
        `dsh-daruma: switching ${current.provider}/${current.model} -> ${swapped.provider}/${swapped.model}`,
      )
      return swapped
    }
    currentChannel.set(payload.agent.id, channelIdOfConfig(current))
    return current
  })

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const channel = currentChannel.get(payload.agent.id) ?? channelIdOf(payload.provider, '')
    const signal = toFailureSignal(payload.failure, channel, Date.now())
    const plan = engine.onFailure(signal)

    if (plan.verdict.kind === 'FAILOVER') {
      pending.set(payload.agent.id, plan.verdict.target)
      ctx.logger.warn(
        `dsh-daruma: failover ${channel} -> ${plan.verdict.target.id} (${signal.code})`,
      )
      return { kind: 'retry' }
    }

    if (plan.verdict.kind === 'GIVE_UP') {
      ctx.logger.error(`dsh-daruma: giving up (${plan.verdict.reason})`)
    }

    // RETRY_NOW / GIVE_UP: delegate downstream (retry may still own it).
    return next()
  })
}
