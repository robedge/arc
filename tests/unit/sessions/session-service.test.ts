import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppErrorException } from '../../../src/shared/errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V2,
  PROMPT_UPDATE_NOTE_V3,
  promptUpdateNote,
  buildBrainPrompt,
  deriveName,
  resolveBrainModel,
  splitTitle
} from '../../../src/main/sessions/orchestrator'
import { SUMMARY_PUSH_MS } from '../../../src/main/sessions/session-service'
import type { ModelRef } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-sessions-')
let rig: Rig

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  rig.close()
  vi.useRealTimers()
})

/** Lets the orchestrator's event loop and queued sends run. */
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

async function start(request = 'Plan the billing refactor please'): Promise<string> {
  const result = await rig.service.create(rig.groupId, request, 'plan_first', 3)
  if (!('sessionId' in result)) throw new Error('expected a session id')
  await settle()
  return result.sessionId
}

/** Runs the first reply (with its Title line) to the end, so later replies stream without hold-back. */
async function startPastTitle(): Promise<string> {
  const sessionId = await start()
  const brain = rig.adapter.last
  brain.emit({ type: 'assistant-message', messageId: 'm0', text: 'Title: Setup\nReady.' })
  brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await settle(200)
  rig.pushed.length = 0
  return sessionId
}

describe('create', () => {
  it('stores the session and the first user message, and starts the brain with the group context', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const snapshot = rig.service.snapshot(sessionId)
    expect(snapshot.header).toMatchObject({
      name: 'New session',
      mode: 'plan_first',
      workerLimit: 3,
      model: 'auto',
      status: 'active'
    })
    expect(snapshot.messages.map((m) => [m.role, m.content, m.state])).toEqual([
      ['user', 'Plan the billing refactor please', 'complete']
    ])
    expect(snapshot.workers).toEqual([])
    expect(snapshot.attention).toEqual([])
    expect(snapshot.brainState).toBe('thinking')

    const start1 = rig.adapter.starts[0]
    expect(start1).toMatchObject({ role: 'brain', model: 'sonnet' })
    expect(start1?.cwd).toBe(`${dir()}/userData/groups/${rig.groupId}/knowledge`)
    expect(start1?.addDirs).toEqual([`${dir()}/repo-a`])
    expect(start1?.instructions).toContain('[arc-role:brain]')
    expect(start1?.instructions).toContain('Title: <3-6 word title')
    expect(start1?.instructions).toContain('Alpha')
    expect(start1?.instructions).toContain(`${dir()}/repo-a`)
    expect(rig.adapter.last.sent).toEqual(['Plan the billing refactor please'])
  })

  it('skips project folders that no longer exist', async () => {
    rig = await makeRig(dir(), { directoryExists: () => false })
    await start()
    expect(rig.adapter.starts[0]?.addDirs).toEqual([])
  })

  it('persists nothing and returns CLI_UNAVAILABLE when Claude Code is not ok after a re-check', async () => {
    rig = await makeRig(dir(), { cliStatus: undefined })
    rig.recheck.mockResolvedValue({ state: 'missing', message: 'gone' })
    await expect(rig.service.create(rig.groupId, 'hello', 'autonomous', 2)).rejects.toMatchObject({
      code: 'CLI_UNAVAILABLE'
    })
    expect(rig.recheck).toHaveBeenCalledTimes(1)
    expect(rig.service.list(rig.groupId)).toEqual([])
    expect(rig.opened.sqlite.prepare('select count(*) as n from messages').get()).toEqual({ n: 0 })
    expect(rig.adapter.starts).toHaveLength(0)
  })

  it('goes ahead when the re-check finds Claude Code ok', async () => {
    rig = await makeRig(dir(), { cliStatus: undefined })
    await start()
    expect(rig.recheck).toHaveBeenCalledTimes(1)
    expect(rig.adapter.starts).toHaveLength(1)
  })

  it('rejects a blank request', async () => {
    rig = await makeRig(dir())
    await expect(rig.service.create(rig.groupId, '   ', 'plan_first', 3)).rejects.toBeInstanceOf(
      AppErrorException
    )
  })
})

