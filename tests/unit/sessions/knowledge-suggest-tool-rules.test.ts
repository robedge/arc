import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeItemsRepo } from '../../../src/main/db/repositories/knowledge-items-repo'
import { KnowledgeSuggestionsRepo } from '../../../src/main/db/repositories/knowledge-suggestions-repo'
import { SectionsRepo } from '../../../src/main/db/repositories/sections-repo'
import { KnowledgeIndex } from '../../../src/main/knowledge/knowledge-index'
import { KnowledgeService } from '../../../src/main/knowledge/knowledge-service'
import {
  KnowledgeSuggestionService,
  MAX_SUGGESTIONS_PER_REQUEST
} from '../../../src/main/knowledge/knowledge-suggestion-service'
import { MetaStore } from '../../../src/main/knowledge/meta-store'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker, spawnWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-suggest-rules-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const base = {
  kind: 'new',
  title: 'Orders table is partitioned by month',
  reason: 'Read in the schema dump',
  section: 'Notes',
  name: 'Service map',
  content: 'Checkout calls pricing twice.'
}
const note = (n: number): Record<string, unknown> => ({
  ...base,
  title: `Fact ${n}`,
  name: `Note ${n}`,
  content: `Fact number ${n}.`
})

interface Started {
  rig: EngineRig
  sessionId: string
  svc: KnowledgeSuggestionService
  suggest(args: Record<string, unknown>): ReturnType<EngineRig['call']>
}

/** An engine rig whose brain talks to a real `KnowledgeSuggestionService` over the rig's database. */
async function start(): Promise<Started> {
  const built: { svc?: KnowledgeSuggestionService } = {}
  const live = (): KnowledgeSuggestionService => {
    if (built.svc === undefined) throw new Error('the suggestion service is not built yet')
    return built.svc
  }
  const rig = await makeEngineRig(dir(), {
    knowledgeSuggestions: { suggest: (...a) => live().suggest(...a) }
  })
  e = rig
  const { db } = rig.rig.opened
  const sectionsRepo = new SectionsRepo(db)
  const itemsRepo = new KnowledgeItemsRepo(db)
  const metaStore = new MetaStore({ log: { warn: () => undefined } })
  const getKnowledgeRoot = rig.rig.deps.getKnowledgeRoot
  const index = new KnowledgeIndex({ sectionsRepo, itemsRepo, metaStore, getKnowledgeRoot })
  const svc = new KnowledgeSuggestionService({
    repo: new KnowledgeSuggestionsRepo(db),
    sectionsRepo,
    getKnowledgeRoot,
    knowledge: new KnowledgeService({
      sectionsRepo,
      itemsRepo,
      index,
      metaStore,
      getKnowledgeRoot
    }),
    itemsRepo,
    emitChanged: () => undefined,
    logSessionEvent: (sessionId, kind, text, data) =>
      rig.rig.service.logEvent(sessionId, kind, text, data),
    publish: () => undefined,
    onDiscarded: (sessionId, titles) => rig.rig.service.knowledgeDiscarded(sessionId, titles)
  })
  built.svc = svc
  const sessionId = await rig.startSession('autonomous')
  return {
    rig,
    sessionId,
    svc,
    suggest: (args) => rig.call(rig.brain(), 'suggest_knowledge_update', args)
  }
}

const idOf = (outcome: { value: Record<string, unknown> }): string => String(outcome.value['id'])
const errorOf = (outcome: { value: Record<string, unknown> }): unknown => outcome.value['error']
const userRows = (s: Started): number =>
  s.rig.rig.messagesRepo.latest(s.sessionId, 200).filter((m) => m.role === 'user').length

