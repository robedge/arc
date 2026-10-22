import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import { CodexCommands } from '../../../src/main/agents/codex/codex-commands'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { matchCommand } from '../../../src/main/sessions/command-routing'
import { CODEX_SLASH_LINE } from '../../../src/main/sessions/typed-slash'
import { workerLabel } from '../../../src/main/sessions/worker-label'
import type { CommandInfo } from '../../../src/shared/types/commands'
import type {
  ProviderId,
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { CursorCommands } from '../../../src/main/agents/cursor/cursor-commands'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import { FakeCodexAdapter, FakeCursorAdapter } from './helpers'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-command-provider-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

function claudeCommand(name: string, source: CommandInfo['source'] = 'user'): CommandInfo {
  return {
    id: `claude:${name}`,
    name,
    description: name,
    source,
    provider: 'claude',
    kind: 'command'
  }
}

describe('matchCommand', () => {
  const claudeReview = claudeCommand('review')
  const codexReview: CommandInfo = {
    id: 'codex:review',
    name: 'review',
    description: 'Review',
    source: 'codex',
    provider: 'codex',
    kind: 'prompt'
  }
  const codexPlugin = claudeCommand('codex:rescue', 'plugin:codex')

  it('takes the provider from the entry a /name finds', () => {
    expect(matchCommand('/user-only now', [claudeCommand('user-only')])).toMatchObject({
      ok: true,
      provider: 'claude',
      text: '/user-only now'
    })
    expect(matchCommand('/review', [codexReview])).toMatchObject({
      ok: true,
      provider: 'codex'
    })
  })

  it('returns both ids when the name exists for both providers', () => {
    expect(matchCommand('/review x', [claudeReview, codexReview])).toEqual({
      ok: false,
      reason: 'ambiguous',
      name: 'review',
      ids: ['claude:review', 'codex:review']
    })
  })

  it('accepts codex:name and claude:name and writes the command as /name args', () => {
    const both = [claudeReview, codexReview]
    expect(matchCommand('codex:review BRANCH=a', both)).toMatchObject({
      ok: true,
      provider: 'codex',
      text: '/review BRANCH=a'
    })
    expect(matchCommand('claude:review', both)).toMatchObject({ ok: true, provider: 'claude' })
    expect(matchCommand('/codex:review', both)).toMatchObject({ ok: true, provider: 'codex' })
  })

  it('keeps a Claude plugin that is called codex working', () => {
    expect(matchCommand('/codex:rescue fix it', [codexPlugin, codexReview])).toMatchObject({
      ok: true,
      provider: 'claude',
      name: 'codex:rescue'
    })
  })

  it('does not know a name without a slash or an id', () => {
    expect(matchCommand('review', [claudeReview])).toMatchObject({ ok: false, reason: 'unknown' })
    expect(matchCommand('/nope', [claudeReview])).toMatchObject({ ok: false, reason: 'unknown' })
  })
})

const okStatus = (state: ProviderState): ProviderStatusMap => ({
  codex: { provider: 'codex', state, message: '', checkedAt: 1 } as ProviderStatus
})

interface Rig {
  e: EngineRig
  codex: FakeCodexAdapter
  sessionId: string
}

/**
 * A session over a real Codex command list: the skill `publish-release`, the prompts `review`
 * (needs BRANCH=) and `deploy`, and the Claude commands `user:lint` and `review`.
 */
async function rigWith(workers: ProviderId, claudeReview = false): Promise<Rig> {
  const home = dir()
  mkdirSync(join(home, 'prompts'), { recursive: true })
  writeFileSync(
    join(home, 'prompts', 'review.md'),
    '---\ndescription: Review a branch\nargument-hint: BRANCH=<name>\n---\nReview $BRANCH. Notes: $ARGUMENTS'
  )
  writeFileSync(join(home, 'prompts', 'deploy.md'), 'Deploy $1 to $2.')
  const status = (): ProviderStatusMap => okStatus('ok')
  const codexCommands = new CodexCommands({
    skills: {
      listSkills: () =>
        Promise.resolve([
          {
            name: 'publish-release',
            description: 'Publish',
            path: '/skills/publish-release/SKILL.md',
            scope: 'user'
          }
        ])
    },
    status,
    codexHome: () => home
  })
  const list = vi.fn<CommandCatalogue['list']>(async (request) => [
    claudeCommand('user:lint'),
    ...(claudeReview ? [claudeCommand('review')] : []),
    ...(await codexCommands.list(request.repos.map((r) => r.path)))
  ])
  const codex = new FakeCodexAdapter()
  const models = new ModelRegistry({
    codex: {
      listModels: () =>
        Promise.resolve([{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }])
    },
    status
  })
  e = await makeEngineRig(dir(), {
    codexAdapter: codex,
    models,
    providers: {
      get: status,
      ensureFresh: () => Promise.resolve(status().codex as ProviderStatus)
    },
    commands: { list },
    codexCommands
  })
  const sessionId = await e.startSession('autonomous')
  e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: workers } })
  return { e, codex, sessionId }
}

