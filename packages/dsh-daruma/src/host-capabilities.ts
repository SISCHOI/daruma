/** Runtime feature detection for DSH host API generations. */
export interface HostCapabilities {
  readonly conversationEvents: boolean
  readonly rpc: boolean
}

export function detectHostCapabilities(ctx: { get(service: string): unknown }): HostCapabilities {
  let connection: { rpc?: unknown } | undefined
  let conversationEvents: unknown
  try { connection = ctx.get('connection') as { rpc?: unknown } | undefined } catch { /* optional */ }
  try { conversationEvents = ctx.get('conversationEvents') } catch { /* optional */ }
  return {
    conversationEvents: conversationEvents !== undefined,
    rpc: connection?.rpc !== undefined,
  }
}
