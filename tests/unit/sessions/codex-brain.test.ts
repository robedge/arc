import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderHistoryMissingError } from '../../../src/main/agents/agent-adapter'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import type {
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeAdapter, FakeCodexAdapter, makeRig } from './helpers'
import type { FakeHandle, Rig } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-codex-brain-')
let rig: Rig | undefined
let engine: EngineRig | undefined

afterEach(async () => {
  if (engine) await engine.close()
  else {
    await rig?.service.shutdown()
    rig?.close()
  }
  rig = undefined
  engine = undefined
})

const MODELS = [
  { model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true },
  { model: 'gpt-luna', displayName: 'GPT Luna', isDefault: false }
]

interface Setup {
  codex: FakeCodexAdapter
  claude: FakeAdapter
  setState: (state: ProviderState | undefined) => void
  ensureFresh: ReturnType<typeof vi.fn>
}

function statusOf(state: ProviderState | undefined): ProviderStatusMap {
  return state === undefined
    ? {}
    : { codex: { provider: 'codex', state, message: '', checkedAt: 1 } as ProviderStatus }
}

/** A Codex adapter and a status the test can change, wired into a rig. `bridge` adds the real MCP bridge. */
async function setup(
  initial: ProviderState | undefined = 'ok',
  options: { bridge?: boolean } = {}
): Promise<Setup> {
  const codex = new FakeCodexAdapter()
  let state: ProviderState | undefined = initial
  const map = (): ProviderStatusMap => statusOf(state)
  const ensureFresh = vi.fn(() => Promise.resolve(map().codex))
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  await models.refresh()
  const overrides = { codexAdapter: codex, models, providers: { get: map, ensureFresh } }
  if (options.bridge) {
    engine = await makeEngineRig(dir(), overrides)
    rig = engine.rig
  } else {
    rig = await makeRig(dir(), overrides)
  }
  return {
    codex,
    claude: rig.adapter,
    setState: (next) => {
      state = next
    },
    ensureFresh
  }
}

function r(): Rig {
  if (!rig) throw new Error('no rig')
  return rig
}

async function create(request = 'Plan the billing refactor please'): Promise<string> {
  const result = await r().service.create(r().groupId, request, 'plan_first', 3)
  if (!('sessionId' in result)) throw new Error('expected a session id')
  return result.sessionId
}

/** Plays one finished brain reply on a handle. */
async function reply(
  sessionId: string,
  handle: FakeHandle,
  thread: string,
  text: string
): Promise<void> {
  handle.emit({ type: 'session', providerSessionId: thread, model: 'm', mcpServers: [] })
  handle.emit({ type: 'assistant-message', messageId: `m-${text}`, text })
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => r().service.snapshot(sessionId).brainState === 'idle')
}

function useCodexBrain(): void {
  r().appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
}

