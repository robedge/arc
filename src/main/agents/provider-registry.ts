import type { ProviderId } from '../../shared/types/provider'
import type { AgentAdapter } from './agent-adapter'

/** Selects the adapter for a provider. The Orchestrator and WorkerManager start agents through it. */
export interface ProviderRegistry {
  adapter(provider: ProviderId): AgentAdapter
}

/**
 * The adapters the app wired. Asking for a provider without one is a wiring bug, not a fallback
 * case (that is `ProviderUnavailableError`), so it throws a plain `Error`. Tests wire only the
 * adapters they exercise.
 */
export class AdapterRegistry implements ProviderRegistry {
  constructor(private readonly adapters: Partial<Record<ProviderId, AgentAdapter>>) {}

  adapter(provider: ProviderId): AgentAdapter {
    const adapter = this.adapters[provider]
    if (!adapter) throw new Error(`No ${provider} adapter is wired.`)
    return adapter
  }
}
