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
 *
 * Additionally mounts the `/dsh-daruma` RPC channel (status, candidate
 * discovery, backup selection) for the web client UI, and appends a durable
 * `daruma/failover` session event on every channel switch.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { channelIdOf, channelIdOfConfig, toCallConfig, toFailureSignal } from './mapping.ts'
import { resolveConfig, type PluginConfig } from './config.ts'
import { RecoveryEngine } from './engine.ts'
import { JsonFileChannelHealthStore } from './store.ts'
import { JsonlFailoverLogStore } from './failover-log.ts'
import { buildDarumaFailoverEvent, type DarumaFailoverEvent } from './failover-events.ts'
import { mountStatus } from './status.ts'
import { mountRpc } from './rpc.ts'
import { modelId, type Channel, type ChannelId } from 'daruma-core'

export const name = 'dsh-daruma'
export const inject = ['agents', 'settings', 'llm'] as const

export type { DarumaFailoverEvent }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'daruma/failover': DarumaFailoverEvent
  }
}

export function apply(ctx: Context, rawConfig: PluginConfig = {}): void {
  const config = resolveConfig(rawConfig)
  const store = new JsonFileChannelHealthStore(config.stateFile)
  const engine = new RecoveryEngine(config, store)
  const failoverLog = new JsonlFailoverLogStore(config.logFile)
  const status = mountStatus(ctx)

  // Boot record: one line per plugin start, so audits can align restart
  // boundaries with the failover/give-up lines that follow.
  failoverLog.append({
    kind: 'boot',
    t: Date.now(),
    pid: process.pid,
    channels: config.channels.map((channel) => channel.id),
    failureBudget: config.failureBudget,
    cooldownMs: config.cooldownMs,
    giveUpBudget: config.giveUpBudget,
  })

  // Per-agent channel currently in use (tracked from the last request).
  const currentChannel = new Map<string, ChannelId>()
  // Per-agent failover target armed on the previous failed request.
  const pending = new Map<string, Channel>()
  // Agents whose latest request-attempt failed and has not been followed by a
  // fresh request yet. `agent/pre-step` infers "the last request succeeded"
  // only when the agent is absent here (see onSuccess wiring below).
  const failedSinceRequest = new Set<string>()

  /** The user-chosen backup channel, if set and healthy. */
  const backupChannel = (): Channel | undefined => {
    const backup = status.getBackup()
    if (backup === undefined) return undefined
    return { id: channelIdOf(backup.provider, backup.model), provider: backup.provider, model: modelId(backup.model) }
  }

  ctx.on('agent/request', async (payload, next) => {
    // A new request attempt supersedes any recorded failure attribution.
    failedSinceRequest.delete(payload.agent.id)
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
    failedSinceRequest.add(payload.agent.id)
    const channel = currentChannel.get(payload.agent.id) ?? channelIdOf(payload.provider, '')
    const signal = toFailureSignal(payload.failure, channel, Date.now())
    const plan = engine.onFailure(signal, backupChannel(), payload.agent.id)

    if (plan.verdict.kind === 'FAILOVER') {
      pending.set(payload.agent.id, plan.verdict.target)
      const event = buildDarumaFailoverEvent({
        from: channel,
        to: plan.verdict.target.id,
        reason: signal.code,
        at: Date.now(),
        agentId: payload.agent.id,
        turn: payload.turn,
        step: payload.step,
        failure: payload.failure,
        failoverCount: plan.failoverCount,
        giveUpBudget: engine.giveUpBudget,
      })
      payload.agent.session.append('daruma/failover', event)
      failoverLog.append({
        kind: 'failover',
        t: event.at,
        agentId: payload.agent.id,
        from: channel,
        to: plan.verdict.target.id,
        reason: signal.code,
        status: payload.failure.status,
        turn: payload.turn,
        step: payload.step,
        failoverCount: plan.failoverCount,
        giveUpBudget: engine.giveUpBudget,
      })
      ctx.logger.warn(
        `dsh-daruma: failover ${channel} -> ${plan.verdict.target.id} (${signal.code}) agent=${payload.agent.id} turn=${payload.turn} step=${payload.step}`,
      )
      return { kind: 'retry' }
    }

    if (plan.verdict.kind === 'GIVE_UP') {
      failoverLog.append({
        kind: 'give-up',
        t: Date.now(),
        agentId: payload.agent.id,
        from: channel,
        reason: plan.verdict.reason,
        status: payload.failure.status,
        turn: payload.turn,
        step: payload.step,
        failoverCount: plan.failoverCount,
        giveUpBudget: engine.giveUpBudget,
      })
      ctx.logger.error(`dsh-daruma: giving up (${plan.verdict.reason})`)
    }

    // RETRY_NOW / GIVE_UP: delegate downstream (retry may still own it).
    return next()
  })

  // The host exposes no request-success event. The next `agent/pre-step`
  // firing for an agent proves its previous model request (the one
  // `currentChannel` still points at) completed without tripping
  // `agent/request-error` — so that channel earns a success record and its
  // failure counter/cooldown reset. Never blocks the host loop: any error
  // inside is logged and swallowed, and the waterfall always calls through.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const channel = currentChannel.get(payload.agent.id)
      if (channel !== undefined && !failedSinceRequest.has(payload.agent.id)) {
        engine.onSuccess(channel)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-daruma: success recording failed: ${String(error)}`)
    }
    return next()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    currentChannel.delete(agent.id)
    pending.delete(agent.id)
    failedSinceRequest.delete(agent.id)
    engine.clearScope(agent.id)
  })

  mountRpc(ctx, { engine, currentChannel, status, getLlm: () => ctx.llm, getSettings: () => ctx.settings })
}