describe('the cap of five per request', () => {
  it('lets five through with 4, 3, 2, 1, 0 left and refuses the sixth', async () => {
    const s = await start()
    const left: unknown[] = []
    for (let n = 1; n <= MAX_SUGGESTIONS_PER_REQUEST; n++) {
      const outcome = await s.suggest(note(n))
      expect(outcome.isError).toBe(false)
      left.push(outcome.value['remainingThisRequest'])
    }
    expect(left).toEqual([4, 3, 2, 1, 0])
    const sixth = await s.suggest(note(6))
    expect(sixth.isError).toBe(true)
    expect(errorOf(sixth)).toBe('cap_reached')
    expect(String(sixth.value['message'])).toMatch(/stop suggesting/i)
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(5)
  })

  it('does not count a refused call', async () => {
    const s = await start()
    for (let n = 1; n <= 4; n++) await s.suggest(note(n))
    const refused = await s.suggest({ ...note(9), section: 'Wiki' })
    expect(errorOf(refused)).toBe('unknown_section')
    const fifth = await s.suggest(note(5))
    expect(fifth.value['remainingThisRequest']).toBe(0)
  })

  it('does not free a slot when the user discards one', async () => {
    const s = await start()
    const first = await s.suggest(note(1))
    for (let n = 2; n <= 5; n++) await s.suggest(note(n))
    s.svc.discard(idOf(first))
    expect(errorOf(await s.suggest(note(6)))).toBe('cap_reached')
  })

  it('does not free a slot when the user accepts one', async () => {
    const s = await start()
    const first = await s.suggest(note(1))
    for (let n = 2; n <= 5; n++) await s.suggest(note(n))
    await s.svc.accept(idOf(first))
    expect(errorOf(await s.suggest(note(6)))).toBe('cap_reached')
  })

  it('starts again with a new user message', async () => {
    const s = await start()
    for (let n = 1; n <= 5; n++) await s.suggest(note(n))
    expect(errorOf(await s.suggest(note(6)))).toBe('cap_reached')
    await s.rig.rig.service.sendMessage(s.sessionId, 'Now look at the web app')
    const outcome = await s.suggest(note(6))
    expect(outcome.isError).toBe(false)
    expect(outcome.value['remainingThisRequest']).toBe(4)
  })

  it('is not reset by an [Arc] worker note or the all-workers-finished summary', async () => {
    const s = await start()
    for (let n = 1; n <= 5; n++) await s.suggest(note(n))
    const usersBefore = userRows(s)
    const before = s.rig.rig.messagesRepo.latestUserId(s.sessionId)

    await doneWorker(s.rig, 'edit-readme', 'api', { 'README.md': 'hello\nfrom the worker\n' })
    await s.rig.call(s.rig.brain(), 'merge_worker', { workerId: 'W1' })
    await until(() => s.rig.brain().sent.some((m) => m.includes('All workers finished')))
    const arcTurns = s.rig.brain().sent.filter((m) => m.startsWith('[Arc]') || m.includes('[Arc]'))
    expect(arcTurns.length).toBeGreaterThan(0)

    // Arc-authored turns are not stored as `user` messages, so the request id did not move.
    expect(userRows(s)).toBe(usersBefore)
    expect(s.rig.rig.messagesRepo.latestUserId(s.sessionId)).toBe(before)
    expect(errorOf(await s.suggest(note(6)))).toBe('cap_reached')
  })
})

describe('not repeating a suggestion, through the tool', () => {
  it('refuses the same suggestion twice with duplicate', async () => {
    const s = await start()
    expect((await s.suggest(base)).isError).toBe(false)
    const again = await s.suggest({ ...base, name: 'Service map' })
    expect(errorOf(again)).toBe('duplicate')
  })

  it('refuses with already_discarded once the user discarded it', async () => {
    const s = await start()
    const first = await s.suggest(base)
    s.svc.discard(idOf(first))
    expect(errorOf(await s.suggest(base))).toBe('already_discarded')
  })

  it('refuses with already_discarded in a later request too', async () => {
    const s = await start()
    s.svc.discard(idOf(await s.suggest(base)))
    await s.rig.rig.service.sendMessage(s.sessionId, 'Another question')
    expect(errorOf(await s.suggest(base))).toBe('already_discarded')
  })

  it('refuses with duplicate once the user accepted it', async () => {
    const s = await start()
    const first = await s.suggest(base)
    await s.svc.accept(idOf(first))
    // The accepted note is on disk now, yet the repeat is named as a repeat, not as a taken name.
    expect(errorOf(await s.suggest(base))).toBe('duplicate')
  })

  it('allows the same content under another note name', async () => {
    const s = await start()
    await s.suggest(base)
    expect((await s.suggest({ ...base, name: 'Service map two' })).isError).toBe(false)
  })

  it('allows the same title with different content', async () => {
    const s = await start()
    await s.suggest(base)
    const other = await s.suggest({ ...base, name: 'Service map two', content: 'Something else.' })
    expect(other.isError).toBe(false)
  })

  it('allows the same content in a different section', async () => {
    const s = await start()
    await s.suggest(base)
    const docs = await s.suggest({ ...base, section: 'Docs' })
    expect(docs.isError).toBe(false)
  })
})

