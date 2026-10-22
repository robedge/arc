import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorBrainDenyText } from '../../../src/main/agents/cursor/cursor-deny'
import { cursorModeFor } from '../../../src/main/agents/cursor/cursor-config'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V6
} from '../../../src/main/sessions/orchestrator'
import type { PersonalLaunchConfig } from '../../../src/main/personal/personal-config'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import type {
  ProviderState,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { approvalRequests } from '../agents/cursor/fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeCursorAdapter } from './helpers'
import { ProviderHistoryMissingError } from '../../../src/main/agents/agent-adapter'
import type { FakeHandle } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-cursor-brain-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const MODELS = mapCursorModels([
  { modelId: 'default[]', name: 'Auto' },
  { modelId: 'gpt-5.4[reasoning=medium]', name: 'gpt-5.4' }
])
const AUTO = 'default[]'
const GPT = 'gpt-5.4[reasoning=medium]'

async function setup(
  initial: ProviderState = 'ok',
  personal?: PersonalLaunchConfig
): Promise<{ cursor: FakeCursorAdapter }> {
  const cursor = new FakeCursorAdapter()
  const map = (): ProviderStatusMap => ({
    cursor: { provider: 'cursor', state: initial, message: '', checkedAt: 1 } as ProviderStatus
  })
  const models = new ModelRegistry({
    cursor: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  await models.refresh()
  e = await makeEngineRig(dir(), {
    cursorAdapter: cursor,
    models,
    providers: { get: map, ensureFresh: vi.fn(() => Promise.resolve(map().cursor)) },
    ...(personal ? { personal } : {})
  })
  return { cursor }
}

function useCursorBrain(model = AUTO): void {
  e?.rig.appSettingsRepo.set('providers.brain', { provider: 'cursor', model }, 1)
}

async function create(): Promise<string> {
  const result = await e!.rig.service.create(
    e!.rig.groupId,
    'Plan the billing refactor please',
    'plan_first',
    3
  )
  if (!('sessionId' in result)) throw new Error('expected a session id')
  return result.sessionId
}

async function startCursorSession(cursor: FakeCursorAdapter): Promise<string> {
  const sessionId = await create()
  await until(() => cursor.starts.length === 1)
  return sessionId
}

describe('a brain on Cursor, session from before version 6', () => {
  it('sends the version 6 note in front of the next prompt once, then stamps the session', async () => {
    const { cursor } = await setup()
    useCursorBrain()
    const sessionId = await startCursorSession(cursor)
    ;(cursor.handles[0] as FakeHandle).emit({
      type: 'session',
      providerSessionId: 'cursor-session-1',
      model: AUTO,
      mcpServers: []
    })
    await until(() => e!.rig.brainThreadsRepo.get(sessionId, 'cursor') === 'cursor-session-1')
    e!.rig.sessionsRepo.setBrainPromptVersion(sessionId, 5)
    await e!.rig.service.shutdown()
    await e!.rig.service.sendMessage(sessionId, 'and then?')
    await until(() => cursor.resumes.length === 1)
    const brain = cursor.handles.at(-1) as FakeHandle
    await until(() => brain.sent.length > 0)
    const note = brain.sent[0] ?? ''
    expect(note.startsWith(PROMPT_UPDATE_NOTE_V6)).toBe(true)
    expect(note).toContain(
      '- Cursor models: Auto (default[]), gpt-5.4 · medium (gpt-5.4[reasoning=medium])'
    )
    expect(note.endsWith('\n\nand then?')).toBe(true)
    expect(e!.rig.sessionsRepo.getById(sessionId)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
    await e!.rig.service.sendMessage(sessionId, 'again')
    await until(() => brain.sent.length > 1)
    expect(brain.sent[1]).toBe('again')
  })
})

describe('a brain on Cursor', () => {
  it('starts in the Arc brain folder in mode ask, with the paths named and a Write(**) deny file', async () => {
    const { cursor } = await setup()
    useCursorBrain(GPT)
    const sessionId = await startCursorSession(cursor)

    const start = cursor.starts[0]
    expect(start).toMatchObject({
      provider: 'cursor',
      role: 'brain',
      access: 'brain-readonly',
      model: GPT
    })
    // Mode `ask` is what the adapter sets for a read-only agent (spike M2).
    expect(cursorModeFor('brain-readonly')).toBe('ask')
    expect(cursorModeFor('worker-write')).toBe('agent')

    const knowledge = join(dir(), 'userData', 'groups', e!.rig.groupId, 'knowledge')
    expect(start?.cwd).toBe(join(dir(), 'userData', 'codex-brain', sessionId))
    expect(start?.cwd).not.toBe(knowledge)
    expect(start?.instructions).toContain(`The group's knowledge folder is ${knowledge}`)
    expect(start?.instructions).toContain(join(dir(), 'repo-a'))
    expect(start?.cursor.approvals).toBeDefined()
    expect(start?.bridge?.url).toMatch(/^http:\/\/127\.0\.0\.1:/)

    const file = join(start?.cwd ?? '', '.cursor', 'cli.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      permissions: { allow: [], deny: ['Write(**)'] }
    })
    expect(readFileSync(file, 'utf8')).toBe(cursorBrainDenyText())
    // The Claude brain's pinned folder is not taken over.
    expect(e!.rig.sessionsRepo.getById(sessionId)?.brainCwd).toBeNull()
  })

  it('stores the Cursor session id in brain_threads', async () => {
    const { cursor } = await setup()
    useCursorBrain()
    const sessionId = await startCursorSession(cursor)
    ;(cursor.handles[0] as FakeHandle).emit({
      type: 'session',
      providerSessionId: 'cursor-session-1',
      model: AUTO,
      mcpServers: []
    })
    await until(() => e!.rig.brainThreadsRepo.get(sessionId, 'cursor') === 'cursor-session-1')
  })

  it('changes the model without a restart', async () => {
    const { cursor } = await setup()
    useCursorBrain(AUTO)
    const sessionId = await startCursorSession(cursor)
    const handle = cursor.handles[0] as FakeHandle
    handle.emit({ type: 'session', providerSessionId: 'c1', model: AUTO, mcpServers: [] })
    handle.emit({ type: 'assistant-message', messageId: 'm1', text: 'Title: Billing\nReady.' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => e!.rig.service.snapshot(sessionId).brainState === 'idle')

    e!.rig.service.setConfig(sessionId, { brainModel: { provider: 'cursor', model: GPT } })
    await e!.rig.service.sendMessage(sessionId, 'next')
    await until(() => handle.models.length === 1)
    expect(handle.models).toEqual([GPT])
    expect(handle.stopped).toBe(false)
    expect(cursor.starts).toHaveLength(1)
  })

  it('falls back to Claude while Cursor is not ready and starts no Cursor process', async () => {
    const { cursor } = await setup('signed_out')
    useCursorBrain()
    const sessionId = await create()
    await until(() => e!.rig.adapter.starts.length === 1)
    expect(cursor.starts).toHaveLength(0)
    expect(e!.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      "Cursor isn't signed in, so the brain replies from Claude · Sonnet. Run agent login in Terminal to use Cursor."
    )
    expect(e!.rig.service.snapshot(sessionId).header.brainRunningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'cursor',
      fallbackReason: "Cursor isn't signed in. Run agent login in Terminal to use Cursor."
    })
    expect(e!.rig.sessionsRepo.getById(sessionId)).toMatchObject({ brainProvider: 'cursor' })
  })
})

describe('the Cursor brain approvals (spike M2 requests)', () => {
  type Request = ReturnType<typeof approvalRequests>[number]

  async function handler(): Promise<(r: Request) => Promise<unknown>> {
    const { cursor } = await setup()
    useCursorBrain()
    await startCursorSession(cursor)
    const approvals = cursor.starts[0]?.cursor.approvals
    if (!approvals) throw new Error('no approvals')
    return (r) => approvals.handle(r, new AbortController().signal)
  }

  it('allows the arc echo call and the read-only git status the model ran in ask mode', async () => {
    const handle = await handler()
    const [echo, status] = approvalRequests('m2-ask-mode-turn.jsonl')
    expect(echo?.title).toBe('arc-echo: echo')
    expect(status?.title).toBe('`git status`')
    await expect(handle(echo!)).resolves.toEqual({ decision: 'allow' })
    await expect(handle(status!)).resolves.toEqual({ decision: 'allow' })
  })

  it('refuses an edit with the brain reason, even if Cursor were to ask', async () => {
    const handle = await handler()
    const [, status] = approvalRequests('m2-ask-mode-turn.jsonl')
    const edit = {
      ...status!,
      kind: 'edit',
      title: 'Edit `notes.txt`',
      tool: { ...status!.tool!, kind: 'edit', rawInput: { path: '/x/notes.txt' } }
    }
    const decision = await handle(edit)
    expect(decision).toMatchObject({ decision: 'reject' })
    expect(JSON.stringify(decision)).toContain('The brain cannot use')
  })
})

describe('a Cursor brain whose session Cursor no longer has', () => {
  it('starts fresh from the recent messages, and says it was the Cursor history', async () => {
    const { cursor } = await setup()
    useCursorBrain()
    const sessionId = await startCursorSession(cursor)
    ;(cursor.handles[0] as FakeHandle).emit({
      type: 'session',
      providerSessionId: 'cursor-session-1',
      model: AUTO,
      mcpServers: []
    })
    await until(() => e!.rig.brainThreadsRepo.get(sessionId, 'cursor') === 'cursor-session-1')
    await e!.rig.service.shutdown()
    // session/load answered -32602 "not found" (spike N4).
    cursor.failResumeWith = new ProviderHistoryMissingError(
      'cursor',
      'cursor-session-1',
      'Session "cursor-session-1" not found'
    )

    await e!.rig.service.sendMessage(sessionId, 'and then?')

    await until(() => cursor.starts.length === 2)
    expect(cursor.resumes).toHaveLength(0)
    expect(cursor.starts[1]?.resume).toBeUndefined()
    const fresh = cursor.handles[1] as FakeHandle
    await until(() => fresh.sent.length > 0)
    expect(fresh.sent[0]).toContain('[Arc] Your earlier conversation is no longer available')
    expect(e!.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      "The brain's Cursor history is gone, so it starts fresh from the recent messages."
    )
  })
})

describe('the user Cursor servers switched off for the Brain', () => {
  it('gives the brain the no-op entries and deny entries of its own role only', async () => {
    const personal: PersonalLaunchConfig = {
      claude: () => Promise.reject(new Error('no claude here')),
      codexMcp: () => Promise.resolve({ servers: [], degraded: false }),
      cursorMcp: (_cwd, role) =>
        Promise.resolve({
          servers: ['github', 'linear'],
          off: role === 'brain' ? ['linear'] : ['github'],
          degraded: false
        })
    }
    const { cursor } = await setup('ok', personal)
    useCursorBrain()
    await startCursorSession(cursor)
    const start = cursor.starts[0]
    expect(start?.cursor.offMcpServers).toEqual(['linear'])
    const deny = JSON.parse(
      readFileSync(join(start?.cwd ?? '', '.cursor', 'cli.json'), 'utf8')
    ) as {
      permissions: { deny: string[] }
    }
    expect(deny.permissions.deny).toEqual(['Write(**)', 'Mcp(linear:*)'])
  })
})
