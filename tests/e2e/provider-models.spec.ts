import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { e2eEnv, mainWindow } from './fixtures'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const FAKE_CODEX = resolve('tests/e2e/fixtures/fake-codex.mjs')

/** The model lists and the Settings defaults over the real IPC, with the fake Codex behind the probe (no model call). */
test('providers:models lists Codex only while it is signed in, and settings round-trip', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'harness-e2e-models-'))
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...e2eEnv(userDataDir), HARNESS_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_AUTH: 'ok' }
  })
  try {
    const page = await mainWindow(app)

    const models = await page.evaluate(() => window.arc.invoke('providers:models', {}))
    expect(models.ok).toBe(true)
    if (!models.ok) return
    expect(models.data.claude.map((m) => m.ref.model)).toEqual(['opus', 'fable', 'sonnet', 'haiku'])
    expect(models.data.codex.map((m) => [m.ref.model, m.tier, m.isDefault])).toEqual([
      ['fake-deep', 'balanced', true],
      ['fake-fast', 'fast', false]
    ])
    // Cached for the next start: userData/provider-cache.json
    const cachePath = join(userDataDir, 'provider-cache.json')
    expect(existsSync(cachePath)).toBe(true)
    expect(
      (JSON.parse(readFileSync(cachePath, 'utf8')) as { codex: { models: unknown[] } }).codex.models
    ).toHaveLength(2)

    const defaults = await page.evaluate(() => window.arc.invoke('settings:get', {}))
    expect(defaults).toEqual({
      ok: true,
      data: {
        'providers.brain': { provider: 'claude', model: 'sonnet' },
        'providers.workers': { mode: 'auto' },
        'usage.checkClaudePlanOnLaunch': true,
        'knowledge.suggestOnFinish': true,
        'agents.loadOff': { brain: [], workers: [] },
        'approvals.skipAllByDefault': false
      }
    })

    // settings:changed is pushed with every key.
    await page.evaluate(() => {
      const w = window as unknown as { __changed: unknown[] }
      w.__changed = []
      window.arc.on('settings:changed', (payload) => w.__changed.push(payload))
    })
    const set = await page.evaluate(() =>
      window.arc.invoke('settings:set', {
        'providers.workers': { mode: 'provider', provider: 'codex' }
      })
    )
    expect(set).toEqual({
      ok: true,
      data: {
        'providers.brain': { provider: 'claude', model: 'sonnet' },
        'providers.workers': { mode: 'provider', provider: 'codex' },
        'usage.checkClaudePlanOnLaunch': true,
        'knowledge.suggestOnFinish': true,
        'agents.loadOff': { brain: [], workers: [] },
        'approvals.skipAllByDefault': false
      }
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __changed: unknown[] }).__changed))
      .toEqual([set.ok ? set.data : null])

    const invalid = await page.evaluate(() =>
      window.arc.invoke('settings:set', {
        'providers.workers': { mode: 'provider', provider: 'gemini' } as never
      })
    )
    expect(invalid.ok).toBe(false)
  } finally {
    await app.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('with Codex signed out, providers:models offers no Codex models', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'harness-e2e-models-'))
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...e2eEnv(userDataDir), HARNESS_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_AUTH: 'signed_out' }
  })
  try {
    const page = await mainWindow(app)
    const models = await page.evaluate(() => window.arc.invoke('providers:models', {}))
    expect(models.ok && models.data.codex).toEqual([])
    expect(models.ok && models.data.claude).toHaveLength(4)
    // The Claude list is cached once probed; signed out, nothing is cached for Codex.
    const cachePath = join(userDataDir, 'provider-cache.json')
    const cached = existsSync(cachePath)
      ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>)
      : {}
    expect(cached).not.toHaveProperty('codex')
  } finally {
    await app.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})
