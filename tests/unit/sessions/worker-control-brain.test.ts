import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { doneWorker, finishWorker, spawnWorker } from './merge-rig'
import {
  HAND_BACK_REPORTED_DONE_TEXT,
  HAND_BACK_TEXT,
  handBackNote,
  heldMessageText
} from '../../../src/main/sessions/worker-manager'

// Real repositories and several git processes per test.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-control-brain-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<EngineRig> {
  e = await makeEngineRig(dir(), overrides)
  await e.startSession('autonomous')
  return e
}

const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms))
const brainSaw = (text: string): boolean => e?.brain().sent.some((t) => t.includes(text)) ?? false
const turn = (h: { emit: (event: never) => void }): void =>
  h.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 } as never)

describe('messages held while the user is in control', () => {
  it('queues the brain message, sends nothing, and delivers it after the hand-back text', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    await rig.rig.service.stepInWorker(w1.workerId)
    const before = w1.handle.sent.length

    const first = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'one' })
    const second = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'two' })
    expect(first).toMatchObject({ isError: false, value: { delivered: false, queued: true } })
    expect(second).toMatchObject({ isError: false, value: { delivered: false, queued: true } })
    expect(w1.handle.sent).toHaveLength(before)
    expect(rig.rig.deps.heldMessagesRepo.listUndelivered(w1.workerId).map((m) => m.body)).toEqual([
      'one',
      'two'
    ])

    await rig.rig.service.handBackWorker(w1.workerId)
    expect(w1.handle.sent.slice(before)).toEqual([
      [HAND_BACK_TEXT, heldMessageText('one'), heldMessageText('two')].join('\n\n')
    ])
    expect(rig.rig.deps.heldMessagesRepo.listUndelivered(w1.workerId)).toEqual([])
  })

  it('still delivers straight away to a worker the user is not controlling', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    const result = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'hi' })
    expect(result.value).toEqual({ delivered: true })
    expect(w1.handle.sent.at(-1)).toBe('[Arc] Message from the brain: hi')
  })

  it("holds sync_worker's message but still merges into the working copy", async () => {
    const rig = await start()
    await doneWorker(rig, 'one', 'api', { 'a.txt': 'a\n' })
    const w2 = await spawnWorker(rig, 'two', 'api')
    await rig.rig.service.stepInWorker(w2.workerId)
    const before = w2.handle.sent.length

    const result = await rig.call(rig.brain(), 'sync_worker', {
      workerId: 'W2',
      fromWorkerId: 'W1'
    })
    expect(result.value).toMatchObject({
      synced: true,
      files: ['api/a.txt'],
      notified: false,
      queued: true
    })
    expect(readFileSync(join(w2.treePath, 'a.txt'), 'utf8')).toBe('a\n')
    expect(w2.handle.sent).toHaveLength(before)
    const held = rig.rig.deps.heldMessagesRepo.listUndelivered(w2.workerId)
    expect(held).toHaveLength(1)
    expect(held[0]?.body).toContain("W1 one's changes to api/a.txt are now in your working copy.")
  })

  it('holds a message for a paused worker that has no process', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    w1.handle.interruptOutcome = 'killed'
    await rig.rig.service.stepInWorker(w1.workerId)
    expect(rig.rig.deps.workersRepo.get(w1.workerId)?.userControl).toBe('paused')
    const result = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'later' })
    expect(result.value).toEqual({ delivered: false, queued: true })
  })
})

describe('merges while the user is in control', () => {
  it('refuses merge_worker with worker_user_control before looking at the status', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api', { 'r.txt': 'r\n' })
    await rig.rig.service.stepInWorker(w1.workerId)
    const result = await rig.call(rig.brain(), 'merge_worker', { workerId: 'W1' })
    expect(result.isError).toBe(true)
    expect(result.value['error']).toBe('worker_user_control')
    expect(result.value['message']).toBe(
      'The user is controlling W1 api-retry right now. Try again after they hand it back.'
    )
  })

  it('merges again once the user hands the worker back and it is done', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api', { 'r.txt': 'r\n' })
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.rig.service.handBackWorker(w1.workerId)
    await finishWorker(rig, w1)
    const result = await rig.call(rig.brain(), 'merge_worker', { workerId: 'W1' })
    expect(result).toMatchObject({ isError: false, value: { merged: true } })
  })

  it('skips the automatic merge of a controlled worker, and tells the brain nothing', async () => {
    const rig = await start({ autoMergeDone: true })
    const w1 = await spawnWorker(rig, 'api-retry', 'api', { 'r.txt': 'r\n' })
    // Control stored without the in-memory guard: the worker settles as done, and only auto-merge's own check is left.
    rig.rig.deps.workersRepo.beginControl(w1.workerId, 'active', 1)
    await e?.call(w1.handle, 'report_done', { summary: 'Finished' })
    turn(w1.handle)
    await until(() => rig.rig.deps.workersRepo.get(w1.workerId)?.status === 'done')
    await settle(1500)
    expect(rig.rig.deps.workersRepo.get(w1.workerId)?.status).toBe('done')
    expect(brainSaw('automatically')).toBe(false)
    expect(brainSaw('could not merge')).toBe(false)
    expect(existsSync(w1.treePath)).toBe(true)
  })
})