describe('streaming', () => {
  it('coalesces deltas into one push per 50 ms with an increasing seq', async () => {
    rig = await makeRig(dir())
    const sessionId = await startPastTitle()
    const brain = rig.adapter.last
    for (let i = 0; i < 12; i++) {
      brain.delta(`w${i} `)
      await settle(3)
    }
    expect(rig.of('session:brain-delta')).toHaveLength(0)
    await settle(50)
    const first = rig.of('session:brain-delta')
    expect(first).toHaveLength(1)
    expect(first[0]?.text).toBe('w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 ')
    expect(first[0]?.sessionId).toBe(sessionId)

    brain.delta('more')
    await settle(60)
    brain.emit({
      type: 'assistant-message',
      messageId: 'm1',
      text: 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 more'
    })
    await settle()
    const deltas = rig.of('session:brain-delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[1]?.seq).toBeGreaterThan(deltas[0]?.seq ?? Infinity)
    const final = rig.of('session:message')[0]
    expect(final?.seq).toBeGreaterThan(deltas[1]?.seq ?? Infinity)
    expect(final?.message).toMatchObject({
      role: 'brain',
      state: 'complete',
      content: 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 more'
    })
    expect(deltas[1]?.messageId).toBe(final?.message.id)
  })

  it('flushes pending deltas before the final message', async () => {
    rig = await makeRig(dir())
    await startPastTitle()
    const brain = rig.adapter.last
    brain.delta('hello ')
    brain.delta('world')
    brain.emit({ type: 'assistant-message', messageId: 'm1', text: 'hello world' })
    await settle()
    const order = rig.pushed.map((p) => p.event).filter((e) => e !== 'session:brain-state')
    expect(order).toEqual(['session:brain-delta', 'session:message'])
    expect(rig.of('session:brain-delta')[0]?.text).toBe('hello world')
  })

  it('writes streaming text to the database at most once per second or 2 KB, not per delta', async () => {
    rig = await makeRig(dir())
    const update = vi.spyOn(rig.messagesRepo, 'updateStreaming')
    await startPastTitle()
    const brain = rig.adapter.last
    for (let i = 0; i < 40; i++) {
      brain.delta('x')
      rig.clock.now += 20
      await settle(20)
    }
    // 800 ms of tiny deltas: no write yet.
    expect(update).not.toHaveBeenCalled()
    rig.clock.now += 300
    brain.delta('y')
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]?.[1]).toBe(`${'x'.repeat(40)}y`)

    brain.delta('z'.repeat(2100))
    await settle()
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('finalizes the previous message when a new provider message starts', async () => {
    rig = await makeRig(dir())
    const sessionId = await startPastTitle()
    const brain = rig.adapter.last
    brain.delta('first', 'a')
    brain.delta('second', 'b')
    brain.emit({ type: 'assistant-message', messageId: 'b', text: 'second' })
    await settle()
    const rows = rig.messagesRepo.latest(sessionId, 10)
    expect(rows.filter((r) => r.role === 'brain').map((r) => [r.content, r.state])).toEqual([
      ['Ready.', 'complete'],
      ['first', 'complete'],
      ['second', 'complete']
    ])
  })

  it('keeps the streamed text consistent between a snapshot and later pushes', async () => {
    rig = await makeRig(dir())
    const sessionId = await startPastTitle()
    const brain = rig.adapter.last
    brain.delta('part one ')
    await settle()
    const snapshot = rig.service.snapshot(sessionId)
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'brain', state: 'streaming' })
    expect(snapshot.messages.at(-1)?.content).toBe('part one ')
    const pushedAtOpen = rig.of('session:brain-delta')
    expect(pushedAtOpen.map((d) => d.text).join('')).toBe('part one ')
    expect(Math.max(...pushedAtOpen.map((d) => d.seq))).toBeLessThanOrEqual(snapshot.seq)
    brain.delta('part two')
    await settle(60)
    const later = rig.of('session:brain-delta').at(-1)
    expect(later?.text).toBe('part two')
    expect(later?.seq).toBeGreaterThan(snapshot.seq)
  })
})