describe('a brain on Codex', () => {
  it('starts the Codex adapter read-only, in an Arc folder that holds arc.rules', async () => {
    const s = await setup()
    useCodexBrain()
    const sessionId = await create()
    await until(() => s.codex.starts.length === 1)

    const start = s.codex.starts[0]
    expect(start).toMatchObject({
      provider: 'codex',
      role: 'brain',
      access: 'brain-readonly',
      model: 'gpt-deep'
    })
    expect(s.claude.starts).toHaveLength(0)
    expect(start?.approvals).toBeDefined()

    // Not the knowledge folder: that may be a linked folder the user owns.
    const knowledge = join(dir(), 'userData', 'groups', r().groupId, 'knowledge')
    expect(start?.cwd).toBe(join(dir(), 'userData', 'codex-brain', sessionId))
    expect(start?.cwd).not.toBe(knowledge)
    expect(start?.addDirs).toEqual([join(dir(), 'repo-a'), knowledge])
    expect(start?.instructions).toContain(`The group's knowledge folder is ${knowledge}`)
    expect(start?.instructions).toContain('Your sandbox is read-only')
    expect(start?.instructions).not.toContain('(Read, Grep, Glob)')

    const rules = join(start?.cwd ?? '', '.codex', 'rules', 'arc.rules')
    expect(existsSync(rules)).toBe(true)
    expect(readFileSync(rules, 'utf8')).toContain(
      'prefix_rule(pattern=["git","push"], decision="prompt")'
    )
    // The Claude brain's pinned folder is not taken over by the Codex folder.
    expect(r().sessionsRepo.getById(sessionId)?.brainCwd).toBeNull()
  })

  it('removes the Arc folder with the session', async () => {
    const s = await setup()
    useCodexBrain()
    const sessionId = await create()
    await until(() => s.codex.starts.length === 1)
    const folder = s.codex.starts[0]?.cwd ?? ''
    expect(existsSync(folder)).toBe(true)
    await r().service.delete(sessionId)
    expect(existsSync(folder)).toBe(false)
  })

  it('gives the Codex brain the bridge, the bare tool names and the providers block', async () => {
    const s = await setup('ok', { bridge: true })
    useCodexBrain()
    await create()
    await until(() => s.codex.starts.length === 1)
    const start = s.codex.starts[0]
    expect(start?.bridge?.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(start?.bridgeTools).toContain('spawn_worker')
    expect(start?.bridgeTools).not.toContain('request_permission')
    expect(start?.extraEnv).toBeUndefined()
    expect(start?.instructions).toContain('from the `arc` MCP server')
    expect(start?.instructions).not.toContain('ToolSearch')
    expect(start?.instructions).toContain('Providers and models:')
    expect(start?.instructions).toContain('You run on Codex · gpt-deep')
  })

  it('runs on Claude · Sonnet while Codex is not ready, and keeps the stored choice', async () => {
    const s = await setup('signed_out')
    useCodexBrain()
    const sessionId = await create()
    await until(() => s.claude.starts.length === 1)
    expect(s.codex.starts).toHaveLength(0)
    expect(s.claude.starts[0]).toMatchObject({ provider: 'claude', role: 'brain', model: 'sonnet' })
    expect(r().sessionsRepo.getById(sessionId)).toMatchObject({
      brainProvider: 'codex',
      brainModel: 'gpt-deep'
    })
    expect(s.ensureFresh).toHaveBeenCalledWith('codex')
    const events = r()
      .eventsRepo.latest(sessionId, 20)
      .map((e) => e.text)
    expect(events).toContain(
      "Codex isn't signed in, so the brain replies from Claude · Sonnet. Run codex login in Terminal to use Codex."
    )
  })
})

describe('switching the brain between providers', () => {
  it('waits for the reply in progress, then the next reply comes from the Codex model', async () => {
    const s = await setup()
    const sessionId = await create()
    await until(() => s.claude.starts.length === 1)
    const claude = s.claude.last
    claude.delta('partial ', 'm1')
    await until(() => r().service.snapshot(sessionId).brainState === 'thinking')

    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    expect(claude.stopped).toBe(false)

    claude.emit({
      type: 'assistant-message',
      messageId: 'm1',
      text: 'Title: Setup\npartial answer'
    })
    claude.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => claude.stopped)

    await r().service.sendMessage(sessionId, 'second question')
    await until(() => s.codex.starts.length === 1)
    expect(s.codex.starts[0]).toMatchObject({ provider: 'codex', model: 'gpt-deep' })
    expect(s.codex.starts[0]?.resume).toBeUndefined()
  })

  it('starts the other provider fresh with the capped hand-off, then resumes each provider’s own thread', async () => {
    const s = await setup()
    const sessionId = await create('Plan the billing refactor please')
    await until(() => s.claude.starts.length === 1)
    await reply(
      sessionId,
      s.claude.last,
      'claude-thread',
      'Title: Billing\nStart with the invoice model.'
    )
    expect(r().brainThreadsRepo.get(sessionId, 'claude')).toBe('claude-thread')

    // Claude -> Codex: no Codex thread yet, so it starts fresh with the recent conversation.
    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await r().service.sendMessage(sessionId, 'what about taxes?')
    await until(() => s.codex.starts.length === 1)
    expect(s.codex.resumes).toHaveLength(0)
    const codex1 = s.codex.handles[0] as FakeHandle
    await until(() => codex1.sent.length === 1)
    const first = codex1.sent[0] ?? ''
    expect(first).toContain('[Arc] The user changed the brain model')
    expect(first).toContain('User: Plan the billing refactor please')
    expect(first).toContain('Brain: Start with the invoice model.')
    expect(first.endsWith('\n\nwhat about taxes?')).toBe(true)
    // The question being sent is the turn itself, not part of the history.
    expect(first.split('what about taxes?')).toHaveLength(2)
    expect(first.length).toBeLessThan(6500)
    await reply(sessionId, codex1, 'codex-thread', 'Taxes go on the invoice lines.')
    expect(r().brainThreadsRepo.get(sessionId, 'codex')).toBe('codex-thread')
    expect(codex1.sent).toHaveLength(1)

    // Codex -> Claude: resumes the Claude thread, with no hand-off.
    r().service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'sonnet' } })
    await r().service.sendMessage(sessionId, 'back to you')
    await until(() => s.claude.starts.length === 2)
    expect(codex1.stopped).toBe(true)
    expect(s.claude.starts[1]).toMatchObject({
      provider: 'claude',
      resume: { threadId: 'claude-thread' }
    })
    const claude2 = s.claude.last
    await until(() => claude2.sent.length === 1)
    expect(claude2.sent).toEqual(['back to you'])
    await reply(sessionId, claude2, 'claude-thread', 'Welcome back.')

    // Claude -> Codex again: resumes the Codex thread, not the Claude one.
    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await r().service.sendMessage(sessionId, 'and again')
    await until(() => s.codex.starts.length === 2)
    expect(s.codex.resumes).toHaveLength(1)
    expect(s.codex.resumes[0]?.resume).toEqual({ threadId: 'codex-thread' })
    const codex2 = s.codex.handles[1] as FakeHandle
    await until(() => codex2.sent.length === 1)
    expect(codex2.sent).toEqual(['and again'])
  })

  it('starts fresh with the recent messages, and logs it, when the Codex thread is gone', async () => {
    const s = await setup()
    const sessionId = await create('Plan the billing refactor please')
    await until(() => s.claude.starts.length === 1)
    await reply(sessionId, s.claude.last, 'claude-thread', 'Title: Billing\nStart with invoices.')
    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await r().service.sendMessage(sessionId, 'what about taxes?')
    await until(() => s.codex.starts.length === 1)
    await reply(sessionId, s.codex.handles[0] as FakeHandle, 'codex-thread', 'Taxes per line.')
    r().service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'sonnet' } })
    await r().service.sendMessage(sessionId, 'back to you')
    await until(() => s.claude.starts.length === 2)
    await reply(sessionId, s.claude.last, 'claude-thread', 'Welcome back.')

    // The Codex history was deleted meanwhile.
    s.codex.failResumeWith = new ProviderHistoryMissingError('codex', 'codex-thread', 'gone')
    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await r().service.sendMessage(sessionId, 'and again')

    await until(() => s.codex.starts.length === 2)
    expect(s.codex.resumes).toHaveLength(0)
    expect(s.codex.starts[1]?.resume).toBeUndefined()
    const fresh = s.codex.handles[1] as FakeHandle
    await until(() => fresh.sent.length === 1)
    const first = fresh.sent[0] ?? ''
    expect(first).toContain('[Arc] Your earlier conversation is no longer available')
    expect(first).not.toContain('The user changed the brain model')
    expect(first).toContain('User: Plan the billing refactor please')
    expect(first).toContain('Brain: Welcome back.')
    expect(first.endsWith('\n\nand again')).toBe(true)
    expect(
      r()
        .eventsRepo.latest(sessionId, 50)
        .map((x) => x.text)
    ).toContain("The brain's Codex history is gone, so it starts fresh from the recent messages.")
    // The new thread replaces the lost one.
    await reply(sessionId, fresh, 'codex-thread-2', 'Fresh start.')
    expect(r().brainThreadsRepo.get(sessionId, 'codex')).toBe('codex-thread-2')
  })

  it('changes the model inside Codex without a restart', async () => {
    const s = await setup()
    useCodexBrain()
    const sessionId = await create()
    await until(() => s.codex.starts.length === 1)
    const handle = s.codex.handles[0] as FakeHandle
    await reply(sessionId, handle, 'codex-thread', 'Title: Billing\nReady.')

    r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-luna' } })
    await r().service.sendMessage(sessionId, 'next')
    await until(() => handle.sent.length === 2)
    expect(handle.models).toEqual(['gpt-luna'])
    expect(handle.stopped).toBe(false)
    expect(s.codex.starts).toHaveLength(1)
    expect(handle.sent[1]).toBe('next')

    // The same model again changes nothing.
    await reply(sessionId, handle, 'codex-thread', 'Done.')
    await r().service.sendMessage(sessionId, 'once more')
    await until(() => handle.sent.length === 3)
    expect(handle.models).toEqual(['gpt-luna'])
  })

  it('refuses a Codex model the provider does not list', async () => {
    await setup()
    const sessionId = await create()
    expect(() =>
      r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-nope' } })
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    expect(() =>
      r().service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-luna' } })
    ).not.toThrow()
    expect(r().sessionsRepo.getById(sessionId)).toMatchObject({
      brainProvider: 'codex',
      brainModel: 'gpt-luna'
    })
  })
})
