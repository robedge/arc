import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import type {
  ClaudePersonalFiles,
  ClaudePersonalRequest,
  CodexPersonalMcp,
  PersonalLaunchConfig
} from '../../../src/main/personal/personal-config'
import type { ProviderStatus, ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeCodexAdapter } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-personal-launch-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

function mcpOf(names: string[], degraded = false): CodexPersonalMcp {
  return { servers: names.map((name) => ({ name, approvalTools: [] })), degraded }
}

interface FakePersonal extends PersonalLaunchConfig {
  claude: ReturnType<typeof vi.fn<(request: ClaudePersonalRequest) => Promise<ClaudePersonalFiles>>>
  codexMcp: ReturnType<
    typeof vi.fn<(cwd: string, role?: 'brain' | 'workers') => Promise<CodexPersonalMcp>>
  >
}

/** Like the real service for the bridge: the merged file starts as a copy of the bridge's own, so the agent can still call Arc. */
function fakePersonal(withHooks = true): FakePersonal {
  let count = 0
  return {
    claude: vi.fn((request: ClaudePersonalRequest) => {
      const out = join(dir(), `merged-${++count}.json`)
      if (request.arcConfigPath) copyFileSync(request.arcConfigPath, out)
      return Promise.resolve({
        mcpConfigPath: out,
        ...(withHooks ? { hooksSettingsPath: join(dir(), 'hooks.settings.json') } : {})
      })
    }),
    codexMcp: vi.fn(() => Promise.resolve(mcpOf(['figma', 'github'])))
  }
}

async function spawnWorker(rig: EngineRig, extra: Record<string, unknown> = {}): Promise<void> {
  const result = await rig.call(rig.brain(), 'spawn_worker', {
    name: 'one',
    task: 'Do one',
    repos: ['api'],
    ...extra
  })
  expect(result.isError).toBe(false)
}

describe('personal MCP servers and hooks on Claude launches', () => {
  it('gives the brain and a worker the merged MCP file and the hooks-only settings file', async () => {
    const personal = fakePersonal()
    e = await makeEngineRig(dir(), { personal })
    await e.startSession('autonomous')
    await spawnWorker(e, { model: 'sonnet' })
    await until(() => e!.rig.adapter.starts.some((s) => s.role === 'worker'))
    for (const start of e.rig.adapter.starts) {
      expect(start.claude.mcpConfigPath).toMatch(/merged-\d\.json$/)
      expect(start.claude.hooksSettingsPath).toBe(join(dir(), 'hooks.settings.json'))
    }
    // The bridge's own file is handed over to be merged, and each agent's repositories are named.
    const [brainCall, workerCall] = personal.claude.mock.calls.map((c) => c[0])
    expect(brainCall?.arcConfigPath).toMatch(/mcp[\\/]brain-.*\.json$/)
    expect(brainCall?.repoPaths).toEqual(expect.arrayContaining([e.api.path, e.web.path]))
    expect(workerCall?.arcConfigPath).toMatch(/mcp[\\/].*\.json$/)
    expect(workerCall?.arcConfigPath).not.toBe(brainCall?.arcConfigPath)
    expect(workerCall?.repoPaths).toEqual([e.api.path])
    // Whose selection applies (spec 009): the brain's Brain column, the worker's Workers column.
    expect(brainCall?.role).toBe('brain')
    expect(workerCall?.role).toBe('workers')
  })

  it('omits --settings when the user has no hooks', async () => {
    e = await makeEngineRig(dir(), { personal: fakePersonal(false) })
    await e.startSession('autonomous')
    const brain = e.rig.adapter.starts[0]
    expect(brain?.claude.mcpConfigPath).toMatch(/merged-1\.json$/)
    expect(brain?.claude).not.toHaveProperty('hooksSettingsPath')
  })

  it('starts with the bridge config alone when the personal files cannot be written', async () => {
    const warn = vi.fn()
    e = await makeEngineRig(dir(), {
      personal: {
        claude: () => Promise.reject(new Error('disk full')),
        codexMcp: () => Promise.resolve(mcpOf([]))
      },
      log: { info: vi.fn(), warn, error: vi.fn() }
    })
    await e.startSession('autonomous')
    await spawnWorker(e, { model: 'sonnet' })
    await until(() => e!.rig.adapter.starts.some((s) => s.role === 'worker'))
    for (const start of e.rig.adapter.starts) {
      expect(start.claude.mcpConfigPath).toMatch(/mcp[\\/].*\.json$/)
      expect(start.claude).not.toHaveProperty('hooksSettingsPath')
    }
  })

  it('keeps the old launch when there is no personal configuration', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const brain = e.rig.adapter.starts[0]
    expect(brain?.claude.mcpConfigPath).toMatch(/mcp[\\/]brain-.*\.json$/)
    expect(brain?.claude).not.toHaveProperty('hooksSettingsPath')
  })
})

