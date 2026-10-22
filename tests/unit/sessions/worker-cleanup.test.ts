import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import {
  branchOf,
  doneWorker,
  eventTexts,
  finishWorker,
  resolveConflict,
  resolverHandle,
  resolverStart,
  spawnWorker
} from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-worker-cleanup-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<string> {
  e = await makeEngineRig(dir(), overrides)
  return e.startSession('autonomous')
}

describe('workers:stop removes the working copy', () => {
  it('removes the working copy of a user-stopped worker and logs the discarded commits', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    expect(existsSync(w1.treePath)).toBe(true)

    await e.rig.service.stopWorker(w1.workerId)

    expect(e.rig.deps.workersRepo.get(w1.workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user'
    })
    expect(existsSync(w1.treePath)).toBe(false)
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId))).toBe(false)
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain(w1.treePath)
    expect(e.rig.deps.worktreesRepo.listByWorker(w1.workerId)[0]?.removedAt).not.toBeNull()
    expect(eventTexts(e, sessionId)).toContain(
      'Stopped by you; working copy removed (1 unmerged commit discarded)'
    )
    const view = e.rig.service.snapshot(sessionId).workers[0]
    expect(view).toMatchObject({ status: 'stopped', hasWorkingCopy: false, unmergedCommits: 0 })
  })

  it('says nothing about commits when there were none to discard', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api')
    await e.rig.service.stopWorker(w1.workerId)
    expect(eventTexts(e, sessionId)).toContain('Stopped by you; working copy removed')
  })

  it('reports the unmerged commits and the working copy in workers:get before the stop', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const details = await e.rig.service.workerDetails(w1.workerId)
    expect(details).toMatchObject({ hasWorkingCopy: true, unmergedCommits: 2 })
  })

  it('keeps the working copy of a worker stopped by quitting Arc', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    await e.rig.service.shutdown()
    expect(e.rig.deps.workersRepo.get(w1.workerId)).toMatchObject({
      status: 'stopped',
      stoppedBy: 'quit'
    })
    expect(existsSync(w1.treePath)).toBe(true)
    expect(e.rig.deps.worktreesRepo.listByWorker(w1.workerId)[0]?.removedAt).toBeNull()
    expect(eventTexts(e, sessionId).some((t) => t.includes('working copy removed'))).toBe(false)
  })
})

