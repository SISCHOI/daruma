/**
 * dsh-daruma — Daruma resilience plugin for DeepSeek Harness.
 *
 * Mounts the recovery engine on the host's two model-request extension points:
 *
 * - `agent/request-error`: observe failures; when a channel trips, arm a
 *   failover target and own recovery by returning `{ kind: 'retry' }`.
 * - `llm/stream`: dispatch the retried attempt on the armed target — the
 *   routing waterfall around every streaming model call.
 *
 * Failover used to run on `agent/request` by replacing the request's provider
 * and model. DSH 0.2.1-alpha.4 fixed model selection at step preparation and
 * made that replacement an error (`agent/request proposed "…" after step
 * preparation fixed "…"`), so every switch killed the turn it meant to save.
 * `llm/stream` is the layer that still owns routing: the loop's selection stays
 * untouched, and only the executor changes. See
 * `docs/aegis/plans/2026-11-18-llm-stream-failover.md`.
 *
 * It is intentionally downstream of the in-box `dsh-llm-retry`: that plugin
 * owns same-channel retry and delegates here (via `next()`) when it gives up,
 * so daruma only escalates after retry has exhausted its budget.
 *
 * That position is also read as evidence: a failure retry already spent its
 * budget on arrives as `retryExhausted` and opens the circuit on the first one,
 * instead of waiting for `failureBudget` failing turns (see `isRetryExhausted`).
 *
 * Additionally mounts the `/dsh-daruma` RPC channel (status, candidate
 * discovery, backup selection) for the web client UI. Recovery decisions are
 * recorded only in the JSONL audit log: appending `daruma/*` session events
 * leaves an unmarked type the host does not know, and current harnesses then
 * refuse to load the whole session.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import * as llmPackage from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  channelIdOf,
  isRetryExhausted,
  toFailoverOptions,
  toFailureSignal,
  type EffortDisposition,
} from './mapping.ts'
import { resolveConfig, type PluginConfig } from './config.ts'
import { RecoveryEngine } from './engine.ts'
import { JsonFileChannelHealthStore } from './store.ts'
import { JsonlFailoverLogStore } from './failover-log.ts'
import type { DarumaFailoverEvent, DarumaGiveUpEvent } from './failover-events.ts'
import { mountStatus } from './status.ts'
import { mountRpc } from './rpc.ts'
import { modelId, type Channel, type ChannelId } from 'daruma-core'
import { mountWithWebTransport } from './host-mount.ts'

export const name = 'dsh-daruma'
export const inject = ['agents', 'settings', 'llm'] as const

export type { DarumaFailoverEvent, DarumaGiveUpEvent }

/**
 * The host marks the requests its own loop assembled (`markAgentLoopRequest`),
 * which is how a failover stays attached to an agent request instead of
 * hijacking a compaction or session-title call that happens to share the route.
 *
 * Read structurally and optionally: a host generation without the export keeps
 * working through the `sessionId` filter instead of failing to load.
 */
const isAgentLoopRequest = (llmPackage as {
  isAgentLoopRequest?: (request: GenerateOptions) => boolean
}).isAgentLoopRequest

/**
 * How long an armed target stays usable.
 *
 * The retry that consumes an arm happens within seconds of the failure. A
 * target left over from a turn that ended (give-up, user cancel) must not
 * redirect an unrelated later request on the same session.
 */
const ARMED_TTL_MS = 10 * 60_000

