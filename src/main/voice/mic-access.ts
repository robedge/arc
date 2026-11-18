import type { MicStatus } from '@shared/types/voice'

/** The one address `voice:open-mic-settings` ever opens. */
export const MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export interface MicAccessDeps {
  /** `systemPreferences.getMediaAccessStatus('microphone')`; 'unknown' is treated as not decided. */
  getStatus: () => string
  /** `systemPreferences.askForMediaAccess('microphone')`: shows the macOS prompt. */
  ask: () => Promise<boolean>
  openExternal: (url: string) => Promise<void>
  env: Readonly<Record<string, string | undefined>>
  /** E2E only: the URLs that would have been opened. */
  target?: { __e2e?: { getMicSettingsOpens?: () => number } }
}

const STATUSES: readonly MicStatus[] = ['granted', 'denied', 'restricted', 'not-determined']

export interface MicAccess {
  status(): MicStatus
  /** Prompts only while undecided; otherwise reports whether access is already granted. */
  ask(): Promise<boolean>
  openSettings(): Promise<void>
}

/**
 * Microphone access. Under HARNESS_E2E=1 the real status, prompt and System Settings are never
 * touched: the status is `HARNESS_MIC_STATUS` (default granted) and opening settings is only counted.
 */
export function createMicAccess(deps: MicAccessDeps): MicAccess {
  const isE2e = deps.env['HARNESS_E2E'] === '1'
  let settingsOpens = 0
  if (isE2e) {
    const target = deps.target ?? (globalThis as NonNullable<MicAccessDeps['target']>)
    target.__e2e = { ...target.__e2e, getMicSettingsOpens: () => settingsOpens }
  }
  const status = (): MicStatus => {
    const raw = isE2e ? (deps.env['HARNESS_MIC_STATUS'] ?? 'granted') : deps.getStatus()
    return STATUSES.find((s) => s === raw) ?? 'not-determined'
  }
  return {
    status,
    async ask() {
      const current = status()
      if (current !== 'not-determined') return current === 'granted'
      return isE2e ? false : await deps.ask()
    },
    async openSettings() {
      if (isE2e) {
        settingsOpens += 1
        return
      }
      await deps.openExternal(MIC_SETTINGS_URL)
    }
  }
}