function spawn(r: Rig, command: string): ReturnType<EngineRig['call']> {
  return r.e.call(r.e.brain(), 'spawn_worker', {
    name: 'cmd',
    task: 'Run the command',
    repos: ['api'],
    command
  })
}

const rowOf = (
  r: Rig
): ReturnType<Rig['e']['rig']['deps']['workersRepo']['listBySession']>[number] =>
  r.e.rig.deps.workersRepo.listBySession(r.sessionId)[0] as never

describe('a command forces its provider', () => {
  it('runs a Codex skill in a Codex worker although Workers is Claude, as a skill input', async () => {
    const r = await rigWith('claude')
    const result = await spawn(r, '/publish-release v2')
    expect(result).toMatchObject({
      isError: false,
      value: { status: 'started', provider: 'codex' }
    })
    await until(() => r.codex.handles.length === 1)
    const worker = r.codex.handles[0] as FakeHandle
    await until(() => worker.inputs.length === 1)
    expect(worker.inputs[0]).toEqual([
      { type: 'skill', name: 'publish-release', path: '/skills/publish-release/SKILL.md' },
      { type: 'text', text: 'v2' }
    ])
    expect(worker.sent).toEqual([])
    expect(rowOf(r)).toMatchObject({ provider: 'codex', command: '/publish-release v2' })
    expect(workerLabel(rowOf(r))).toBe('W1 · /publish-release')
    expect(r.e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(0)
  })

  it('runs a Codex prompt in a Codex worker, expanded by Arc and sent as plain text', async () => {
    const r = await rigWith('claude')
    const result = await spawn(r, '/review BRANCH=main check the tests')
    expect(result).toMatchObject({ isError: false, value: { provider: 'codex' } })
    await until(() => r.codex.handles.length === 1)
    const worker = r.codex.handles[0] as FakeHandle
    await until(() => worker.sent.length === 1)
    expect(worker.sent[0]).toBe('Review main. Notes: check the tests')
    expect(workerLabel(rowOf(r))).toBe('W1 · /review')
  })

  it('runs a Claude command in a Claude worker although Workers is Codex', async () => {
    const r = await rigWith('codex')
    const result = await spawn(r, '/user:lint src')
    expect(result).toMatchObject({ isError: false, value: { provider: 'claude' } })
    await until(() => r.e.rig.adapter.handles.some((h) => h.agentId.startsWith('worker-')))
    const worker = r.e.workerHandle()
    await until(() => worker.sent.length === 1)
    expect(worker.sent[0]).toBe('/user:lint src')
    expect(r.codex.handles).toHaveLength(0)
    expect(rowOf(r)).toMatchObject({ provider: 'claude' })
  })

  it('refuses an ambiguous /name with both ids, and runs codex:name and claude:name', async () => {
    const r = await rigWith('claude', true)
    const ambiguous = await spawn(r, '/review BRANCH=main')
    expect(ambiguous).toMatchObject({ isError: true, value: { error: 'ambiguous_command' } })
    expect(String(ambiguous.value['message'])).toContain('claude:review and codex:review')
    expect(r.e.rig.deps.workersRepo.listBySession(r.sessionId)).toHaveLength(0)

    const codexRun = await spawn(r, 'codex:review BRANCH=main')
    expect(codexRun).toMatchObject({ isError: false, value: { provider: 'codex' } })
    expect(rowOf(r).command).toBe('/review BRANCH=main')
    const claudeRun = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'other',
      task: 'Run the command',
      repos: ['api'],
      command: 'claude:review'
    })
    expect(claudeRun).toMatchObject({ isError: false, value: { provider: 'claude' } })
  })

  it('refuses a Codex prompt that lacks a required argument instead of sending it half expanded', async () => {
    const r = await rigWith('claude')
    const result = await spawn(r, '/review just words')
    expect(result).toMatchObject({ isError: true, value: { error: 'command_args_invalid' } })
    expect(String(result.value['message'])).toContain('BRANCH=value')
    expect(r.e.rig.deps.workersRepo.listBySession(r.sessionId)).toHaveLength(0)
    expect(r.codex.handles).toHaveLength(0)
  })
})