describe('personal MCP servers on Codex launches', () => {
  async function codexRig(personal: PersonalLaunchConfig): Promise<FakeCodexAdapter> {
    const codex = new FakeCodexAdapter()
    const map = (): ProviderStatusMap => ({
      codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
    })
    const models = new ModelRegistry({
      codex: {
        listModels: () =>
          Promise.resolve([{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }])
      },
      status: map
    })
    await models.refresh()
    e = await makeEngineRig(dir(), {
      codexAdapter: codex,
      models,
      providers: { get: map, ensureFresh: () => Promise.resolve(map().codex) },
      personal
    })
    return codex
  }

  it('hands the server names to a Codex worker, read for its own folder', async () => {
    const personal = fakePersonal()
    const codex = await codexRig(personal)
    const sessionId = await e!.startSession('autonomous')
    e!.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    await spawnWorker(e!)
    await until(() => codex.starts.length === 1)
    expect(codex.starts[0]?.codex.personalMcpServers).toEqual(['figma', 'github'])
    const cwd = personal.codexMcp.mock.calls.at(-1)?.[0]
    expect(cwd).toBe(codex.starts[0]?.cwd)
    expect(personal.codexMcp.mock.calls.at(-1)?.[1]).toBe('workers')
    // Codex reads its own config from the real CODEX_HOME: no Claude file is involved.
    expect(personal.claude).toHaveBeenCalledTimes(1) // the Claude brain only
  })

  it('hands the server names to a Codex brain too', async () => {
    const personal = fakePersonal()
    const codex = await codexRig(personal)
    e!.rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
    await e!.rig.service.create(e!.rig.groupId, 'Plan the billing refactor please', 'plan_first', 3)
    await until(() => codex.starts.length === 1)
    expect(codex.starts[0]).toMatchObject({ role: 'brain', access: 'brain-readonly' })
    expect(codex.starts[0]?.codex.personalMcpServers).toEqual(['figma', 'github'])
    expect(personal.codexMcp.mock.calls.at(-1)?.[1]).toBe('brain')
    expect(personal.claude).not.toHaveBeenCalled()
  })

  it('hands the disabled server names to the thread, apart from the ones that run (spec 009)', async () => {
    const personal = fakePersonal()
    personal.codexMcp.mockResolvedValue({
      servers: [{ name: 'github', approvalTools: [] }],
      disabled: ['figma'],
      degraded: false
    })
    const codex = await codexRig(personal)
    const sessionId = await e!.startSession('autonomous')
    e!.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    await spawnWorker(e!)
    await until(() => codex.starts.length === 1)
    expect(codex.starts[0]?.codex).toEqual({
      personalMcpServers: ['github'],
      disabledMcpServers: ['figma']
    })
  })

  it('sends no names when the user has no Codex servers', async () => {
    const personal = fakePersonal()
    personal.codexMcp.mockResolvedValue(mcpOf([]))
    const codex = await codexRig(personal)
    const sessionId = await e!.startSession('autonomous')
    e!.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    await spawnWorker(e!)
    await until(() => codex.starts.length === 1)
    expect(codex.starts[0]?.codex).toEqual({})
  })
})
