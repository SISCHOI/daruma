/**
 * daruma-core — pure domain layer for the Daruma resilience plugin.
 *
 * This package imports nothing from Node or DSH. It exposes the domain model,
 * the recovery decision engine, and the ports that the host adapter
 * implements.
 */

export { FAILURE_CODES, isRetryableCode, isTerminalCode } from './failure.ts'
export type { FailureCode } from './failure.ts'

export { channelId, modelId } from './channel.ts'
export type { Channel, ChannelId, ModelId } from './channel.ts'

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

export type { Clock, ChannelHealthStore } from './ports.ts'
export type { FailureSignal } from './signal.ts'