describe('the brain is told to disambiguate a name both providers have', () => {
  it('adds an ask_user instruction listing both ids', async () => {
    const r = await rigWith('claude', true)
    const brain = r.e.brain()
    const before = brain.sent.length
    await r.e.rig.service.sendMessage(r.sessionId, '/review BRANCH=main')
    await until(() => brain.sent.length > before)
    const sent = brain.sent.at(-1) ?? ''
    expect(sent).toContain('claude:review and codex:review')
    expect(sent).toContain('ask_user')
  })
})

describe('a typed /skill on a stepped-in Codex worker', () => {
  async function steppedIn(): Promise<{ r: Rig; worker: FakeHandle; workerId: string }> {
    const r = await rigWith('codex')
    const started = await spawn(r, '/publish-release v1')
    const workerId = String(started.value['workerId'])
    await until(() => r.codex.handles.length === 1)
    const worker = r.codex.handles[0] as FakeHandle
    worker.emit({
      type: 'session',
      providerSessionId: 'thread-7',
      model: 'gpt-deep',
      mcpServers: []
    })
    await until(() => r.e.rig.deps.workersRepo.get(workerId)?.status === 'working')
    await r.e.rig.service.stepInWorker(workerId)
    return { r, worker, workerId }
  }

  it('becomes a skill input with the rest of the line as its text', async () => {
    const { r, worker, workerId } = await steppedIn()
    await r.e.rig.service.sendWorkerInput(workerId, '/publish-release v3 --dry')
    expect(worker.inputs.at(-1)).toEqual([
      { type: 'skill', name: 'publish-release', path: '/skills/publish-release/SKILL.md' },
      { type: 'text', text: 'v3 --dry' }
    ])
    expect(worker.sent).not.toContain('/publish-release v3 --dry')
  })

  it('still answers any other slash line in the terminal and sends plain text as text', async () => {
    const { r, worker, workerId } = await steppedIn()
    const inputs = worker.inputs.length
    await r.e.rig.service.sendWorkerInput(workerId, '/nope now')
    let log = ''
    for (let i = 0; i < 100 && !log.includes(CODEX_SLASH_LINE); i++) {
      log = (await r.e.rig.service.openTerminal(workerId)).backlog
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(log).toContain(CODEX_SLASH_LINE)
    expect(worker.sent).not.toContain('/nope now')
    await r.e.rig.service.sendWorkerInput(workerId, 'carry on')
    expect(worker.sent).toContain('carry on')
    expect(worker.inputs).toHaveLength(inputs)
  })
})

// ---- Cursor commands (spec 010, tech spec 2.9) ----

interface CursorRig {
  e: EngineRig
  cursor: FakeCursorAdapter
  sessionId: string
  state: { value: ProviderState }
  home: string
}

/** A session whose command list holds the Cursor command `shout` (a file in the user's ~/.cursor/commands). */
async function cursorRigWith(
  workers: ProviderId,
  initial: ProviderState = 'ok'
): Promise<CursorRig> {
  const home = dir()
  mkdirSync(join(home, '.cursor', 'commands'), { recursive: true })
  writeFileSync(join(home, '.cursor', 'commands', 'shout.md'), 'Reply in upper case.')
  const state = { value: initial }
  const status = (): ProviderStatusMap => ({
    cursor: { provider: 'cursor', state: state.value, message: '', checkedAt: 1 } as ProviderStatus
  })
  const cursorCommands = new CursorCommands({
    probe: { lastCommands: () => [{ name: 'shout', description: 'Shout it (global)' }] },
    status,
    home: () => home
  })
  const list = vi.fn<CommandCatalogue['list']>(async (request) => [
    claudeCommand('user:lint'),
    ...(await cursorCommands.list(request.repos.map((r) => r.path)))
  ])
  const cursor = new FakeCursorAdapter()
  const models = new ModelRegistry({
    cursor: {
      listModels: () => Promise.resolve(mapCursorModels([{ modelId: 'default[]', name: 'Auto' }]))
    },
    status
  })
  await models.refresh()
  e = await makeEngineRig(dir(), {
    cursorAdapter: cursor,
    models,
    providers: {
      get: status,
      ensureFresh: () => Promise.resolve(status().cursor as ProviderStatus)
    },
    commands: { list },
    cursorCommands
  })
  const sessionId = await e.startSession('autonomous')
  e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: workers } })
  return { e, cursor, sessionId, state, home }
}

