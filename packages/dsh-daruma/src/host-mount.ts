/**
 * Late-bound host surfaces.
 *
 * The web transport (`connection`, owned by the host's `dsh-client-connection`
 * plugin) is not guaranteed to exist when this plugin's `apply` runs. Through
 * `0.1.0-rc.x` the host provides the service synchronously during its own
 * apply; on `0.1.5-rc.1`/`0.1.5-rc.2` it awaits browser-auth setup first and
 * only then provides it. A synchronous `ctx.get('connection')` therefore
 * reports "absent" on the newer hosts, which used to disable the status panel
 * and the backup picker silently.
 *
 * Mounting from an injection callback works for both shapes: it runs as soon as
 * the service appears — including immediately on hosts that provide it eagerly
 * — and never runs where no web transport is composed (headless).
 *
 * Injecting `webServer` as well does NOT help on `0.1.5-rc.1`/`rc.2`: those
 * versions dropped `webServer` from the connection plugin's own inject list
 * while `rpc.handle()` still registers its route through the service context,
 * so every caller gets `cannot get property "webServer" without inject`. That
 * is an upstream regression in the host package, not a caller-side mistake —
 * verified by probe, see `docs/aegis/evidence/2026-09-11-latest-harness-compat.md`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { detectHostCapabilities, type HostCapabilities } from './host-capabilities.ts'

/** Host service carrying the browser transport. */
export const WEB_TRANSPORT_SERVICE = 'connection'

/** Structural host shape used by {@link mountWithWebTransport}. */
export interface HostMountHost {
  readonly logger: { info(message: string): void }
  inject(services: readonly string[], callback: (injected: Context) => void): unknown
}

/**
 * Run `mount` once the host provides the web transport, and record the host
 * capability snapshot observed at that moment (never from a pre-injection
 * read, which would misreport an eagerly-late host as unsupported).
 */
export function mountWithWebTransport(
  ctx: HostMountHost,
  mount: (transportCtx: Context) => void,
): void {
  ctx.inject([WEB_TRANSPORT_SERVICE], (transportCtx) => {
    const capabilities: HostCapabilities = detectHostCapabilities(transportCtx)
    ctx.logger.info(`dsh-daruma: host capabilities ${JSON.stringify(capabilities)}`)
    mount(transportCtx)
  })
}
