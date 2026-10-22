import type { AppSettings } from '@shared/types/provider'
import { messageFor } from '../ipc/messages'

/** The defaults new sessions copy, with the main process as the source of truth. */
class SettingsStore {
  /** Null until `settings:get` answers. */
  values = $state<AppSettings | null>(null)
  error = $state<string | null>(null)

  apply(next: AppSettings): void {
    this.values = next
  }

  async load(): Promise<void> {
    const result = await window.harness.invoke('settings:get', {})
    if (result.ok) this.values = result.data
  }

  /** Saves a subset of keys; the answer (and `settings:changed`) replaces the values. */
  async save(patch: Partial<AppSettings>): Promise<void> {
    this.error = null
    const result = await window.harness.invoke('settings:set', patch)
    if (result.ok) this.values = result.data
    else this.error = messageFor(result.error)
  }

  reset(): void {
    this.values = null
    this.error = null
  }
}

export const settings = new SettingsStore()