describe('session name', () => {
  it('strips the Title line from the message and uses it as the session name', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const brain = rig.adapter.last
    brain.delta('Titl')
    brain.delta('e: Billing refactor plan\n\nSure')
    brain.delta(', here is the plan.')
    brain.emit({
      type: 'assistant-message',
      messageId: 'm1',
      text: 'Title: Billing refactor plan\n\nSure, here is the plan.'
    })
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 5 })
    await settle(120)
    const snapshot = rig.service.snapshot(sessionId)
    expect(snapshot.header.name).toBe('Billing refactor plan')
    const reply = snapshot.messages.find((m) => m.role === 'brain')
    expect(reply?.content).toBe('Sure, here is the plan.')
    expect(
      rig
        .of('session:brain-delta')
        .map((d) => d.text)
        .join('')
    ).toBe('Sure, here is the plan.')
    expect(snapshot.events.map((e) => e.kind)).toContain('renamed')
    expect(rig.of('session:event-logged').flatMap((e) => e.entries.map((x) => x.kind))).toContain(
      'renamed'
    )
  })

  it('falls back to the first words of the request when there is no Title line', async () => {
    rig = await makeRig(dir())
    const sessionId = await start('add dark mode toggle to the settings page right now')
    const brain = rig.adapter.last
    brain.delta('Sure thing.\nLet me look.')
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 5 })
    await settle()
    const snapshot = rig.service.snapshot(sessionId)
    expect(snapshot.header.name).toBe('Add Dark Mode Toggle To The')
    expect(snapshot.messages.find((m) => m.role === 'brain')?.content).toBe(
      'Sure thing.\nLet me look.'
    )
  })

  it('does not overwrite a name the user set meanwhile', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    rig.service.rename(sessionId, 'My own name')
    const brain = rig.adapter.last
    brain.delta('Title: Something else\nBody')
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 5 })
    await settle()
    expect(rig.service.snapshot(sessionId).header.name).toBe('My own name')
  })

  it('derives names from the first six words, title-cased', () => {
    expect(deriveName('  fix the flaky login test in checkout service ')).toBe(
      'Fix The Flaky Login Test In'
    )
    expect(deriveName('hello.')).toBe('Hello')
    expect(deriveName('   ')).toBe('New session')
  })

  it('splits a Title line only once its line is complete', () => {
    expect(splitTitle('Title: Abc', false).decided).toBe(false)
    expect(splitTitle('Title: Abc', true)).toMatchObject({ decided: true, title: 'Abc', body: '' })
    expect(splitTitle('Hello\nworld', false)).toMatchObject({ decided: true, title: null })
  })
})

describe('stop and failures', () => {
  it('stop-reply finalizes the streaming message as stopped with the partial text', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const brain = rig.adapter.last
    brain.delta('Title: Quick one\nHalf an ans')
    await settle()
    await rig.service.stopReply(sessionId)
    await settle()
    expect(brain.interrupts).toBe(1)
    const snapshot = rig.service.snapshot(sessionId)
    const reply = snapshot.messages.find((m) => m.role === 'brain')
    expect(reply).toMatchObject({ state: 'stopped', content: 'Half an ans' })
    expect(rig.of('session:message').at(-1)?.message.state).toBe('stopped')
    expect(snapshot.brainState).toBe('idle')
    // A late delta of the stopped message is ignored.
    brain.delta('wer')
    await settle(60)
    expect(rig.messagesRepo.latest(sessionId, 10).filter((m) => m.role === 'brain')).toHaveLength(1)
  })

  it('stores the provider session id as soon as the session event arrives', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    rig.adapter.last.emit({
      type: 'session',
      providerSessionId: 'prov-123',
      model: 'claude-sonnet',
      mcpServers: []
    })
    await settle()
    expect(rig.brainThreadsRepo.get(sessionId, 'claude')).toBe('prov-123')
  })

  it('logs "Brain stopped unexpectedly" and pushes it when the brain crashes', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const brain = rig.adapter.last
    brain.delta('partial')
    brain.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    await settle(120)
    const events = rig.eventsRepo.latest(sessionId, 10)
    expect(events.map((e) => e.text)).toContain('Brain stopped unexpectedly')
    expect(rig.of('session:event-logged').flatMap((p) => p.entries.map((e) => e.text))).toContain(
      'Brain stopped unexpectedly'
    )
    expect(rig.messagesRepo.latest(sessionId, 10).at(-1)).toMatchObject({
      role: 'brain',
      state: 'stopped',
      content: 'partial'
    })
    expect(rig.service.snapshot(sessionId).brainState).toBe('idle')
  })

  it('reports signed-out when the brain fails authentication', async () => {
    rig = await makeRig(dir())
    await start()
    rig.adapter.last.emit({ type: 'error', kind: 'auth', message: 'not logged in' })
    await settle()
    expect(rig.signedOut).toHaveBeenCalledTimes(1)
  })
})

