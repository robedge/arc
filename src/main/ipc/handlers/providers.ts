import { PROVIDER_IDS } from '@shared/types/provider'
import type { AppServices } from '../../app/app-services'
import { emit, handle } from '../register'

type ProviderServices = Pick<
  AppServices,
  'providerStatus' | 'providerChecks' | 'models' | 'bypassDetector'
>

export function registerProviderHandlers(services: ProviderServices): void {
  const { providerStatus, providerChecks, models, bypassDetector } = services
  handle('providers:get', () => providerStatus.get())
  handle('providers:check', async ({ provider }) => {
    if (provider === undefined) {
      await providerChecks.runFullCheck({ forceLatest: true })
      return providerStatus.get()
    }
    const map = await providerStatus.check(provider, { forceLatest: true })
    // Check again also reloads the Codex models (the account may have changed). Not awaited: the next
    // `providers:models` call waits for the same refresh.
    if (provider !== 'claude') {
      void models.refresh({ force: true }).then((changed) => {
        if (changed) emit('providers:changed', providerStatus.get())
        if (provider === 'cursor') providerChecks.refreshCursorCommands()
      })
      if (provider === 'codex') providerChecks.refreshCodexCommands()
    }
    return map
  })
  handle('providers:dismiss-update', ({ provider, version }) => {
    providerStatus.dismissUpdate(provider, version)
    return providerStatus.get()
  })
  handle('providers:models', async () => {
    // Before the first check has finished there is no provider status, and no probed list: wait for
    // that check (it shares the one already running) instead of answering with a missing list.
    for (const provider of PROVIDER_IDS) {
      if (!providerStatus.getStatus(provider))
        await providerStatus.ensureFresh(provider).catch(() => undefined)
    }
    await models.refresh()
    return models.all()
  })
  handle('providers:bypass', () => bypassDetector.detect([]))
}
