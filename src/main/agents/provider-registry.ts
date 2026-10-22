import type { ProviderId } from '../../shared/types/provider'
import type { AgentAdapter } from './agent-adapter'
import { bridgeToolNamer, type BridgeToolNamer } from './tool-namer'

/** Selects the adapter and the tool names for a provider. The Orchestrator and WorkerManager start agents through it. */
export interface ProviderRegistry {
  adapter(provider: ProviderId): AgentAdapter
  toolNamer(provider: ProviderId): BridgeToolNamer
}

/** Thrown when an adapter for the provider is not wired yet. */
export class ProviderNotAvailableError extends Error {
  constructor(readonly provider: ProviderId) {
    super(`The ${provider} adapter is not available yet.`)
    this.name = 'ProviderNotAvailableError'
  }
}

/** A registry over the adapters that exist. Asking for any other provider throws. */
export class AdapterRegistry implements ProviderRegistry {
  constructor(private readonly adapters: Partial<Record<ProviderId, AgentAdapter>>) {}

  adapter(provider: ProviderId): AgentAdapter {
    const adapter = this.adapters[provider]
    if (!adapter) throw new ProviderNotAvailableError(provider)
    return adapter
  }

  toolNamer(provider: ProviderId): BridgeToolNamer {
    return bridgeToolNamer(provider)
  }
}
