import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CursorProbe,
  cursorGroupOf,
  mapCursorModels,
  splitModelId,
  type CursorProbeDeps
} from '../../../../src/main/agents/cursor/cursor-probe'
import { FakeAcp, until } from './fake-acp'
import { sessionNewResult } from './fixtures'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'arc-cursor-probe-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function probeFor(fake: FakeAcp, over: Partial<CursorProbeDeps> = {}): CursorProbe {
  return new CursorProbe({
    supervisor: fake.supervisor,
    binary: () => 'agent',
    resolvePath: () => Promise.resolve('/usr/bin'),
    env: { HOME: '/home/u', CURSOR_API_KEY: 'secret' },
    dir: join(root, 'cursor-probe'),
    timeoutMs: 2000,
    stopGraceMs: 30,
    ...over
  })
}

describe('splitModelId', () => {
  it('splits the name from the bracket parameters', () => {
    expect(splitModelId('grok-4.7[context=256k,reasoning_effort=high,fast=true]')).toEqual({
      name: 'grok-4.7',
      params: [
        ['context', '256k'],
        ['reasoning_effort', 'high'],
        ['fast', 'true']
      ],
      raw: 'context=256k,reasoning_effort=high,fast=true'
    })
  })

  it('has no parameters for empty brackets or none', () => {
    expect(splitModelId('default[]')).toEqual({ name: 'default', params: [], raw: '' })
    expect(splitModelId('plain')).toEqual({ name: 'plain', params: [], raw: '' })
  })
})

describe('cursorGroupOf', () => {
  it.each([
    ['default', 'Cursor'],
    ['composer-2.5', 'Cursor'],
    ['claude-opus-5', 'Claude'],
    ['gpt-5.4-mini', 'GPT/Codex'],
    ['o4-mini', 'GPT/Codex'],
    ['grok-4.7', 'Grok'],
    ['gemini-3.1-pro', 'Gemini'],
    ['kimi-k3', 'Other'],
    ['glm-5.2', 'Other']
  ])('%s is in %s', (name, group) => {
    expect(cursorGroupOf(name)).toBe(group)
  })
})

describe('mapCursorModels', () => {
  const available = (
    sessionNewResult('m1-agent-turn.jsonl') as { models: { availableModels: never[] } }
  ).models.availableModels

  it('maps the recorded session/new list: every model, default[] as Auto and the default', () => {
    const models = mapCursorModels(available)
    expect(models).toHaveLength(available.length)
    expect(models.length).toBeGreaterThan(40)
    const defaults = models.filter((m) => m.isDefault)
    expect(defaults).toEqual([
      { model: 'default[]', displayName: 'Auto', isDefault: true, group: 'Cursor', base: 'Auto' }
    ])
  })

  it('labels a model with its name, effort level and the switches that are on', () => {
    const byId = new Map(mapCursorModels(available).map((m) => [m.model, m]))
    expect(byId.get('grok-4.7[context=256k,reasoning_effort=high,fast=true]')).toEqual({
      model: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
      displayName: 'grok-4.7 · high · fast',
      isDefault: false,
      group: 'Grok',
      base: 'grok-4.7',
      variant: 'context=256k,reasoning_effort=high,fast=true'
    })
    expect(byId.get('gpt-5.4-mini[reasoning=medium]')).toMatchObject({
      displayName: 'gpt-5.4-mini · medium',
      group: 'GPT/Codex'
    })
    expect(
      byId.get('claude-opus-5[thinking=true,context=300k,effort=high,fast=false]')
    ).toMatchObject({ displayName: 'claude-opus-5 · high · thinking', group: 'Claude' })
    // Empty brackets: no variant, the label is the name.
    expect(byId.get('gemini-3.1-pro[]')).toEqual({
      model: 'gemini-3.1-pro[]',
      displayName: 'gemini-3.1-pro',
      isDefault: false,
      group: 'Gemini',
      base: 'gemini-3.1-pro'
    })
  })

  it('only marks default[] as the default and drops a repeated id', () => {
    const models = mapCursorModels([
      { modelId: 'a[]', name: 'a' },
      { modelId: 'a[]', name: 'a' },
      { modelId: 'default[]', name: 'Auto' },
      { modelId: '', name: 'blank' }
    ])
    expect(models.map((m) => [m.model, m.isDefault])).toEqual([
      ['a[]', false],
      ['default[]', true]
    ])
  })
})

