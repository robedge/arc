import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_RECHECK_AFTER_MS, ProviderChecks } from '../../src/main/app/provider-checks'

function rig(options: { modelsChanged?: boolean; now?: () => number } = {}) {
  const deps = {
    providers: { check: vi.fn(() => Promise.resolve({})), get: vi.fn(() => ({})) },
    models: { refresh: vi.fn(() => Promise.resolve(options.modelsChanged ?? false)) },
    codexCommands: { invalidate: vi.fn() },
    cursorCommands: { invalidate: vi.fn() },
    codexLimits: { refresh: vi.fn(() => Promise.resolve()) },
    cursorPlan: { refresh: vi.fn(() => Promise.resolve()) },
    claudePlanProbe: { runOnce: vi.fn(() => Promise.resolve(true)) },
    emit: vi.fn(),
    log: { error: vi.fn() },
    now: options.now
  }
  return { deps, checks: new ProviderChecks(deps) }
}

describe('ProviderChecks', () => {
  it('a full check refreshes models, both command lists and the plan meters', async () => {
    const { deps, checks } = rig({ modelsChanged: true })
    await checks.runFullCheck({ forceLatest: true })
    expect(deps.providers.check).toHaveBeenCalledWith(undefined, { forceLatest: true })
    expect(deps.emit).toHaveBeenCalledWith('providers:changed', {})
    expect(deps.codexCommands.invalidate).toHaveBeenCalledOnce()
    expect(deps.cursorCommands.invalidate).toHaveBeenCalledOnce()
    expect(deps.codexLimits.refresh).toHaveBeenCalledOnce()
    expect(deps.cursorPlan.refresh).toHaveBeenCalledOnce()
    expect(deps.claudePlanProbe.runOnce).toHaveBeenCalledOnce()
  })

  it('does not push providers:changed when the model lists did not change', async () => {
    const { deps, checks } = rig()
    await checks.runFullCheck()
    expect(deps.emit).not.toHaveBeenCalledWith('providers:changed', expect.anything())
  })

  it('logs a failed startup check instead of rejecting', async () => {
    const { deps, checks } = rig()
    deps.providers.check.mockRejectedValue(new Error('no network'))
    checks.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.log.error).toHaveBeenCalledWith('provider check failed', expect.any(Error))
  })

  it('rechecks on focus only once the last full check is older than ten minutes', async () => {
    let now = 1_000_000
    const { deps, checks } = rig({ now: () => now })
    await checks.runFullCheck()
    deps.providers.check.mockClear()
    now += PROVIDER_RECHECK_AFTER_MS - 1
    checks.recheckOnFocus()
    expect(deps.providers.check).not.toHaveBeenCalled()
    now += 1
    checks.recheckOnFocus()
    expect(deps.providers.check).toHaveBeenCalledOnce()
  })
})