describe('send-message', () => {
  it('persists the message and reuses the running brain', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const { messageId } = await rig.service.sendMessage(sessionId, 'and also tests')
    await settle()
    expect(rig.adapter.starts).toHaveLength(1)
    expect(rig.adapter.last.sent).toEqual(['Plan the billing refactor please', 'and also tests'])
    expect(rig.messagesRepo.latest(sessionId, 10).at(-1)).toMatchObject({
      id: messageId,
      role: 'user',
      content: 'and also tests'
    })
  })

  it('starts a fresh brain when none is running, and touches last_active_at', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    await rig.adapter.last.stop()
    await settle()
    rig.clock.now += 5000
    await rig.service.sendMessage(sessionId, 'are you there')
    await settle()
    expect(rig.adapter.starts).toHaveLength(2)
    expect(rig.adapter.last.sent).toEqual(['are you there'])
    expect(rig.sessionsRepo.getById(sessionId)?.lastActiveAt).toBe(rig.clock.now)
  })

  it('does not persist the message when a needed spawn finds Claude Code unavailable', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    await rig.adapter.last.stop()
    await settle()
    rig.recheck.mockResolvedValue({ state: 'signed_out', message: 'no' })
    // The cached status says ok, so make it stale to force the re-check.
    rig.service['deps'].getCliStatus = () => undefined
    await expect(rig.service.sendMessage(sessionId, 'hello?')).rejects.toMatchObject({
      code: 'CLI_UNAVAILABLE'
    })
    expect(rig.messagesRepo.latest(sessionId, 10).map((m) => m.content)).toEqual([
      'Plan the billing refactor please'
    ])
  })

  it('answers SESSION_NOT_FOUND for an unknown session', async () => {
    rig = await makeRig(dir())
    await expect(rig.service.sendMessage('nope', 'hi')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('list and rename', () => {
  it('lists newest-active first and renames', async () => {
    rig = await makeRig(dir())
    const a = await start('first request')
    rig.clock.now += 10
    const b = await start('second request')
    expect(rig.service.list(rig.groupId).map((s) => s.id)).toEqual([b, a])
    expect(rig.service.rename(a, '  Renamed  ')).toMatchObject({ id: a, name: 'Renamed' })
    expect(() => rig.service.rename(a, ' ')).toThrow(AppErrorException)
  })
})

describe('resume', () => {
  it('starts fresh without a stored id, then resumes with the stored id after the brain stopped', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    expect(rig.adapter.starts[0]?.resume?.threadId).toBeUndefined()
    rig.adapter.last.emit({
      type: 'session',
      providerSessionId: 'claude-abc',
      model: 'x',
      mcpServers: []
    } as never)
    await settle()
    expect(rig.brainThreadsRepo.get(sessionId, 'claude')).toBe('claude-abc')

    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'and then?')
    await settle()
    const second = rig.adapter.starts[1]
    expect(second?.resume?.threadId).toBe('claude-abc')
    expect(second?.instructions).toBe(rig.adapter.starts[0]?.instructions)
    expect(rig.adapter.last.sent).toEqual(['and then?'])
  })
})

describe('brain prompt version', () => {
  async function sessionWithProviderId(): Promise<string> {
    const sessionId = await start()
    rig.adapter.last.emit({
      type: 'session',
      providerSessionId: 'claude-abc',
      model: 'x',
      mcpServers: []
    } as never)
    await settle()
    return sessionId
  }

  it('stamps a new session with the current version and sends no update note on resume', async () => {
    rig = await makeRig(dir())
    const sessionId = await sessionWithProviderId()
    expect(rig.sessionsRepo.getById(sessionId)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'and then?')
    await settle()
    expect(rig.adapter.last.sent).toEqual(['and then?'])
  })

  it('tells a session from the web-tools version everything newer, once (version 1 is older)', async () => {
    expect(BRAIN_PROMPT_VERSION).toBe(6)
    expect(PROMPT_UPDATE_NOTE_V2).toContain('read-only shell commands')
    expect(PROMPT_UPDATE_NOTE_V2).toContain('git -C <path> diff')
    expect(PROMPT_UPDATE_NOTE_V2).toContain('goes to the user for approval through Arc')
    expect(PROMPT_UPDATE_NOTE_V2).not.toContain('cannot edit files or run shell commands')
    rig = await makeRig(dir())
    const sessionId = await sessionWithProviderId()
    rig.sessionsRepo.setBrainPromptVersion(sessionId, 1)
    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'and then?')
    await settle()
    const full = `${PROMPT_UPDATE_NOTE_V2}\n\n${PROMPT_UPDATE_NOTE_V3}`
    expect(promptUpdateNote(1)).toBe(full)
    expect(rig.adapter.last.sent).toEqual([`${full}\n\nand then?`])
    expect(rig.sessionsRepo.getById(sessionId)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
  })

  it('tells a version 2 session only about parallel work, once', async () => {
    expect(PROMPT_UPDATE_NOTE_V3).toContain('split work across several workers')
    expect(PROMPT_UPDATE_NOTE_V3).toContain('dependsOn and sync_worker')
    expect(promptUpdateNote(2)).toBe(PROMPT_UPDATE_NOTE_V3)
    expect(promptUpdateNote(3)).toBeUndefined()
    rig = await makeRig(dir())
    const sessionId = await sessionWithProviderId()
    rig.sessionsRepo.setBrainPromptVersion(sessionId, 2)
    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'and then?')
    await settle()
    expect(rig.adapter.last.sent).toEqual([`${PROMPT_UPDATE_NOTE_V3}\n\nand then?`])
    expect(rig.sessionsRepo.getById(sessionId)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)

    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'after a restart')
    await settle()
    expect(rig.adapter.last.sent).toEqual(['after a restart'])
  })

  it('tells an older resumed session about its new abilities once, with the next message', async () => {
    rig = await makeRig(dir())
    const sessionId = await sessionWithProviderId()
    rig.sessionsRepo.setBrainPromptVersion(sessionId, 0)

    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'and then?')
    await settle()
    expect(rig.adapter.last.sent).toEqual([`${promptUpdateNote(0)}\n\nand then?`])
    expect(rig.sessionsRepo.getById(sessionId)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)

    await rig.service.sendMessage(sessionId, 'and again?')
    await settle()
    expect(rig.adapter.last.sent.at(-1)).toBe('and again?')

    await rig.service.shutdown()
    await rig.service.sendMessage(sessionId, 'after a restart')
    await settle()
    expect(rig.adapter.last.sent).toEqual(['after a restart'])
  })
})

