import type { ProviderId, ProviderStatusMap } from '@shared/types/provider'
import type { IpcEventName, IpcEvents } from '@shared/ipc/contract'

/** A focus after this long since the last full check runs another (functional spec 2.8). */
export const PROVIDER_RECHECK_AFTER_MS = 10 * 60 * 1000

export interface ProviderChecksDeps {
  providers: {
    check(provider?: ProviderId, options?: { forceLatest?: boolean }): Promise<ProviderStatusMap>
    get(): ProviderStatusMap
  }
  models: { refresh(options?: { force?: boolean }): Promise<boolean> }
  codexCommands: { invalidate(): void }
  cursorCommands: { invalidate(): void }
  codexLimits: { refresh(): Promise<void> }
  cursorPlan: { refresh(): Promise<void> }
  claudePlanProbe: { runOnce(): Promise<boolean> } | undefined
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void
  log: { error(message: string, ...rest: unknown[]): void }
  now?: () => number
}

/** Full provider checks (status, latest versions, model lists, command lists, plan meters). */
export class ProviderChecks {
  private lastFullCheckAt = 0

  constructor(private readonly deps: ProviderChecksDeps) {}

  /** The Cursor command files are read again (Check again, app start); the `/` list is told. */
  refreshCursorCommands(): void {
    this.deps.cursorCommands.invalidate()
    this.deps.emit('commands:changed', {})
  }

  /** The Codex skills and prompts are read again (Check again, app start); the `/` list is told. */
  refreshCodexCommands(): void {
    this.deps.codexCommands.invalidate()
    this.deps.emit('commands:changed', {})
  }

  /**
   * A full check: status, the latest versions, and the model lists. A changed model list pushes
   * `providers:changed` again so the pickers refetch. Used at launch, by Check again and on focus.
   */
  async runFullCheck(options: { forceLatest?: boolean } = {}): Promise<void> {
    const { providers, models, emit } = this.deps
    this.lastFullCheckAt = this.now()
    await providers.check(undefined, options)
    // The Codex model list follows the status; a forced refresh sees models added since the last one.
    if (await models.refresh({ force: true })) emit('providers:changed', providers.get())
    this.refreshCodexCommands()
    // The model refresh above has run Cursor's probe, so its command list is current.
    this.refreshCursorCommands()
    // Codex's limits are read once its status is known (this is also the launch read).
    void this.deps.codexLimits.refresh()
    // Cursor's meter ("Not reported", with the subscription tier) likewise.
    void this.deps.cursorPlan.refresh()
    // Claude's meter gets its launch value once Claude's status is known; at most once per launch.
    void this.deps.claudePlanProbe?.runOnce()
  }

  /** Background check at startup; the renderer gets the result when it arrives or once it has loaded. */
  start(): void {
    this.runFullCheck().catch((e: unknown) => {
      this.deps.log.error('provider check failed', e)
    })
  }

  /** On window focus: another full check once the last one is 10 minutes old. */
  recheckOnFocus(): void {
    if (this.now() - this.lastFullCheckAt < PROVIDER_RECHECK_AFTER_MS) return
    this.start()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