describe('a Cursor command forces a Cursor worker', () => {
  it.each<ProviderId>(['claude', 'codex'])(
    'runs in a Cursor worker labelled with it although Workers is %s, sent as the expanded command file',
    async (workers) => {
      const r = await cursorRigWith(workers)
      const result = await r.e.call(r.e.brain(), 'spawn_worker', {
        name: 'cmd',
        task: 'Run the command',
        repos: ['api'],
        command: '/shout banana'
      })
      expect(result).toMatchObject({
        isError: false,
        value: { status: 'started', provider: 'cursor' }
      })
      await until(() => r.cursor.handles.length === 1)
      const worker = r.cursor.handles[0] as FakeHandle
      await until(() => worker.sent.length === 1)
      // Arc expands the command file itself; the worker never gets a bare slash command.
      expect(worker.sent[0]).toBe(
        'Running the Cursor command /shout.\n\nReply in upper case.\n\nArguments: banana'
      )
      expect(worker.inputs).toEqual([])
      const row = r.e.rig.deps.workersRepo.listBySession(r.sessionId)[0] as never as Parameters<
        typeof workerLabel
      >[0]
      expect(row).toMatchObject({ provider: 'cursor', command: '/shout banana' })
      expect(workerLabel(row)).toBe('W1 · /shout')
      expect(r.e.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))).toHaveLength(0)
    }
  )

  it('fails the worker with the reason, and sends nothing, when the command file cannot be read', async () => {
    const r = await cursorRigWith('claude')
    const args = { name: 'cmd', task: 'Run the command', repos: ['api'] }
    // The first spawn lists (and caches) the commands; the file is gone by the second worker's start.
    expect(
      await r.e.call(r.e.brain(), 'spawn_worker', { ...args, command: '/shout a' })
    ).toMatchObject({ isError: false })
    await until(() => r.cursor.handles.length === 1)
    rmSync(join(r.home, '.cursor', 'commands', 'shout.md'))
    const second = await r.e.call(r.e.brain(), 'spawn_worker', {
      ...args,
      name: 'cmd2',
      command: '/shout b'
    })
    expect(second).toMatchObject({ isError: true, value: { error: 'start_failed' } })
    expect(JSON.stringify(second)).toContain('Arc could not read')
    for (const handle of r.cursor.handles) {
      for (const sent of (handle as FakeHandle).sent) expect(sent).not.toMatch(/^\/shout/)
    }
  })

  it('accepts cursor:shout as the command and stores /shout args', async () => {
    const r = await cursorRigWith('claude')
    const result = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'cmd',
      task: 'Run the command',
      repos: ['api'],
      command: 'cursor:shout apple'
    })
    expect(result).toMatchObject({ isError: false, value: { provider: 'cursor' } })
    const [row] = r.e.rig.deps.workersRepo.listBySession(r.sessionId)
    expect(row?.command).toBe('/shout apple')
  })

  it('tells the brain to start a worker when /shout banana is typed in the message box', async () => {
    const r = await cursorRigWith('claude')
    const brain = r.e.brain()
    const before = brain.sent.length
    await r.e.rig.service.sendMessage(r.sessionId, '/shout banana')
    await until(() => brain.sent.length > before)
    expect(brain.sent.at(-1) ?? '').toContain('spawn_worker(command: "/shout banana")')
  })

  it('does not know the command while Cursor is not ok', async () => {
    const r = await cursorRigWith('claude', 'signed_out')
    const result = await r.e.call(r.e.brain(), 'spawn_worker', {
      name: 'cmd',
      task: 'Run the command',
      repos: ['api'],
      command: '/shout banana'
    })
    expect(result).toMatchObject({ isError: true, value: { error: 'unknown_command' } })
    expect(r.cursor.handles).toHaveLength(0)
  })
})
