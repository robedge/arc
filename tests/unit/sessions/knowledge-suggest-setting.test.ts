import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeItemsRepo } from '../../../src/main/db/repositories/knowledge-items-repo'
import { KnowledgeSuggestionsRepo } from '../../../src/main/db/repositories/knowledge-suggestions-repo'
import { SectionsRepo } from '../../../src/main/db/repositories/sections-repo'
import { KnowledgeIndex } from '../../../src/main/knowledge/knowledge-index'
import { KnowledgeService } from '../../../src/main/knowledge/knowledge-service'
import { KnowledgeSuggestionService } from '../../../src/main/knowledge/knowledge-suggestion-service'
import { MetaStore } from '../../../src/main/knowledge/meta-store'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { spawnWorker } from './merge-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-suggest-setting-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const OFF_NOTE =
  "[Arc] The user switched knowledge suggestions off. Don't suggest knowledge updates on your own; only when they ask."
const ON_NOTE =
  '[Arc] The user switched knowledge suggestions on. You may suggest knowledge updates again when a request is finished.'

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
  /** The Settings switch as the Orchestrator's getter reads it. */
  setting: { on: boolean }
  /** Flips the switch and runs the hook `settings:set` calls. */
  flip(on: boolean): void
  suggest(args: Record<string, unknown>): ReturnType<EngineRig['call']>
}