describe('brain prompt capabilities', () => {
  const base = { groupName: 'G', knowledgePath: '/k', projects: [] }

  it('says what the brain can and cannot do, and how approvals work for workers', () => {
    const prompt = buildBrainPrompt({ ...base, workersEnabled: true })
    expect(prompt).toContain('What you can do:')
    expect(prompt).toContain('fetch web pages (WebFetch)')
    expect(prompt).toContain('You cannot edit files.')
    expect(prompt).toContain('read-only shell commands')
    expect(prompt).toContain('git -C <path> diff')
    expect(prompt).toContain('uncommitted')
    expect(prompt).toContain('goes to the user for approval through Arc')
    expect(prompt).toContain('start a worker for real changes')
    expect(prompt).toContain("do not see the user's uncommitted edits")
    expect(prompt).toContain('You never approve these and do not need to')
    expect(prompt).toContain('do not narrate or repeat them to the user')
    expect(PROMPT_UPDATE_NOTE_V2).toContain('do not narrate or repeat them')
    for (const tool of ['resolve_request', 'escalate_to_user', 'ask_user']) {
      expect(prompt).toContain(tool)
    }
  })

  it('tells the brain when to use several workers, only when workers exist', () => {
    const withWorkers = buildBrainPrompt({
      ...base,
      projects: [
        { name: 'api', path: '/p/api' },
        { name: 'web', path: '/p/web' }
      ],
      workersEnabled: true
    })
    expect(withWorkers).toContain('- spawn_worker: starts a worker in its own working copy')
    expect(withWorkers).toContain(
      'Call it once per worker; independent workers can run at the same time.'
    )
    expect(withWorkers).not.toContain('starts one worker')
    expect(withWorkers).toContain('one worker per repository')
    expect(withWorkers).toContain('list them all in one plan')
    expect(withWorkers).toContain('Arc queues the extras')
    expect(withWorkers).toContain('pass dependsOn to spawn_worker and use sync_worker')
    expect(withWorkers).toContain('run independent investigations in parallel')
    expect(withWorkers).toContain('do not split a small single-file change')
    expect(withWorkers).toContain('repos: ["api"]')
    expect(withWorkers).toContain('repos: ["web"]')
    const without = buildBrainPrompt({
      ...base,
      projects: [{ name: 'api', path: '/p/api' }],
      workersEnabled: false
    })
    expect(without).not.toContain('one worker per repository')
    expect(without).not.toContain('spawn_worker')
  })

  it('leaves the worker approval lines out when there are no workers', () => {
    const prompt = buildBrainPrompt({ ...base, workersEnabled: false })
    expect(prompt).toContain('What you can do:')
    expect(prompt).not.toContain('resolve_request')
    expect(prompt).toContain('cannot edit files or run shell commands')
    expect(prompt).not.toContain('git -C <path> diff')
  })
})

