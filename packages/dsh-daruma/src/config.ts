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
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid config: expected an object')
  if (raw.channels !== undefined && !Array.isArray(raw.channels)) {
    throw new Error('invalid channels: expected an array')
  }
  const channels: Channel[] = (raw.channels ?? []).map((entry, index) => {
    if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string'
      || entry.provider.trim() === '' || entry.model.trim() === '') {
      throw new Error(`invalid channel at index ${index}: provider/model must be non-empty strings`)
    }
    if (entry.provider.length > 256 || entry.model.length > 256) {
      throw new Error(`invalid channel at index ${index}: provider/model too long`)
    }
    return {
      id: channelIdOf(entry.provider, entry.model),
      provider: entry.provider,
      model: modelId(entry.model),
    }
  })

  const ids = new Set(channels.map((channel) => channel.id))
  if (ids.size !== channels.length) throw new Error('invalid channels: duplicate provider/model pair')

  const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new Error(`invalid ${name}: expected a positive integer`)
    }
    return resolved
  }
  const failureBudget = positiveInteger(raw.failureBudget, 3, 'failureBudget')
  const cooldownMs = positiveInteger(raw.cooldownMs, 30_000, 'cooldownMs')
  const giveUpBudget = positiveInteger(raw.giveUpBudget, 8, 'giveUpBudget')
  if (raw.stateFile !== undefined && (typeof raw.stateFile !== 'string' || raw.stateFile.trim() === '')) {
    throw new Error('invalid stateFile: expected a non-empty string')
  }

  return {
    channels,
    failureBudget,
    cooldownMs,
    giveUpBudget,
    stateFile: raw.stateFile || defaultStateFile(),
  }
}