async function start(initial = true, opts: { session?: boolean } = {}): Promise<Started> {
  const built: { svc?: KnowledgeSuggestionService } = {}
  const live = (): KnowledgeSuggestionService => {
    if (built.svc === undefined) throw new Error('the suggestion service is not built yet')
    return built.svc
  }
  const setting = { on: initial }
  const rig = await makeEngineRig(dir(), {
    knowledgeSuggestions: { suggest: (...a) => live().suggest(...a) },
    suggestKnowledge: () => setting.on
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
  const sessionId = opts.session === false ? '' : await rig.startSession('autonomous')
  return {
    rig,
    sessionId,
    svc,
    setting,
    flip: (on) => {
      setting.on = on
      rig.rig.service.knowledgeSuggestSettingChanged()
    },
    suggest: (args) => rig.call(rig.brain(), 'suggest_knowledge_update', args)
  }
}

const errorOf = (outcome: { value: Record<string, unknown> }): unknown => outcome.value['error']

describe('suggestions_off, through the tool', () => {
  it('refuses a plain call, with a hint, and stores nothing', async () => {
    const s = await start(false)
    const outcome = await s.suggest(base)
    expect(outcome.isError).toBe(true)
    expect(errorOf(outcome)).toBe('suggestions_off')
    expect(String(outcome.value['message'])).toMatch(/switched knowledge suggestions off/i)
    expect(String(outcome.value['message'])).toMatch(/only if they ask/i)
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(0)
  })

  it('stores the suggestion when the user asked for it', async () => {
    const s = await start(false)
    const outcome = await s.suggest({ ...base, asked_by_user: true })
    expect(outcome.isError).toBe(false)
    expect(s.svc.listWaiting(s.sessionId)).toHaveLength(1)
  })

  it('names suggestions_off, not workers_running, when both apply', async () => {
    const s = await start(false)
    await spawnWorker(s.rig, 'api-retry', 'api')
    expect(errorOf(await s.suggest(base))).toBe('suggestions_off')
  })

  it('lifts both refusals with asked_by_user', async () => {
    const s = await start(false)
    await spawnWorker(s.rig, 'api-retry', 'api')
    expect((await s.suggest({ ...base, asked_by_user: true })).isError).toBe(false)
  })

  it('still applies the cap and the dedupe to a call the user asked for', async () => {
    const s = await start(false)
    expect((await s.suggest({ ...base, asked_by_user: true })).isError).toBe(false)
    expect(errorOf(await s.suggest({ ...base, asked_by_user: true }))).toBe('duplicate')
    for (let n = 1; n <= 4; n++) await s.suggest({ ...note(n), asked_by_user: true })
    expect(errorOf(await s.suggest({ ...note(6), asked_by_user: true }))).toBe('cap_reached')
  })

  it('behaves as before when the setting is on', async () => {
    const s = await start(true)
    expect((await s.suggest(base)).isError).toBe(false)
    await spawnWorker(s.rig, 'api-retry', 'api')
    expect(errorOf(await s.suggest(note(2)))).toBe('workers_running')
  })

  it('sees a flip on the next call, without restarting the brain', async () => {
    const s = await start(true)
    const starts = s.rig.rig.adapter.starts.length
    expect((await s.suggest(note(1))).isError).toBe(false)
    s.setting.on = false
    expect(errorOf(await s.suggest(note(2)))).toBe('suggestions_off')
    s.setting.on = true
    expect((await s.suggest(note(3))).isError).toBe(false)
    expect(s.rig.rig.adapter.starts).toHaveLength(starts)
  })

  it('leaves suggestions that were already waiting listed when it goes off', async () => {
    const s = await start(true)
    await s.suggest(note(1))
    await s.suggest(note(2))
    s.flip(false)
    expect(
      s.svc
        .listWaiting(s.sessionId)
        .map((w) => w.title)
        .sort()
    ).toEqual(['Fact 1', 'Fact 2'])
    expect(s.rig.rig.service.snapshot(s.sessionId).knowledgeSuggestions).toHaveLength(2)
  })
})

describe('the deferred note when the setting changes under a running brain', () => {
  const send = async (s: Started, text: string): Promise<string> => {
    const brain = s.rig.brain()
    const before = brain.sent.length
    await s.rig.rig.service.sendMessage(s.sessionId, text)
    await until(() => brain.sent.length > before)
    return brain.sent.at(-1) ?? ''
  }
  const idle = async (s: Started): Promise<void> => {
    s.rig.brain().emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => s.rig.rig.service.snapshot(s.sessionId).brainState === 'idle')
  }

  it('off: the next message starts with the off note, once', async () => {
    const s = await start(true)
    s.flip(false)
    const message = await send(s, 'what next?')
    expect(message).toBe(`${OFF_NOTE}\n\nwhat next?`)
    await idle(s)
    expect(await send(s, 'thanks')).toBe('thanks')
  })

  it('on: the next message starts with the on note', async () => {
    const s = await start(false)
    s.flip(true)
    expect(await send(s, 'what next?')).toBe(`${ON_NOTE}\n\nwhat next?`)
  })

  it('off then on before a message: no note, the brain is where its prompt left it', async () => {
    const s = await start(true)
    s.flip(false)
    s.flip(true)
    expect(await send(s, 'what next?')).toBe('what next?')
  })

  it('on then off then on from an off prompt: the latest state only', async () => {
    const s = await start(false)
    s.flip(true)
    s.flip(false)
    s.flip(true)
    expect(await send(s, 'what next?')).toBe(`${ON_NOTE}\n\nwhat next?`)
  })

  it('an unchanged value queues nothing', async () => {
    const s = await start(true)
    s.flip(true)
    expect(await send(s, 'what next?')).toBe('what next?')
  })

  it('a failed send puts the note back for the next message', async () => {
    const s = await start(true)
    s.flip(false)
    const brain = s.rig.brain()
    brain.sendsOk = false
    const before = brain.sent.length
    await s.rig.rig.service.sendMessage(s.sessionId, 'lost message')
    await until(() => brain.sent.length > before)
    expect(brain.sent.at(-1)).toContain(OFF_NOTE)

    brain.sendsOk = true
    const retried = await send(s, 'second try')
    expect(retried).toBe(`${OFF_NOTE}\n\nsecond try`)
    await idle(s)
    expect(await send(s, 'third')).toBe('third')
  })

  it('does nothing without a running brain, and a brain started later gets the variant in its prompt', async () => {
    const s = await start(true, { session: false })
    s.rig.rig.opened.sqlite
      .prepare(
        `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
         VALUES ('idle1',?,'Idle','autonomous',2,'opus','sonnet','active',1,50)`
      )
      .run(s.rig.rig.groupId)
    const handlesBefore = s.rig.rig.adapter.handles.length
    s.flip(false)
    expect(s.rig.rig.adapter.handles).toHaveLength(handlesBefore)

    await s.rig.rig.service.sendMessage('idle1', 'hello')
    await until(() => s.rig.rig.adapter.handles.length > handlesBefore)
    const started = s.rig.rig.adapter.handles.at(-1)
    await until(() => (started?.sent.length ?? 0) > 0)
    expect(started?.sent.join('\n')).not.toContain('switched knowledge suggestions')
    const prompt = s.rig.rig.adapter.starts.at(-1)?.instructions ?? ''
    expect(prompt).toContain('Knowledge suggestions are switched off')
  })
})

describe('buildLaunch and the setting', () => {
  it('puts the off variant in the prompt of a brain started while it is off', async () => {
    const s = await start(false)
    const prompt = s.rig.rig.adapter.starts[0]?.instructions ?? ''
    expect(prompt).toContain('Knowledge suggestions are switched off')
    expect(prompt).not.toContain('you may call')
  })

  it('puts the on variant in the prompt of a brain started while it is on', async () => {
    const s = await start(true)
    const prompt = s.rig.rig.adapter.starts[0]?.instructions ?? ''
    expect(prompt).toContain('you may call')
    expect(prompt).not.toContain('Knowledge suggestions are switched off')
  })
})