describe('workers:remove', () => {
  it('hides a finished worker, removes its working copy and keeps the row', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    expect(e.rig.service.snapshot(sessionId).workers).toHaveLength(1)

    await e.rig.service.removeWorker(w1.workerId)

    expect(e.rig.service.snapshot(sessionId).workers).toEqual([])
    expect(existsSync(w1.treePath)).toBe(false)
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain(w1.treePath)
    // The row stays for the history; its number is not reused.
    expect(e.rig.deps.workersRepo.get(w1.workerId)?.removedAt).not.toBeNull()
    expect(eventTexts(e, sessionId)).toContain('Removed W1 api-retry (1 unmerged commit discarded)')
    await expect(e.rig.service.workerDetails(w1.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(e.rig.service.removeWorker(w1.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    const second = await spawnWorker(e, 'docs', 'web')
    expect(e.rig.deps.workersRepo.get(second.workerId)?.number).toBe(2)
  })

  it('leaves a removed worker out of get_worker_status', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    await doneWorker(e, 'docs', 'web', { 'docs.md': 'docs\n' })
    await e.rig.service.removeWorker(w1.workerId)
    const status = await e.call(e.brain(), 'get_worker_status', {})
    const listed = JSON.stringify(status.value)
    expect(listed).toContain('"name":"docs"')
    expect(listed).not.toContain('api-retry')
    const asked = await e.call(e.brain(), 'get_worker_status', { workerId: 'W1' })
    expect(asked.value['error']).toBe('unknown_worker')
  })

  it('removes a merged worker without discarding anything', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    await e.call(e.brain(), 'merge_worker', { workerId: 'W1' })
    const id = e.rig.deps.workersRepo.listBySession(sessionId)[0]?.id ?? ''
    await e.rig.service.removeWorker(id)
    expect(eventTexts(e, sessionId)).toContain('Removed W1 api-retry')
    expect(e.rig.service.snapshot(sessionId).workers).toEqual([])
  })

  it('refuses a running worker and a queued worker', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    e.rig.service.setConfig(sessionId, { workerLimit: 1 })
    const running = await spawnWorker(e, 'api-retry', 'api')
    const queued = await e.call(e.brain(), 'spawn_worker', {
      name: 'docs',
      task: 'Do docs',
      repos: ['web']
    })
    expect(queued.value['status']).toBe('queued')
    await expect(e.rig.service.removeWorker(running.workerId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(
      e.rig.service.removeWorker(String(queued.value['workerId']))
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    expect(existsSync(running.treePath)).toBe(true)
    expect(e.rig.service.snapshot(sessionId).workers).toHaveLength(2)
  })
})

describe('automatic merge of a Done worker', () => {
  const brainSaw = (prefix: string): boolean =>
    e?.brain().sent.some((t) => t.startsWith(prefix)) ?? false

  it('merges a clean worker by itself and tells the brain', async () => {
    const sessionId = await start({ autoMergeDone: true })
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    await finishWorker(e, w1)
    await until(() => e?.rig.deps.workersRepo.get(w1.workerId)?.status === 'merged')

    expect(readFileSync(join(e.api.path, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(gitIn(e.api.path, 'log', '-1', '--format=%s', branch)).toBe('Merge W1 api-retry')
    expect(existsSync(w1.treePath)).toBe(false)
    expect(eventTexts(e, sessionId)).toContain(`Merged W1 api-retry into ${branch}`)
    await until(() => brainSaw(`[Arc] Merged W1 api-retry into ${branch} automatically.`))
    // The brain is not told "finished" as well: it has nothing left to do.
    expect(brainSaw('[Arc] W1 api-retry finished')).toBe(false)
    const again = await e.call(e.brain(), 'merge_worker', { workerId: 'W1' })
    expect(again.value['error']).toBe('already_merged')
  })

  it('runs the conflict resolver and tells the brain the merge was resolved', async () => {
    const sessionId = await start({ autoMergeDone: true })
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'README.md': 'hello\nretry\n' })
    const w2 = await spawnWorker(e, 'api-timeout', 'api', { 'README.md': 'hello\ntimeout\n' })
    await finishWorker(e, w1)
    await until(() => e?.rig.deps.workersRepo.get(w1.workerId)?.status === 'merged')
    await finishWorker(e, w2)

    const resolver = await resolverStart(e)
    await resolveConflict(e, resolver, 'README.md', 'hello\nretry\ntimeout\n')
    await until(() => e?.rig.deps.workersRepo.get(w2.workerId)?.status === 'merged')

    expect(readFileSync(join(e.api.path, 'README.md'), 'utf8')).toBe('hello\nretry\ntimeout\n')
    await until(() => brainSaw(`[Arc] Merged W2 api-timeout into ${branch} automatically.`))
    const note = e.brain().sent.find((t) => t.startsWith('[Arc] Merged W2')) ?? ''
    expect(note).toContain('A conflict was resolved by a conflict resolver.')
  })

  it('tells the brain when the conflict needs the user, then when the merge finishes', async () => {
    const sessionId = await start({ autoMergeDone: true, timings: { brainAnswerMs: 150 } })
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'README.md': 'hello\nretry\n' })
    const w2 = await spawnWorker(e, 'api-timeout', 'api', { 'README.md': 'hello\ntimeout\n' })
    await finishWorker(e, w1)
    await until(() => e?.rig.deps.workersRepo.get(w1.workerId)?.status === 'merged')
    await finishWorker(e, w2)
    const resolver = await resolverStart(e)
    const asked = e.call(resolverHandle(e, resolver), 'ask_brain', {
      question: 'Keep both lines, or prefer one?'
    })
    await until(() => brainSaw('[Arc] W2 api-timeout is done. Merging it into'))
    const note = e.brain().sent.find((t) => t.startsWith('[Arc] W2 api-timeout is done')) ?? ''
    expect(note).toContain(`into ${branch} hit a conflict`)
    expect(e.rig.deps.workersRepo.get(w2.workerId)?.status).toBe('done')

    const request = e.rig.service.attentionState(sessionId).requests[0]
    e.rig.service.answerAttention(request?.id ?? '', { text: 'Keep both lines.' })
    await asked
    await resolveConflict(e, resolver, 'README.md', 'hello\nretry\ntimeout\n')
    await until(() => brainSaw('[Arc] W2 api-timeout is merged now that the conflict question'))
    expect(e.rig.deps.workersRepo.get(w2.workerId)?.status).toBe('merged')
  })

  it('does not merge by itself when the feature is off', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    await new Promise((r) => setTimeout(r, 150))
    expect(e.rig.deps.workersRepo.get(w1.workerId)?.status).toBe('done')
    expect(brainSaw('[Arc] W1 api-retry finished')).toBe(true)
  })
})
