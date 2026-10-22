import {
  PROVIDER_IDS,
  PROVIDER_STATUS_TTL_MS,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusMap
} from '@shared/types/provider'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import { assertNever } from '@shared/assert-never'
import { CLI_MESSAGES } from '../agents/cli-resolver'
import { isNewerVersion, updateCommandFor } from './provider-versions'

/** The checks the service runs; `CliResolver` implements it. */
export interface ProviderChecker {
  checkClaude: () => Promise<ProviderStatus>
  checkCodex: () => Promise<ProviderStatus>
  checkCursor: () => Promise<ProviderStatus>
  /** Forgets the cached login-shell PATH so the next check resolves it again. */
  resetPath: () => void
}

export interface ProviderStatusServiceDeps {
  checker: ProviderChecker
  /** The newest published version per provider (`LatestVersions`); left out, no update is ever shown. */
  latest?: {
    get: (provider: ProviderId, options?: { force?: boolean }) => Promise<string | undefined>
  }
  /** Where the provider's binary really is, to tell a Homebrew install apart. */
  locate?: (provider: ProviderId) => Promise<string | undefined>
  /** `providers.update_dismissed.<provider>`: the version whose notice the user dismissed. */
  dismissals?: {
    get: (provider: ProviderId) => string | undefined
    set: (provider: ProviderId, version: string) => void
  }
  /** True while agents run; the restart prompt is only for a switch that would affect them. */
  hasRunningAgents?: (provider: ProviderId) => boolean
  /** Pushes `providers:changed` with the whole map. */
  publish: (map: ProviderStatusMap) => void
  now?: () => number
  ttlMs?: number
  log?: { error: (message: string, ...rest: unknown[]) => void }
}

/** Caches the last status per provider and publishes every change. */
export class ProviderStatusService {
  private readonly checker: ProviderChecker
  private readonly publish: (map: ProviderStatusMap) => void
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly log: NonNullable<ProviderStatusServiceDeps['log']>
  private readonly cache = new Map<ProviderId, ProviderStatus>()
  private readonly inflight = new Map<ProviderId, Promise<ProviderStatus>>()
  private readonly latestSeen = new Map<ProviderId, string>()
  private readonly commandSeen = new Map<ProviderId, string>()

  constructor(private readonly deps: ProviderStatusServiceDeps) {
    this.checker = deps.checker
    this.publish = deps.publish
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? PROVIDER_STATUS_TTL_MS
    this.log = deps.log ?? { error: () => undefined }
  }

  /** The cached map; a provider is absent until its first check has finished. */
  get(): ProviderStatusMap {
    const map: ProviderStatusMap = {}
    for (const id of PROVIDER_IDS) {
      const status = this.cache.get(id)
      if (status) map[id] = status
    }
    return map
  }

  getStatus(provider: ProviderId): ProviderStatus | undefined {
    return this.cache.get(provider)
  }

  /**
   * Checks now (one provider or all), resets the cached login-shell PATH first, and publishes
   * `providers:changed`. Returns the full map.
   */
  async check(
    provider?: ProviderId,
    options: { forceLatest?: boolean } = {}
  ): Promise<ProviderStatusMap> {
    this.checker.resetPath()
    const ids = provider ? [provider] : PROVIDER_IDS
    await Promise.all(ids.map((id) => this.run(id, options.forceLatest === true)))
    return this.get()
  }

  /**
   * Lazy re-check before a spawn: returns the cached status while it is ok and younger than the
   * TTL, otherwise checks again.
   */
  async ensureFresh(provider: ProviderId): Promise<ProviderStatus> {
    const cached = this.cache.get(provider)
    if (cached && cached.state === 'ok' && this.now() - cached.checkedAt < this.ttlMs) {
      return cached
    }
    return this.run(provider, false)
  }

  /** The brain hit an auth error at runtime: record Claude as signed out and publish. */
  markSignedOut(provider: ProviderId): void {
    const previous = this.cache.get(provider)
    const messages = CLI_MESSAGES[provider]
    const status = this.decorate(
      {
        provider,
        state: 'signed_out',
        ...(previous?.version ? { version: previous.version } : {}),
        message: messages.signedOut,
        loginCommand: PROVIDER_TRAITS[provider].loginCommand,
        checkedAt: this.now()
      },
      previous
    )
    this.cache.set(provider, status)
    this.publish(this.get())
  }

