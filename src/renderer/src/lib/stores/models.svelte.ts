import type { ProviderModels } from '@shared/types/provider'

/** Shown until main reports the lists: the Claude aliases, so the pickers are never empty. */
const FALLBACK: ProviderModels = {
  claude: [
    { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
    {
      ref: { provider: 'claude', model: 'sonnet' },
      label: 'Sonnet',
      tier: 'balanced',
      isDefault: true
    },
    { ref: { provider: 'claude', model: 'haiku' }, label: 'Haiku', tier: 'fast', isDefault: false }
  ],
  codex: [],
  cursor: []
}

/** The models each provider offers. Pull-based: call `load()` again after `providers:changed`. */
class ModelsStore {
  lists = $state<ProviderModels>(FALLBACK)

  async load(): Promise<void> {
    const result = await window.harness.invoke('providers:models', {})
    if (result.ok && Array.isArray(result.data?.claude) && Array.isArray(result.data?.codex)) {
      // A main process that predates a provider sends no key for it: that provider offers nothing.
      this.lists = { ...result.data, cursor: result.data.cursor ?? [] }
    }
  }

  reset(): void {
    this.lists = FALLBACK
  }
}

export const models = new ModelsStore()