describe('report_done while the user is in control', () => {
  it('is recorded but the worker keeps running, and is told at hand-back', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.call(w1.handle, 'report_done', { summary: 'All done' })
    turn(w1.handle)
    await settle(150)
    expect(w1.handle.stopped).toBe(false)
    const stored = rig.rig.deps.workersRepo.get(w1.workerId)
    expect(stored).toMatchObject({ summary: 'All done', userControl: 'active' })
    expect(stored?.status).not.toBe('done')

    await rig.rig.service.handBackWorker(w1.workerId)
    expect(w1.handle.sent.at(-1)).toBe(HAND_BACK_TEXT + HAND_BACK_REPORTED_DONE_TEXT)
    expect(w1.handle.stopped).toBe(false)
    // The next settled turn stops it normally.
    turn(w1.handle)
    await until(() => w1.handle.stopped)
  })

  it('puts a held message in the same hand-back turn as the reported-done note', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.call(w1.handle, 'report_done', { summary: 'All done' })
    await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'also bump the docs' })
    const before = w1.handle.sent.length

    await rig.rig.service.handBackWorker(w1.workerId)
    expect(w1.handle.sent.slice(before)).toEqual([
      [HAND_BACK_TEXT + HAND_BACK_REPORTED_DONE_TEXT, heldMessageText('also bump the docs')].join(
        '\n\n'
      )
    ])
    expect(rig.rig.deps.heldMessagesRepo.listUndelivered(w1.workerId)).toEqual([])
    // The first settled turn stops the worker; nothing was sent after it.
    turn(w1.handle)
    await until(() => w1.handle.stopped)
    expect(w1.handle.sent.slice(before)).toHaveLength(1)
  })

  it('leaves the plain hand-back text alone when it did not report done', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.rig.service.handBackWorker(w1.workerId)
    expect(w1.handle.sent.at(-1)).toBe(HAND_BACK_TEXT)
  })
})

describe('the hand-back summary', () => {
  it('tells the brain the changed files (committed, uncommitted, untracked) and the typed lines', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api', { 'old.txt': 'old\n' })
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.rig.service.sendWorkerInput(w1.workerId, 'use 5 retries')
    writeFileSync(join(w1.treePath, 'old.txt'), 'old\nretries = 5\n')
    writeFileSync(join(w1.treePath, 'fresh.txt'), 'new\n')
    git(w1.treePath, 'add', 'old.txt')
    git(w1.treePath, 'commit', '-m', 'Use 5 retries')
    writeFileSync(join(w1.treePath, 'README.md'), 'edited, not committed\n')

    await rig.rig.service.handBackWorker(w1.workerId)
    await until(() => brainSaw('handed W1 api-retry back'))
    const note = rig.brain().sent.find((t) => t.includes('handed W1 api-retry back')) ?? ''
    expect(note).toContain('old.txt |')
    expect(note).toContain('README.md |')
    expect(note).toContain('fresh.txt | untracked')
    expect(note).toContain('They sent 1 message; last: "use 5 retries".')
    expect(note).not.toContain('held message')
  })

  it('says there were no file changes and counts delivered held messages', async () => {
    const rig = await start()
    const w1 = await spawnWorker(rig, 'api-retry', 'api')
    await rig.rig.service.stepInWorker(w1.workerId)
    await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'check the docs' })
    await rig.rig.service.handBackWorker(w1.workerId)
    await until(() => brainSaw('handed W1 api-retry back'))
    expect(rig.brain().sent.find((t) => t.includes('handed W1 api-retry back'))).toBe(
      '[Arc] The user handed W1 api-retry back. Changed since they stepped in: no file changes. They sent no messages. It is continuing its task. Your held message was delivered.'
    )
  })
})

describe('handBackNote', () => {
  const summary = { changes: ['src/a.ts | 4 ++--'], messages: 2, lastMessage: 'use 5', held: 2 }

  it('has the tech-spec wording', () => {
    expect(handBackNote('W1 api-retry', summary)).toBe(
      '[Arc] The user handed W1 api-retry back. Changed since they stepped in: src/a.ts | 4 ++--. They sent 2 messages; last: "use 5". It is continuing its task. Your held messages were delivered.'
    )
  })

  it('pluralises one message and cuts a very long diffstat', () => {
    const one = handBackNote('W1 x', { ...summary, messages: 1, held: 0 })
    expect(one).toContain('They sent 1 message; last: "use 5".')
    expect(one).not.toContain('held')
    const long = handBackNote('W1 x', {
      ...summary,
      changes: Array.from({ length: 80 }, (_, i) => `file-${i}.ts | 1 +`)
    })
    expect(long).toContain('...')
    expect(long.length).toBeLessThan(900)
  })
})
