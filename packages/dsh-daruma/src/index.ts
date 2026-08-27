/**
 * dsh-daruma — Daruma resilience plugin for DeepSeek Harness.
 *
 * Mounts the recovery-policy engine on the agent loop's model-request
 * extension points. (Domain logic lands in Phase 2.)
 */
export const name = 'dsh-daruma'
export const inject: string[] = []

export function apply(): void {
  // Phase 2: register `agent/request-error` and `agent/request` listeners.
}
