import { isProviderId, modelLabel, providerName } from '@shared/provider-label'

/** A provider's name ("Claude", "Codex", "Cursor"); anything else ("Mixed") as it is. */
export function providerText(provider: string): string {
  return isProviderId(provider) ? providerName(provider) : provider
}

/** "Claude · Sonnet"; "Mixed" when more than one contributed. */
export function providerModelText(provider: string, model: string): string {
  if (isProviderId(provider)) return modelLabel({ provider, model })
  return model === provider ? provider : `${provider} · ${model}`
}