/** One armed failover target, waiting for the retried attempt to dispatch. */
interface ArmedFailover {
  readonly target: Channel
  /** The channel that failed, for the audit line and logs. */
  readonly from: ChannelId
  readonly armedAt: number
}

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
  const status = mountStatus(ctx.get('settings'), config.backupFile)
  ctx.logger.info(`dsh-daruma: backup channel stored via ${status.storageKind}`)

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

  // Per-agent channel currently in use (tracked from the last dispatch, which
  // is the failover target after a switch).
  const currentChannel = new Map<string, ChannelId>()
  // Per-agent failover target armed by the previous failed attempt.
  const pending = new Map<string, ArmedFailover>()
  // Agents whose latest request-attempt failed and has not been followed by a
  // fresh dispatch yet. `agent/pre-step` infers "the last request succeeded"
  // only when the agent is absent here (see onSuccess wiring below).
  const failedSinceRequest = new Set<string>()
  // Requests this plugin re-dispatched itself: the second pass through the
  // waterfall must not arm a second redirect.
  const redirections = new WeakSet<object>()

  /** The user-chosen backup channel, if set and healthy. */
  const backupChannel = (): Channel | undefined => {
    const backup = status.getBackup()
    if (backup === undefined) return undefined
    return { id: channelIdOf(backup.provider, backup.model), provider: backup.provider, model: modelId(backup.model) }
  }

  /**
   * Dispatch one attempt on the armed target.
   *
   * The caller's request object is left untouched: the loop keeps its own
   * selection and request header, and only the adapter that executes it
   * changes. Content (messages, system prompt, tools) is copied verbatim.
   */
  const redirect = (options: GenerateOptions, armed: ArmedFailover): AsyncIterable<StreamChunk> => {
    return (async function* (): AsyncIterable<StreamChunk> {
      const { options: routed, effort } = await toFailoverOptions(options, armed.target, ctx.llm)
      ctx.logger.warn(
        `dsh-daruma: switching ${options.provider}/${options.model} -> ${routed.provider}/${routed.model}`,
      )
      logEffortDisposition(ctx, armed.target, effort)
      // Marked before dispatch: `ctx.llm.stream()` runs this waterfall again.
      redirections.add(routed)
      yield* ctx.llm.stream(routed)
    })()
  }

  ctx.on('llm/stream', (options, next) => {
    if (redirections.has(options)) return next()
    if (isAgentLoopRequest !== undefined && !isAgentLoopRequest(options)) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined) return next()

    // One dispatched attempt supersedes any recorded failure attribution.
    failedSinceRequest.delete(sessionId)

    const route = channelIdOf(options.provider, options.model)
    const armed = pending.get(sessionId)
    const usable = armed !== undefined
      && Date.now() - armed.armedAt <= ARMED_TTL_MS
      && armed.target.id !== route

    if (!usable) {
      // Either nothing is armed or it can no longer apply; dropping it here is
      // what keeps a stale target from redirecting a later, unrelated request.
      pending.delete(sessionId)
      currentChannel.set(sessionId, route)
      return next()
    }

    // One-shot: the armed target owns this attempt.
    pending.delete(sessionId)
    currentChannel.set(sessionId, armed.target.id)
    return redirect(options, armed)
  })

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    failedSinceRequest.add(payload.agent.id)
    const channel = currentChannel.get(payload.agent.id) ?? channelIdOf(payload.provider, '')
    // Reaching this listener already means the in-box retry declined the code;
    // for a code its own policy calls retryable, that is a spent budget rather
    // than a single attempt.
    const signal = toFailureSignal(
      payload.failure,
      channel,
      Date.now(),
      isRetryExhausted(payload.failure.code, payload.retryPolicy),
    )
    const plan = engine.onFailure(signal, backupChannel(), payload.agent.id)

    if (plan.verdict.kind === 'FAILOVER') {
      const armedAt = Date.now()
      pending.set(payload.agent.id, { target: plan.verdict.target, from: channel, armedAt })
      failoverLog.append({
        kind: 'failover',
        t: armedAt,
        agentId: payload.agent.id,
        from: channel,
        to: plan.verdict.target.id,
        reason: signal.code,
        status: payload.failure.status,
        // Audit trail for *why now*: an escalated switch is not a counted one.
        ...(signal.retryExhausted === true ? { retryExhausted: true } : {}),
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
      const reason = plan.verdict.reason === 'no-routable-fallback' ? 'no-routable-fallback' : 'give-up-budget-exhausted'
      failoverLog.append({
        kind: 'give-up',
        t: Date.now(),
        agentId: payload.agent.id,
        from: channel,
        reason,
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
  // dispatch, so it earns a success record — unless a failure is still
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
      getSettings: () => ctx.get('settings'),
    })
  })
}