describe('delete', () => {
  it('stops the brain, removes the rows and the session folder', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const brain = rig.adapter.last
    const sessionDir = join(dir(), 'userData', 'sessions', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'x.txt'), 'x')
    await rig.service.delete(sessionId)
    expect(brain.stopped).toBe(true)
    expect(rig.sessionsRepo.getById(sessionId)).toBeUndefined()
    expect(rig.messagesRepo.latest(sessionId, 10)).toEqual([])
    expect(existsSync(sessionDir)).toBe(false)
    expect(rig.service.list(rig.groupId)).toEqual([])
    expect(() => rig.service.snapshot(sessionId)).toThrow(AppErrorException)
  })

  it('removeForGroup stops every session of the group and removes their folders', async () => {
    rig = await makeRig(dir())
    const a = await start()
    const brain = rig.adapter.last
    const sessionDir = join(dir(), 'userData', 'sessions', a)
    mkdirSync(sessionDir, { recursive: true })
    await rig.service.removeForGroup(rig.groupId)
    expect(brain.stopped).toBe(true)
    expect(existsSync(sessionDir)).toBe(false)
  })

  it('rejects an unknown session', async () => {
    rig = await makeRig(dir())
    await expect(rig.service.delete('nope')).rejects.toBeInstanceOf(AppErrorException)
  })
})

describe('page', () => {
  it('returns older messages and events ascending', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    for (let i = 0; i < 5; i += 1) await rig.service.sendMessage(sessionId, `m${i}`)
    const all = rig.messagesRepo.latest(sessionId, 50)
    const before = all[4]?.id ?? 0
    const older = rig.service.page(sessionId, 'messages', before, 2) as { id: number }[]
    expect(older.map((m) => m.id)).toEqual([all[2]?.id, all[3]?.id])
    for (let i = 0; i < 3; i += 1)
      rig.eventsRepo.append({
        sessionId,
        at: i,
        kind: 'k',
        text: `e${i}`,
        workerId: null,
        dataJson: null
      })
    const events = rig.eventsRepo.latest(sessionId, 10)
    const page = rig.service.page(sessionId, 'events', events[2]?.id ?? 0, 5) as { text: string }[]
    expect(page.map((e) => e.text)).toEqual(['e0', 'e1'])
  })
})

