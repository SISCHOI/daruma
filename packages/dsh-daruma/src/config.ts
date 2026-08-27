/**
 * Plugin config parsing: cordis.patch.yml `config` → daruma-core config.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { modelId, type Channel, type RecoveryPolicyConfig } from 'daruma-core'
import { channelIdOf } from './mapping.ts'

export interface ChannelEntry {
  readonly provider: string
  readonly model: string
}

export interface PluginConfig {
  readonly channels?: readonly ChannelEntry[]
  readonly failureBudget?: number
  readonly cooldownMs?: number
  readonly giveUpBudget?: number
  readonly stateFile?: string
}

export interface ResolvedConfig extends RecoveryPolicyConfig {
  readonly stateFile: string
}

export function defaultStateFile(): string {
  return join(homedir(), '.dsh', 'daruma', 'channel-health.json')
}

export function resolveConfig(raw: PluginConfig = {}): ResolvedConfig {
  const channels: Channel[] = (raw.channels ?? []).map((entry) => ({
    id: channelIdOf(entry.provider, entry.model),
    provider: entry.provider,
    model: modelId(entry.model),
  }))

  return {
    channels,
    failureBudget: raw.failureBudget ?? 3,
    cooldownMs: raw.cooldownMs ?? 30_000,
    giveUpBudget: raw.giveUpBudget ?? 8,
    stateFile: raw.stateFile || defaultStateFile(),
  }
}