describe('workers_running', () => {
  it('refuses while a worker is active', async () => {
    const s = await start()
    await spawnWorker(s.rig, 'api-retry', 'api')
    const outcome = await s.suggest(base)
    expect(outcome.isError).toBe(true)
    expect(errorOf(outcome)).toBe('workers_running')
    expect(String(outcome.value['message'])).toMatch(/finished|asks/i)
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(0)
  })

  it('does not count a refusal against the cap', async () => {
    const s = await start()
    await spawnWorker(s.rig, 'api-retry', 'api')
    for (let n = 1; n <= 6; n++) expect(errorOf(await s.suggest(note(n)))).toBe('workers_running')
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(0)
  })

  it('lets a suggestion through when the user asked for it', async () => {
    const s = await start()
    await spawnWorker(s.rig, 'api-retry', 'api')
    const outcome = await s.suggest({ ...base, asked_by_user: true })
    expect(outcome.isError).toBe(false)
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(1)
  })

  it('still applies the cap to a call the user asked for', async () => {
    const s = await start()
    await spawnWorker(s.rig, 'api-retry', 'api')
    for (let n = 1; n <= 5; n++) await s.suggest({ ...note(n), asked_by_user: true })
    expect(errorOf(await s.suggest({ ...note(6), asked_by_user: true }))).toBe('cap_reached')
  })

  it('allows a suggestion once the worker is done', async () => {
    const s = await start()
    await doneWorker(s.rig, 'edit-readme', 'api', { 'README.md': 'hello\nmore\n' })
    expect((await s.suggest(base)).isError).toBe(false)
  })

  it('allows a suggestion once the worker is merged', async () => {
    const s = await start()
    const worker = await doneWorker(s.rig, 'edit-readme', 'api', { 'README.md': 'hello\nmore\n' })
    await s.rig.call(s.rig.brain(), 'merge_worker', { workerId: worker.workerId })
    await until(() => s.rig.brain().sent.some((m) => m.includes('All workers finished')))
    expect(s.rig.rig.deps.workersRepo.get(worker.workerId)?.status).toBe('merged')
    expect((await s.suggest(base)).isError).toBe(false)
  })

  it('counts a worker the user stepped in on as still running', async () => {
    const s = await start()
    const started = await s.rig.call(s.rig.brain(), 'spawn_worker', {
      name: 'api-retry',
      task: 'Add retries',
      repos: ['api']
    })
    const workerId = String(started.value['workerId'])
    s.rig
      .workerHandle()
      .emit({ type: 'session', providerSessionId: 'w1', model: 'sonnet', mcpServers: [] })
    await until(() => s.rig.rig.deps.workersRepo.get(workerId)?.status === 'working')
    await s.rig.rig.service.stepInWorker(workerId)
    expect(s.rig.rig.deps.workersRepo.get(workerId)?.userControl).not.toBeNull()
    expect(errorOf(await s.suggest(base))).toBe('workers_running')
  })

  it('counts a queued worker as still running', async () => {
    const s = await start()
    s.rig.rig.service.setConfig(s.sessionId, { workerLimit: 1 })
    const spawn = (name: string): ReturnType<EngineRig['call']> =>
      s.rig.call(s.rig.brain(), 'spawn_worker', { name, task: `Do ${name}`, repos: ['api'] })
    const first = await spawn('one')
    const second = await spawn('two')
    expect(second.value['status']).toBe('queued')
    // Stop the running one: only the queued worker is left to start.
    const handle = s.rig.workerHandle(0)
    await s.rig.call(handle, 'report_done', { summary: 'ok' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(
      () => s.rig.rig.deps.workersRepo.get(String(first.value['workerId']))?.status === 'done'
    )
    expect(errorOf(await s.suggest(base))).toBe('workers_running')
  })
})

describe('the deferred note about discarded suggestions', () => {
  const lastSent = (s: Started): string => s.rig.brain().sent.at(-1) ?? ''
  const send = async (s: Started, text: string): Promise<string> => {
    const before = s.rig.brain().sent.length
    await s.rig.rig.service.sendMessage(s.sessionId, text)
    await until(() => s.rig.brain().sent.length > before)
    return lastSent(s)
  }
  const idle = async (s: Started): Promise<void> => {
    s.rig.brain().emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => s.rig.rig.service.snapshot(s.sessionId).brainState === 'idle')
  }

  it('tells the brain about one discard on its next message', async () => {
    const s = await start()
    s.svc.discard(idOf(await s.suggest(note(1))))
    const message = await send(s, 'what next?')
    expect(message).toBe(
      '[Arc] The user discarded these knowledge suggestions: "Fact 1". Don\'t suggest them again.\n\nwhat next?'
    )
  })

  it('batches two discards and a discard all into one note, once', async () => {
    const s = await start()
    const a = await s.suggest(note(1))
    const b = await s.suggest(note(2))
    await s.suggest(note(3))
    await s.suggest(note(4))
    s.svc.discard(idOf(a))
    s.svc.discard(idOf(b))
    s.svc.discardAll(s.sessionId)
    const message = await send(s, 'what next?')
    expect(
      message.startsWith(
        '[Arc] The user discarded these knowledge suggestions: "Fact 1", "Fact 2", "Fact 3", "Fact 4". Don\'t suggest them again.'
      )
    ).toBe(true)
    expect(message.match(/\[Arc\] The user discarded/g)).toHaveLength(1)
    expect(message.endsWith('what next?')).toBe(true)

    await idle(s)
    expect(await send(s, 'thanks')).toBe('thanks')
  })

  it('puts the note back when the send fails, and delivers it with the next message', async () => {
    const s = await start()
    s.svc.discard(idOf(await s.suggest(note(1))))
    s.rig.brain().sendsOk = false
    const before = s.rig.brain().sent.length
    await s.rig.rig.service.sendMessage(s.sessionId, 'lost message')
    await until(() => s.rig.brain().sent.length > before)
    expect(lastSent(s)).toContain('"Fact 1"')

    s.rig.brain().sendsOk = true
    const retried = await send(s, 'second try')
    expect(retried).toContain('[Arc] The user discarded these knowledge suggestions: "Fact 1"')
    expect(retried.endsWith('second try')).toBe(true)
  })

  it('produces no note for an accept', async () => {
    const s = await start()
    await s.svc.accept(idOf(await s.suggest(note(1))))
    expect(await send(s, 'what next?')).toBe('what next?')
  })

  it('does nothing when no brain is running, and a brain started later gets no stale note', async () => {
    const s = await start()
    s.rig.rig.opened.sqlite
      .prepare(
        `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
         VALUES ('idle1',?,'Idle','autonomous',2,'opus','sonnet','active',1,50)`
      )
      .run(s.rig.rig.groupId)
    const handlesBefore = s.rig.rig.adapter.handles.length
    s.rig.rig.service.knowledgeDiscarded('idle1', ['Fact 1'])
    s.rig.rig.service.knowledgeDiscarded('no-such-session', ['Fact 1'])
    expect(s.rig.rig.adapter.handles).toHaveLength(handlesBefore)

    await s.rig.rig.service.sendMessage('idle1', 'hello')
    await until(() => s.rig.rig.adapter.handles.length > handlesBefore)
    const started = s.rig.rig.adapter.handles.at(-1)
    await until(() => (started?.sent.length ?? 0) > 0)
    expect(started?.sent.join('\n')).not.toContain('discarded these knowledge suggestions')
  })
})