describe('session:summary pushes', () => {
  it('pushes working then idle, at most once per 250 ms per session, only on change', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    await settle(SUMMARY_PUSH_MS)
    expect(rig.of('session:summary').map((p) => p.summary.listStatus)).toEqual(['working'])
    const brain = rig.adapter.last
    // Several changes inside one window collapse into one push.
    brain.emit({ type: 'assistant-message', messageId: 'm0', text: 'Title: Setup\nReady.' })
    brain.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    rig.clock.now += 10
    await settle(SUMMARY_PUSH_MS)
    const pushes = rig.of('session:summary')
    expect(pushes).toHaveLength(2)
    expect(pushes[1]).toMatchObject({
      groupId: rig.groupId,
      summary: { id: sessionId, name: 'Setup', listStatus: 'idle' }
    })
    await settle(SUMMARY_PUSH_MS * 3)
    expect(rig.of('session:summary')).toHaveLength(2)
  })
})

describe('new sessions copy the Settings defaults', () => {
  it('without any setting stored, a session is Auto workers and a Claude · Sonnet brain', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      workersPrefJson: JSON.stringify({ mode: 'auto' }),
      brainProvider: 'claude',
      brainModel: 'sonnet'
    })
    expect(rig.service.snapshot(sessionId).header).toMatchObject({ workers: { mode: 'auto' } })
  })

  it('copies the stored brain and workers defaults, and a later change leaves the session alone', async () => {
    rig = await makeRig(dir())
    rig.appSettingsRepo.setMany(
      {
        'providers.brain': { provider: 'claude', model: 'opus' },
        'providers.workers': { mode: 'provider', provider: 'codex' }
      },
      1
    )
    const sessionId = await start()
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      workersPrefJson: JSON.stringify({ mode: 'provider', provider: 'codex' }),
      brainProvider: 'claude',
      brainModel: 'opus'
    })
    expect(rig.service.snapshot(sessionId).header).toMatchObject({
      brainModel: 'opus',
      workers: { mode: 'provider', provider: 'codex' }
    })
    expect(rig.adapter.starts[0]?.model).toBe('opus')

    rig.appSettingsRepo.set('providers.workers', { mode: 'auto' }, 2)
    expect(rig.service.snapshot(sessionId).header.workers).toEqual({
      mode: 'provider',
      provider: 'codex'
    })
  })

  it('stores a Codex brain default, but the brain runs Claude · Sonnet while Codex is not ready', async () => {
    rig = await makeRig(dir())
    rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-6-sol' }, 1)
    const sessionId = await start()
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      brainProvider: 'codex',
      brainModel: 'gpt-6-sol'
    })
    expect(rig.adapter.starts[0]).toMatchObject({
      provider: 'claude',
      role: 'brain',
      model: 'sonnet'
    })
    // The card says what runs now; the stored choice (brainModel) is untouched.
    expect(rig.service.snapshot(sessionId).header.brainRunningOn).toEqual({
      provider: 'claude',
      model: 'sonnet',
      requestedProvider: 'codex',
      fallbackReason: "Arc couldn't check Codex."
    })
    expect(rig.service.snapshot(sessionId).header.brainModel).toBe('gpt-6-sol')
  })
})

