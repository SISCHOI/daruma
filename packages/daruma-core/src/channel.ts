/**
 * Branded identifiers and channel shape for Daruma.
 *
 * `ChannelId` and `ModelId` are nominal string types (phantom brand) so a
 * provider name and a model name cannot be silently swapped. Adapters cast
 * once at the boundary; the domain never casts.
 */

declare const channelBrand: unique symbol
declare const modelBrand: unique symbol

export type ChannelId = string & { readonly [channelBrand]: 'ChannelId' }
export type ModelId = string & { readonly [modelBrand]: 'ModelId' }

/** One concrete failover target: a provider route plus a model on it. */
export interface Channel {
  readonly id: ChannelId
  /** Provider route name (a DSH provider route). */
  readonly provider: string
  readonly model: ModelId
}

export function channelId(value: string): ChannelId {
  return value as ChannelId
}

export function modelId(value: string): ModelId {
  return value as ModelId
}
