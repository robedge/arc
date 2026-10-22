import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AppSettingsRepo } from '../../../src/main/db/repositories/app-settings-repo'
import { BrainThreadsRepo } from '../../../src/main/db/repositories/brain-threads-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let settings: AppSettingsRepo

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  settings = new AppSettingsRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

describe('AppSettingsRepo', () => {
  it('keeps the dismissed update version per provider, outside the settings', () => {
    expect(settings.getDismissedUpdate('codex')).toBeUndefined()
    settings.setDismissedUpdate('codex', '0.170.0', 1)
    settings.setDismissedUpdate('codex', '0.171.0', 2)
    expect(settings.getDismissedUpdate('codex')).toBe('0.171.0')
    expect(settings.getDismissedUpdate('claude')).toBeUndefined()
    expect(Object.keys(settings.getAll())).toEqual([
      'providers.brain',
      'providers.workers',
      'usage.checkClaudePlanOnLaunch',
      'agents.loadOff'
    ])
  })

  it('has nothing switched off by default and stores only what the user switches off', () => {
    expect(settings.get('agents.loadOff')).toEqual({ brain: [], workers: [] })
    settings.setMany({ 'agents.loadOff': { brain: [], workers: ['mcp:figma'] } }, 1)
    expect(settings.getAll()['agents.loadOff']).toEqual({ brain: [], workers: ['mcp:figma'] })
    settings.setMany({ 'agents.loadOff': { brain: [], workers: [] } }, 2)
    expect(settings.get('agents.loadOff')).toEqual({ brain: [], workers: [] })
  })

  it('rejects a malformed load selection and keeps the earlier one', () => {
    settings.setMany({ 'agents.loadOff': { brain: ['plugin:a@m'], workers: [] } }, 1)
    expect(() => settings.setMany({ 'agents.loadOff': { brain: 'x' } as never }, 2)).toThrow()
    expect(() =>
      settings.setMany({ 'agents.loadOff': { brain: [], workers: [''] } as never }, 2)
    ).toThrow()
    expect(settings.get('agents.loadOff').brain).toEqual(['plugin:a@m'])
  })

  it('falls back to nothing off when the stored value is unreadable', () => {
    opened.sqlite
      .prepare(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('agents.loadOff', '{\"brain\":3}', 1)"
      )
      .run()
    expect(settings.get('agents.loadOff')).toEqual({ brain: [], workers: [] })
  })

  it('checks the Claude plan on launch by default and keeps the choice', () => {
    expect(settings.get('usage.checkClaudePlanOnLaunch')).toBe(true)
    settings.setMany({ 'usage.checkClaudePlanOnLaunch': false }, 1)
    expect(settings.getAll()['usage.checkClaudePlanOnLaunch']).toBe(false)
    expect(() => settings.setMany({ 'usage.checkClaudePlanOnLaunch': 'no' as never }, 2)).toThrow()
  })

  it('returns the defaults on an empty table', () => {
    expect(settings.getProviderDefaults()).toEqual({
      brain: { provider: 'claude', model: 'sonnet' },
      workers: { mode: 'auto' }
    })
  })

  it('sets, reads back and upserts', () => {
    settings.set('providers.brain', { provider: 'codex', model: 'gpt-5' }, 1)
    settings.set('providers.brain', { provider: 'claude', model: 'opus' }, 2)
    expect(settings.get('providers.brain')).toEqual({ provider: 'claude', model: 'opus' })
    expect(
      opened.sqlite
        .prepare("SELECT updated_at AS u FROM app_settings WHERE key LIKE 'providers.%'")
        .get()
    ).toEqual({
      u: 2
    })
  })

  it('rejects an invalid value and falls back to the default for a bad stored row', () => {
    expect(() =>
      settings.set('providers.brain', { provider: 'nope', model: 'x' } as never, 1)
    ).toThrow()
    opened.sqlite
      .prepare(
        "INSERT INTO app_settings (key,value_json,updated_at) VALUES ('providers.workers','{bad',1)"
      )
      .run()
    expect(settings.get('providers.workers')).toEqual({ mode: 'auto' })
  })

  it('stores the provider mode of Workers and getAll returns every key', () => {
    expect(settings.getAll()).toEqual({
      'providers.brain': { provider: 'claude', model: 'sonnet' },
      'providers.workers': { mode: 'auto' },
      'usage.checkClaudePlanOnLaunch': true,
      'agents.loadOff': { brain: [], workers: [] }
    })
    settings.set('providers.workers', { mode: 'provider', provider: 'codex' }, 1)
    expect(settings.get('providers.workers')).toEqual({ mode: 'provider', provider: 'codex' })
    expect(settings.getAll()['providers.workers']).toEqual({ mode: 'provider', provider: 'codex' })
    expect(() =>
      settings.set('providers.workers', { mode: 'provider', provider: 'gemini' } as never, 2)
    ).toThrow()
    expect(() => settings.set('providers.workers', { mode: 'provider' } as never, 2)).toThrow()
  })

  it('setMany is atomic', () => {
    expect(() =>
      settings.setMany(
        {
          'providers.brain': { provider: 'codex', model: 'gpt-5' },
          'providers.workers': { mode: 'model', model: { provider: 'bogus', model: 'x' } } as never
        },
        1
      )
    ).toThrow()
    expect(
      opened.sqlite
        .prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'providers.%'")
        .get()
    ).toEqual({ n: 0 })
    settings.setMany(
      {
        'providers.brain': { provider: 'codex', model: 'gpt-5' },
        'providers.workers': { mode: 'model', model: { provider: 'codex', model: 'gpt-5' } }
      },
      3
    )
    expect(settings.getProviderDefaults().workers).toEqual({
      mode: 'model',
      model: { provider: 'codex', model: 'gpt-5' }
    })
  })
})

describe('BrainThreadsRepo', () => {
  it('stores one thread per session and provider', () => {
    new GroupsRepo(opened.db).insert({
      id: 'g',
      name: 'g',
      nameKey: 'g',
      createdAt: 1,
      updatedAt: 1
    })
    new SessionsRepo(opened.db).create({
      id: 's',
      groupId: 'g',
      name: 's',
      mode: 'plan_first',
      workerLimit: 2,
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1
    })
    const threads = new BrainThreadsRepo(opened.db)
    expect(threads.get('s', 'claude')).toBeUndefined()
    threads.set('s', 'claude', 'c1', 1)
    threads.set('s', 'codex', 'x1', 2)
    threads.set('s', 'claude', 'c2', 3)
    expect(threads.get('s', 'claude')).toBe('c2')
    expect(threads.get('s', 'codex')).toBe('x1')
  })
})