describe('set-config and the brain model', () => {
  it('resolveBrainModel uses the brain model, not the worker model', async () => {
    expect(resolveBrainModel('opus')).toBe('opus')
    rig = await makeRig(dir())
    const sessionId = await start()
    rig.sessionsRepo.setWorkersPref(sessionId, {
      mode: 'model',
      model: { provider: 'claude', model: 'haiku' }
    })
    rig.sessionsRepo.setBrain(sessionId, { provider: 'claude', model: 'opus' })
    await rig.service.shutdown()
    rig.adapter.starts.length = 0
    await rig.service.sendMessage(sessionId, 'again')
    await settle()
    expect(rig.adapter.starts[0]?.model).toBe('opus')
  })

  it('persists mode, limit, worker model and brain model and pushes the header', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    rig.pushed.length = 0
    const header = rig.service.setConfig(sessionId, {
      mode: 'autonomous',
      workerLimit: 5,
      workers: { mode: 'model', model: { provider: 'claude', model: 'Haiku' } },
      brainModel: { provider: 'claude', model: 'opus' }
    })
    expect(header).toMatchObject({
      mode: 'autonomous',
      workerLimit: 5,
      model: 'Haiku',
      workers: { mode: 'model', model: { provider: 'claude', model: 'Haiku' } },
      brainModel: 'opus'
    })
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      brainProvider: 'claude',
      brainModel: 'opus',
      workersPrefJson: JSON.stringify({
        mode: 'model',
        model: { provider: 'claude', model: 'Haiku' }
      })
    })
    expect(rig.of('session:header').at(-1)?.header).toEqual(header)
    await settle(200)
    expect(rig.eventsRepo.latest(sessionId, 20).map((e) => e.text)).toContain(
      'Brain model set to Claude · Opus'
    )
    expect(rig.service.setConfig(sessionId, { workers: { mode: 'auto' } }).model).toBe('auto')
    expect(
      rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    ).toMatchObject({ model: 'auto', workers: { mode: 'provider', provider: 'codex' } })
  })

  it('rejects unknown models and an out-of-range limit', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    const claude = (model: string): ModelRef => ({ provider: 'claude', model })
    for (const patch of [
      { brainModel: claude('gpt-9') },
      { brainModel: claude('auto') },
      { workers: { mode: 'model' as const, model: claude('gpt-9') } },
      // Codex lists no model while its status is unknown, so a Codex model cannot be pinned.
      {
        workers: { mode: 'model' as const, model: { provider: 'codex' as const, model: 'gpt-x' } }
      },
      { workerLimit: 9 }
    ]) {
      expect(() => rig.service.setConfig(sessionId, patch)).toThrow(AppErrorException)
    }
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      brainModel: 'sonnet',
      workerLimit: 3
    })
    rig.adapter.last.emit({
      type: 'session',
      providerSessionId: 'p1',
      model: 'claude-opus-5-1',
      mcpServers: []
    })
    await settle()
    expect(
      rig.service.setConfig(sessionId, { brainModel: claude('claude-opus-5-1') }).brainModel
    ).toBe('claude-opus-5-1')
  })

  it('refuses a Codex brain model while Codex lists none, and keeps the brain as it was', async () => {
    rig = await makeRig(dir())
    const sessionId = await start()
    expect(() =>
      rig.service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-x' } })
    ).toThrow(AppErrorException)
    expect(rig.sessionsRepo.getById(sessionId)).toMatchObject({
      brainProvider: 'claude',
      brainModel: 'sonnet'
    })
  })

  it('lets the reply in progress finish, then respawns with --resume and the new model', async () => {
    rig = await makeRig(dir())
    const sessionId = await startPastTitle()
    const first = rig.adapter.last
    first.emit({
      type: 'session',
      providerSessionId: 'prov-1',
      model: 'claude-sonnet-5-5',
      mcpServers: []
    })
    await rig.service.sendMessage(sessionId, 'second question')
    await settle()
    first.delta('partial ', 'm2')
    await settle(200)

    rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'opus' } })
    await settle(200)
    expect(first.stopped).toBe(false)
    first.delta('answer', 'm2')
    first.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await settle(200)
    expect(first.stopped).toBe(true)
    expect(rig.service.snapshot(sessionId).messages.at(-1)).toMatchObject({
      content: 'partial answer',
      state: 'complete'
    })

    await rig.service.sendMessage(sessionId, 'third question')
    await settle()
    expect(rig.adapter.starts).toHaveLength(2)
    expect(rig.adapter.starts[1]).toMatchObject({ model: 'opus', resume: { threadId: 'prov-1' } })
    expect(rig.adapter.last.sent).toEqual(['third question'])
  })

  it('applies the change on the next send when the brain is idle', async () => {
    rig = await makeRig(dir())
    const sessionId = await startPastTitle()
    rig.service.setConfig(sessionId, { brainModel: { provider: 'claude', model: 'haiku' } })
    await rig.service.sendMessage(sessionId, 'next')
    await settle()
    expect(rig.adapter.handles[0]?.stopped).toBe(true)
    expect(rig.adapter.starts[1]?.model).toBe('haiku')
  })
})