describe('CursorProbe.listModels', () => {
  it('runs initialize, authenticate and session/new in its own folder, sends no prompt and ends the process', async () => {
    const fake = new FakeAcp()
    const probe = probeFor(fake)
    const models = await probe.listModels()

    expect(fake.methods()).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(fake.requests('session/new')[0]?.['params']).toEqual({
      cwd: join(root, 'cursor-probe'),
      mcpServers: []
    })
    expect(existsSync(join(root, 'cursor-probe'))).toBe(true)
    expect(fake.spawned[0]).toMatchObject({
      command: 'agent',
      args: ['acp'],
      cwd: join(root, 'cursor-probe')
    })
    expect(fake.spawned[0]?.env).not.toHaveProperty('CURSOR_API_KEY')
    expect(models.find((m) => m.isDefault)?.model).toBe('default[]')
    expect(models.length).toBeGreaterThan(40)
    // The process is gone: stdin closed, then signalled because the fake ignores the close.
    expect(fake.signals).toContain('SIGTERM')
  })

  it('keeps the commands of available_commands_update for later', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/new'] = (msg, f) => {
      f.update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review the change' }]
      })
      f.result(msg, sessionNewResult('m1-agent-turn.jsonl'))
    }
    const probe = probeFor(fake)
    expect(probe.lastCommands()).toEqual([])
    await probe.listModels()
    expect(probe.lastCommands()).toEqual([{ name: 'review', description: 'Review the change' }])
  })

  it('rejects when session/new carries no model list, and still ends the process', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/new'] = (msg, f) => f.result(msg, { sessionId: 's' })
    await expect(probeFor(fake).listModels()).rejects.toThrow(/without a model list/)
    expect(fake.signals).toContain('SIGTERM')
  })

  it('rejects with the server error when authentication is required', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/new'] = (msg, f) => f.error(msg, -32000, 'Authentication required')
    await expect(probeFor(fake).listModels()).rejects.toThrow(/Authentication required/)
  })

  it('rejects when Cursor does not answer in time', async () => {
    const fake = new FakeAcp()
    fake.handlers['initialize'] = () => undefined
    await expect(probeFor(fake, { timeoutMs: 80 }).listModels()).rejects.toThrow(/in time/)
    expect(fake.signals).toContain('SIGTERM')
  })

  it('rejects with why the process ended when it exits before answering', async () => {
    const fake = new FakeAcp()
    fake.handlers['initialize'] = (_msg, f) => f.exit(1, null)
    await expect(probeFor(fake).listModels()).rejects.toThrow(/exited before answering/)
  })

  it('rejects when Cursor is not installed, without spawning', async () => {
    const fake = new FakeAcp()
    await expect(probeFor(fake, { binary: () => undefined }).listModels()).rejects.toThrow(
      /isn't installed/
    )
    expect(fake.spawned).toHaveLength(0)
  })

  it('answers a request from the server with -32601 so it never waits on the probe', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/new'] = (msg, f) => {
      f.send({ id: 7, method: 'session/request_permission', params: {} })
      f.result(msg, sessionNewResult('m1-agent-turn.jsonl'))
    }
    await probeFor(fake).listModels()
    await until(() => fake.received.some((m) => m['id'] === 7))
    expect(fake.received.find((m) => m['id'] === 7)).toMatchObject({ error: { code: -32601 } })
  })
})
