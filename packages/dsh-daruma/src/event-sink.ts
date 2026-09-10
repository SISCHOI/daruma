import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DarumaFailoverEvent, DarumaGiveUpEvent } from './failover-events.ts'

export type DarumaEvent =
  | { type: 'daruma/failover'; value: DarumaFailoverEvent }
  | { type: 'daruma/give-up'; value: DarumaGiveUpEvent }

/** Host boundary for session events. Session failures never break recovery. */
export interface EventSink {
  append(agent: Agent, event: DarumaEvent): void
}

export function createEventSink(logger: { warn(message: string): void }): EventSink {
  return {
    append(agent, event) {
      try {
        agent.session.append(event.type, event.value)
      } catch (error) {
        logger.warn(`dsh-daruma: session event append unavailable: ${String(error)}`)
      }
    },
  }
}