  /** The user dismissed the update notice for `version`; the Providers page still shows the update. */
  dismissUpdate(provider: ProviderId, version: string): void {
    this.deps.dismissals?.set(provider, version)
    const status = this.cache.get(provider)
    if (status?.updateAvailable) {
      this.cache.set(provider, { ...status, updateDismissed: status.latestVersion === version })
    }
    this.publish(this.get())
  }

  /**
   * Adds the update fields (from the last registry lookup) and the restart flag to a fresh check
   * result. The checker never sets them.
   */
  private decorate(raw: ProviderStatus, previous: ProviderStatus | undefined): ProviderStatus {
    const provider = raw.provider
    const latest = this.latestSeen.get(provider)
    const available =
      latest !== undefined && raw.version !== undefined && isNewerVersion(latest, raw.version)
    const restartReason = this.restartReason(raw, previous)
    return {
      ...raw,
      ...(latest === undefined ? {} : { latestVersion: latest }),
      updateAvailable: available,
      ...(available
        ? {
            updateCommand: this.commandSeen.get(provider) ?? updateCommandFor(provider, undefined),
            updateDismissed: this.deps.dismissals?.get(provider) === latest
          }
        : {}),
      ...(restartReason === undefined ? {} : { restartRequired: true, restartReason })
    }
  }

  /**
   * Why Arc can't move to the changed tool live, or undefined. Only with agents running, and only
   * for a tool that was ok before: its binary is gone even after the PATH refresh, or the new
   * version is below the minimum gate. Once set, it stays until the provider is ok again.
   */
  private restartReason(
    raw: ProviderStatus,
    previous: ProviderStatus | undefined
  ): string | undefined {
    if (raw.state === 'ok' || !previous) return undefined
    if (previous.restartRequired && previous.restartReason) return previous.restartReason
    if (previous.state !== 'ok' || !this.deps.hasRunningAgents?.(raw.provider)) return undefined
    const name = PROVIDER_TRAITS[raw.provider].cliName
    if (raw.state === 'missing') {
      return `${name} can no longer be found at a path Arc can resolve. Restart Arc so it picks up the new install.`
    }
    if (raw.state === 'unsupported') {
      return `The updated ${name} is older than Arc supports while agents are running on it. Restart Arc to finish updating.`
    }
    return undefined
  }

  /** Looks up the newest version (and how to update) after the check, silently. */
  private async lookupUpdate(raw: ProviderStatus, force: boolean): Promise<void> {
    const provider = raw.provider
    if (!this.deps.latest || raw.version === undefined) return
    try {
      const latest = await this.deps.latest.get(provider, { force })
      if (latest === undefined) return
      this.latestSeen.set(provider, latest)
      if (isNewerVersion(latest, raw.version)) {
        const binary = await this.deps.locate?.(provider)
        this.commandSeen.set(provider, updateCommandFor(provider, binary))
      }
    } catch (error: unknown) {
      this.log.error(`${provider} update lookup failed`, error)
    }
  }

  private runChecker(provider: ProviderId): Promise<ProviderStatus> {
    switch (provider) {
      case 'claude':
        return this.checker.checkClaude()
      case 'codex':
        return this.checker.checkCodex()
      case 'cursor':
        return this.checker.checkCursor()
      default:
        return assertNever(provider)
    }
  }

  private run(provider: ProviderId, forceLatest: boolean): Promise<ProviderStatus> {
    const running = this.inflight.get(provider)
    if (running) return running
    const task = (async (): Promise<ProviderStatus> => {
      try {
        const raw = await this.runChecker(provider)
        const previous = this.cache.get(provider)
        // Publish the status at once, with the last known update info; the registry lookup follows.
        let status = this.decorate(raw, previous)
        this.cache.set(provider, status)
        this.publish(this.get())
        await this.lookupUpdate(raw, forceLatest)
        const next = this.decorate(raw, previous)
        if (JSON.stringify(next) !== JSON.stringify(status)) {
          status = next
          this.cache.set(provider, status)
          this.publish(this.get())
        }
        return status
      } catch (error: unknown) {
        this.log.error(`${provider} check failed`, error)
        const previous = this.cache.get(provider)
        if (previous) return previous
        throw error
      } finally {
        this.inflight.delete(provider)
      }
    })()
    this.inflight.set(provider, task)
    return task
  }
}
