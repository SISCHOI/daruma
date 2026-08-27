/**
 * daruma-core — pure domain layer for the Daruma resilience watchdog.
 *
 * This package imports nothing from Node, DSH, Codex, or Claude Code. It
 * exposes the domain model, the recovery decision engine, and the ports that
 * host adapters implement.
 */

export { FAILURE_CODES, isRetryableCode, isTerminalCode, isResumeCode } from './failure.ts'
export type { FailureCode } from './failure.ts'

export { channelId, modelId } from './channel.ts'
export type { Channel, ChannelId, ModelId } from './channel.ts'

export { DEFAULT_BACKOFF, backoffDelayMs } from './backoff.ts'
export type { BackoffPlan } from './backoff.ts'

export {
  beginProbe,
  canRouteNow,
  freshHealth,
  recordFailure,
  recordSuccess,
  shouldBeginProbe,
  trip,
} from './channel-health.ts'
export type { ChannelHealth, ChannelState } from './channel-health.ts'

export { DEFAULT_CONFIG } from './config.ts'
export type { RecoveryPolicyConfig } from './config.ts'

export { decide, pickFallback } from './recovery-policy.ts'
export type { DecideInput, RecoveryPlan, Verdict } from './recovery-policy.ts'

export type { Clock, ChannelHealthStore, HealthProbe, SignalSource } from './ports.ts'
export type { FailureSignal } from './signal.ts'
