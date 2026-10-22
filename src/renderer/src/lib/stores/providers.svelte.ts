import {
  PROVIDER_IDS,
  type BypassReport,
  type ProviderId,
  type ProviderStatusMap
} from '@shared/types/provider'

/** Every provider idle: no check is running. */
function idleBusy(): Record<ProviderId, boolean> {
  return { claude: false, codex: false, cursor: false }
}

/** Provider statuses, with the main process as the source of truth. */
class ProvidersStore {
  /** A provider is absent until main has reported its first check. */
  statuses = $state<ProviderStatusMap>({})
  /** True while `providers:check` runs for that provider. */
  busy = $state<Record<ProviderId, boolean>>(idleBusy())

  /** `sessionId:provider` to the state its note was dismissed in. Memory only: a relaunch shows it again. */
  providerNoteDismissed = $state<Record<string, string>>({})

  /** What can skip Arc's approvals; null until the first read. */
  bypass = $state<BypassReport | null>(null)
  bypassBusy = $state(false)

  /** Claude's status, or undefined before the first check. */
  claude = $derived(this.statuses.claude)

  /** Providers whose restart prompt was put off with Later. Memory only; cleared once a provider no longer needs a restart. */
  restartDeferred = $state<Record<string, boolean>>({})

  set(map: ProviderStatusMap): void {
    for (const id of PROVIDER_IDS) {
      const next = map[id]
      if (next && !next.restartRequired && this.restartDeferred[id]) {
        this.restartDeferred = { ...this.restartDeferred, [id]: false }
      }
    }
    this.statuses = { ...this.statuses, ...map }
  }

  async load(): Promise<void> {
    const result = await window.harness.invoke('providers:get', {})
    if (result.ok) this.set(result.data)
  }

  /** Re-checks one provider, or all when none is given. */
  async check(provider?: ProviderId): Promise<void> {
    const targets = provider ? [provider] : PROVIDER_IDS
    if (targets.every((p) => this.busy[p])) return
    for (const p of targets) this.busy[p] = true
    try {
      const result = await window.harness.invoke('providers:check', provider ? { provider } : {})
      if (result.ok) this.set(result.data)
    } finally {
      for (const p of targets) this.busy[p] = false
    }
  }

  /** Reads the hooks and Codex rules that can skip Arc's approvals; main reads them again on each call. */
  async loadBypass(): Promise<void> {
    if (this.bypassBusy) return
    this.bypassBusy = true
    try {
      const result = await window.harness.invoke('providers:bypass', {})
      if (result.ok) {
        const data: Partial<BypassReport> = (result.data as BypassReport | undefined) ?? {}
        this.bypass = {
          claudeHookEvents: Array.isArray(data.claudeHookEvents) ? data.claudeHookEvents : [],
          ...(data.claudeHookEventsByRole
            ? {
                claudeHookEventsByRole: {
                  brain: [...data.claudeHookEventsByRole.brain],
                  workers: [...data.claudeHookEventsByRole.workers]
                }
              }
            : {}),
          codexAllowPrefixes: Array.isArray(data.codexAllowPrefixes) ? data.codexAllowPrefixes : [],
          codexRulesCovered:
            typeof data.codexRulesCovered === 'number' ? data.codexRulesCovered : 0,
          ...(data.cursor
            ? {
                cursor: {
                  allowEntries: Array.isArray(data.cursor.allowEntries)
                    ? [...data.cursor.allowEntries]
                    : [],
                  approvalMode: data.cursor.approvalMode,
                  hookEvents: Array.isArray(data.cursor.hookEvents)
                    ? [...data.cursor.hookEvents]
                    : []
                }
              }
            : {})
        }
      }
    } finally {
      this.bypassBusy = false
    }
  }

  /** Hides the restart prompt until a later push reports a restart as newly required. */
  deferRestart(provider: ProviderId): void {
    this.restartDeferred = { ...this.restartDeferred, [provider]: true }
  }

  /** Marks the update notice for this version as seen; main answers with the refreshed statuses. */
  async dismissUpdate(provider: ProviderId, version: string): Promise<void> {
    const result = await window.harness.invoke('providers:dismiss-update', { provider, version })
    if (result.ok) this.set(result.data)
  }

  dismissProviderNote(sessionId: string, provider: ProviderId, state: string): void {
    this.providerNoteDismissed = {
      ...this.providerNoteDismissed,
      [`${sessionId}:${provider}`]: state
    }
  }

  reset(): void {
    this.providerNoteDismissed = {}
    this.restartDeferred = {}
    this.statuses = {}
    this.bypass = null
    this.bypassBusy = false
    this.busy = idleBusy()
  }
}

export const providers = new ProvidersStore()
