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
import { channelIdOf, channelIdOfConfig, toFailoverConfig, toFailureSignal, type EffortDisposition } from './mapping.ts'
import { resolveConfig, type PluginConfig } from './config.ts'
import { RecoveryEngine } from './engine.ts'
import { JsonFileChannelHealthStore } from './store.ts'
import { JsonlFailoverLogStore } from './failover-log.ts'
import { buildDarumaFailoverEvent, buildDarumaGiveUpEvent, type DarumaFailoverEvent, type DarumaGiveUpEvent } from './failover-events.ts'
import { mountStatus } from './status.ts'
import { mountRpc } from './rpc.ts'
import { modelId, type Channel, type ChannelId } from 'daruma-core'
import { createEventSink } from './event-sink.ts'
import { mountWithWebTransport } from './host-mount.ts'

export const name = 'dsh-daruma'
export const inject = ['agents', 'settings', 'llm'] as const

export type { DarumaFailoverEvent, DarumaGiveUpEvent }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'daruma/failover': DarumaFailoverEvent
    'daruma/give-up': DarumaGiveUpEvent
  }
}

/**
 * Record what the failover target did with the caller's reasoning effort.
 *
 * A dropped effort is a real change to the request (the target runs at its own
 * default level instead of the user's), so it has to be visible in the server
 * log rather than folded silently into the channel-switch line. `none-requested`
 * and `kept` are the ordinary cases and stay quiet.
 */
function logEffortDisposition(ctx: Context, target: Channel, effort: EffortDisposition): void {
  switch (effort.kind) {
    case 'none-requested':
    case 'kept':
      return
    case 'dropped-unsupported':
      ctx.logger.warn(
        `dsh-daruma: ${target.id} does not accept reasoning effort "${effort.effort}" `
        + `(advertised: ${effort.accepted.length > 0 ? effort.accepted.join(', ') : 'none'}); `
        + 'dropping it for the failover request so it can dispatch',
      )
      return
    case 'dropped-unverifiable':
      ctx.logger.warn(
        `dsh-daruma: could not resolve reasoning efforts for ${target.id}; `
        + `dropping "${effort.effort}" so the failover request can dispatch`,
      )
  }
}

export function apply(ctx: Context, rawConfig: PluginConfig = {}): void {
  const config = resolveConfig(rawConfig)
  const store = new JsonFileChannelHealthStore(config.stateFile)
  const engine = new RecoveryEngine(config, store)
  const failoverLog = new JsonlFailoverLogStore(config.logFile)
  const status = mountStatus(ctx)
  const eventSink = createEventSink(ctx.logger)

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
      const { config: swapped, effort } = await toFailoverConfig(current, armed, ctx.llm)
      currentChannel.set(payload.agent.id, channelIdOfConfig(swapped))
      ctx.logger.warn(
        `dsh-daruma: switching ${current.provider}/${current.model} -> ${swapped.provider}/${swapped.model}`,
      )
      logEffortDisposition(ctx, armed, effort)
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
      eventSink.append(payload.agent, { type: 'daruma/failover', value: event })
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
      const giveUpEvent = buildDarumaGiveUpEvent({
        from: channel,
        reason: plan.verdict.reason === 'no-routable-fallback' ? 'no-routable-fallback' : 'give-up-budget-exhausted',
        at: Date.now(),
        agentId: payload.agent.id,
        turn: payload.turn,
        step: payload.step,
        failoverCount: plan.failoverCount,
        giveUpBudget: engine.giveUpBudget,
      })
      eventSink.append(payload.agent, { type: 'daruma/give-up', value: giveUpEvent })
      failoverLog.append({
        kind: 'give-up',
        t: giveUpEvent.at,
        agentId: payload.agent.id,
        from: channel,
        reason: giveUpEvent.reason,
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

  // The host exposes no request-success event. Two adjacent host events prove
  // "the previous model request completed without erroring":
  //   1. `agent/pre-step` — the loop proposes the next step;
  //   2. `agent/turn-stopping` — the turn is about to close.
  // At either point, `currentChannel` still names the channel of the last
  // request, so it earns a success record — unless a failure is still
  // un-attributed (`failedSinceRequest`), which gates the false-positive
  // where the turn died on an error and never sent another request.
  // The turn-stopping arm is what makes single-step tasks (headless one-shot
  // prompts) reset health: their only pre-step fires before any request.
  // Never blocks the host loop: errors are logged and swallowed; the
  // pre-step waterfall always calls through.
  const recordInferredSuccess = (agentId: string): void => {
    const channel = currentChannel.get(agentId)
    if (channel !== undefined && !failedSinceRequest.has(agentId)) {
      engine.onSuccess(channel)
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      recordInferredSuccess(payload.agent.id)
    } catch (error) {
      ctx.logger.warn(`dsh-daruma: success recording failed: ${String(error)}`)
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      recordInferredSuccess(agent.id)
    } catch (error) {
      ctx.logger.warn(`dsh-daruma: success recording failed: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    currentChannel.delete(agent.id)
    pending.delete(agent.id)
    failedSinceRequest.delete(agent.id)
    engine.clearScope(agent.id)
  })

  // The web transport arrives when the host provides it — on some host
  // generations only after an async setup step — so the RPC channel mounts
  // from an injection callback instead of a synchronous service read.
  mountWithWebTransport(ctx, (transportCtx) => {
    mountRpc(transportCtx, {
      engine,
      currentChannel,
      status,
      getLlm: () => ctx.llm,
      getSettings: () => ctx.settings,
    })
  })
}
