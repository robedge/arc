import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { git } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import {
  branchOf,
  doneWorker,
  eventTexts,
  finishWorker,
  handleOf,
  resolveConflict,
  resolverHandle,
  resolverStart,
  spawnWorker
} from './merge-rig'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-merge-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<string> {
  e = await makeEngineRig(dir(), overrides)
  return e.startSession('autonomous')
}

const mergeArgs = (workerId: string): Record<string, unknown> => ({ workerId })

describe('merge_worker, clean path', () => {
  it('merges a Done worker into the session branch, fast-forwards the checkout and removes the working copy', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    const before = gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    e.rig.pushed.length = 0

    const result = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(result).toMatchObject({
      isError: false,
      value: { merged: true, result: 'clean', files: ['api/retry.txt'] }
    })

    // The session branch holds a merge commit with the worker's commit under it.
    const tip = gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    expect(tip).not.toBe(before)
    expect(gitIn(e.api.path, 'log', '-1', '--format=%s', tip)).toBe('Merge W1 api-retry')
    expect(gitIn(e.api.path, 'log', '--format=%s', `${before}..${tip}`).split('\n')).toEqual([
      'Merge W1 api-retry',
      'api-retry: retry.txt'
    ])
    // The user's checkout moved with it, files included.
    expect(gitIn(e.api.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(readFileSync(join(e.api.path, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(gitIn(e.api.path, 'status', '--porcelain')).toBe('')

    // Bookkeeping: card, merges row, event log, pushes.
    expect(e.rig.deps.workersRepo.get(w1.workerId)?.status).toBe('merged')
    const rows = e.rig.deps.mergesRepo.listByWorker(w1.workerId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ result: 'clean', mergeSha: tip, sessionId })
    expect(JSON.parse(rows[0]?.filesJson ?? '[]')).toEqual(['api/retry.txt'])
    expect(eventTexts(e, sessionId)).toContain(`Merged W1 api-retry into ${branch}`)
    const pushedStatuses = e.rig
      .of('session:worker-changed')
      .filter((p) => p.worker.id === w1.workerId)
      .map((p) => p.worker.status)
    expect(pushedStatuses).toContain('merged')
    expect(e.rig.of('session:event-logged').length).toBeGreaterThan(0)

    // The worker's working copy and the temporary merge working copy are gone.
    expect(existsSync(w1.treePath)).toBe(false)
    expect(e.rig.deps.worktreesRepo.listByWorker(w1.workerId)[0]?.removedAt).not.toBeNull()
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId, '_merge'))).toBe(false)
    // No empty session folder is left behind once every working copy is gone.
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId))).toBe(false)
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain('_merge')
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain(w1.treePath)
  })

  it('refuses a worker that is not Done, merged twice, or unknown', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'api-retry', 'api', { 'retry.txt': 'r\n' })
    const early = await e.call(e.brain(), 'merge_worker', mergeArgs(w1.workerId))
    expect(early).toMatchObject({ isError: true, value: { error: 'worker_not_done' } })
    await finishWorker(e, w1)
    expect((await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))).isError).toBe(false)
    const again = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(again.value['error']).toBe('already_merged')
    const unknown = await e.call(e.brain(), 'merge_worker', mergeArgs('W9'))
    expect(unknown.value['error']).toBe('unknown_worker')
    expect(eventTexts(e, sessionId).filter((t) => t.startsWith('Merged'))).toHaveLength(1)
  })

  it('merges two workers one after the other onto the same branch', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await doneWorker(e, 'one', 'api', { 'one.txt': '1\n' })
    await doneWorker(e, 'two', 'api', { 'two.txt': '2\n' })
    const [a, b] = await Promise.all([
      e.call(e.brain(), 'merge_worker', mergeArgs('W1')),
      e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    ])
    expect(a.value['result']).toBe('clean')
    expect(b.value['result']).toBe('clean')
    expect(readFileSync(join(e.api.path, 'one.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(e.api.path, 'two.txt'), 'utf8')).toBe('2\n')
    expect(gitIn(e.api.path, 'log', '--merges', '--format=%s', branch).split('\n').sort()).toEqual([
      'Merge W1 one',
      'Merge W2 two'
    ])
  })
})

describe('merge_worker, checkout state', () => {
  it('does not touch a dirty checkout: the branch ref stays, the event log says so', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    const before = gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    writeFileSync(join(e.api.path, 'README.md'), 'hello\nunsaved\n')

    const result = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(result.value).toMatchObject({
      merged: true,
      result: 'clean',
      pendingFastForward: ['api']
    })
    expect(gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)).toBe(before)
    expect(gitIn(e.api.path, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(join(e.api.path, 'README.md'), 'utf8')).toBe('hello\nunsaved\n')
    expect(existsSync(join(e.api.path, 'retry.txt'))).toBe(false)
    expect(eventTexts(e, sessionId)).toContain(
      'Session branch update waiting: your checkout of api has unsaved changes'
    )
    // The work is still safe: the merge commit is kept under the pending ref, and the card is Merged.
    const pending = gitIn(e.api.path, 'rev-parse', 'refs/arc/pending/' + branch.replace('arc/', ''))
    expect(gitIn(e.api.path, 'log', '-1', '--format=%s', pending)).toBe('Merge W1 api-retry')
    expect(e.rig.deps.workersRepo.get(w1.workerId)?.status).toBe('merged')
  })

  it('builds the next merge on the pending one, then fast-forwards when the checkout is clean (on session open)', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await doneWorker(e, 'one', 'api', { 'one.txt': '1\n' })
    await doneWorker(e, 'two', 'api', { 'two.txt': '2\n' })
    writeFileSync(join(e.api.path, 'README.md'), 'hello\nunsaved\n')
    await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    const second = await e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    expect(second.value['pendingFastForward']).toEqual(['api'])
    // The waiting note is written once, not on every merge.
    expect(
      eventTexts(e, sessionId).filter((t) => t.startsWith('Session branch update waiting'))
    ).toHaveLength(1)

    // Still dirty: opening the session changes nothing.
    await e.rig.service.open(sessionId)
    expect(existsSync(join(e.api.path, 'one.txt'))).toBe(false)

    // The user saves their edit away; the next open applies both merges at once.
    git(e.api.path, 'checkout', 'README.md')
    await e.rig.service.open(sessionId)
    // The retry runs in the background after the snapshot is returned.
    await until(() =>
      e ? eventTexts(e, sessionId).includes('Session branch updated in api') : false
    )
    const tip = gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    expect(gitIn(e.api.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(readFileSync(join(e.api.path, 'one.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(e.api.path, 'two.txt'), 'utf8')).toBe('2\n')
    expect(gitIn(e.api.path, 'log', '--merges', '--format=%s', branch).split('\n')).toEqual([
      'Merge W2 two',
      'Merge W1 one'
    ])
    expect(eventTexts(e, sessionId)).toContain('Session branch updated in api')
  })

  it('moves only the ref when the user has switched to another branch', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    git(e.api.path, 'checkout', 'dev')
    const result = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(result.value['pendingFastForward']).toBeUndefined()
    expect(gitIn(e.api.path, 'log', '-1', '--format=%s', `refs/heads/${branch}`)).toBe(
      'Merge W1 api-retry'
    )
    expect(gitIn(e.api.path, 'symbolic-ref', '--short', 'HEAD')).toBe('dev')
    expect(existsSync(join(e.api.path, 'retry.txt'))).toBe(false)
  })

  it('keeps and logs a working copy that git refuses to remove', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const w1 = await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    writeFileSync(join(w1.treePath, 'scratch.txt'), 'uncommitted\n')
    const result = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(result.value['merged']).toBe(true)
    expect(existsSync(w1.treePath)).toBe(true)
    expect(e.rig.deps.worktreesRepo.listByWorker(w1.workerId)[0]?.removedAt).toBeNull()
    expect(eventTexts(e, sessionId).some((t) => t.startsWith('Kept the working copy of W1'))).toBe(
      true
    )
  })
})

describe('merge conflicts', () => {
  async function twoConflictingWorkers(sessionId: string): Promise<void> {
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'README.md': 'hello\nretry on failure\n' })
    await doneWorker(e, 'api-timeout', 'api', { 'README.md': 'hello\ntimeout of 5s\n' })
    const first = await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(first.value['result']).toBe('clean')
    expect(branchOf(e, sessionId)).not.toBe('')
  }

  it('starts a resolver in the merge working copy and merges once it commits the resolution', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await twoConflictingWorkers(sessionId)

    const pending = e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    const resolver = await resolverStart(e)
    expect(resolver.cwd.startsWith(join(dir(), 'userData', 'worktrees', sessionId, '_merge'))).toBe(
      true
    )
    expect(existsSync(resolver.cwd)).toBe(true)
    expect(resolver.instructions).toContain('README.md')
    expect(resolverHandle(e, resolver).sent[0]).toContain('Conflicted files: README.md')
    // The temporary merge copy is in the middle of the conflicted merge.
    expect(gitIn(resolver.cwd, 'diff', '--name-only', '--diff-filter=U')).toBe('README.md')
    expect(
      e.rig.deps.workersRepo.get(e.rig.deps.workersRepo.listBySession(sessionId)[2]?.id ?? '')?.slug
    ).toBe('merge-conflict')

    await resolveConflict(e, resolver, 'README.md', 'hello\nretry on failure\ntimeout of 5s\n')
    const result = await pending
    expect(result).toMatchObject({
      isError: false,
      value: { merged: true, result: 'resolved', files: ['api/README.md'] }
    })

    // Both changes are on the session branch and in the user's checkout.
    expect(readFileSync(join(e.api.path, 'README.md'), 'utf8')).toBe(
      'hello\nretry on failure\ntimeout of 5s\n'
    )
    expect(gitIn(e.api.path, 'rev-parse', 'HEAD')).toBe(
      gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    )
    const subjects = gitIn(e.api.path, 'log', '--format=%s', branch)
    expect(subjects).toContain('api-retry: README.md')
    expect(subjects).toContain('api-timeout: README.md')
    expect(
      e.rig.deps.mergesRepo.listByWorker(
        e.rig.deps.workersRepo.listBySession(sessionId)[1]?.id ?? ''
      )[0]
    ).toMatchObject({
      result: 'resolved'
    })
    const texts = eventTexts(e, sessionId)
    expect(texts).toContain('Resolved conflict in api/README.md')
    expect(texts).toContain(`Merged W2 api-timeout into ${branch}`)
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId, '_merge'))).toBe(false)
    expect(gitIn(e.api.path, 'worktree', 'list')).not.toContain('_merge')
    expect(
      e.rig.deps.workersRepo.get(e.rig.deps.workersRepo.listBySession(sessionId)[1]?.id ?? '')
        ?.status
    ).toBe('merged')
  }, 30000)

  it('finishes the merge itself when the resolver staged everything but did not commit', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await twoConflictingWorkers(sessionId)
    const pending = e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    const resolver = await resolverStart(e)
    writeFileSync(join(resolver.cwd, 'README.md'), 'hello\nboth\n')
    git(resolver.cwd, 'add', 'README.md')
    const handle = resolverHandle(e, resolver)
    await e.call(handle, 'report_done', { summary: 'Staged' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    expect((await pending).value['result']).toBe('resolved')
    expect(readFileSync(join(e.api.path, 'README.md'), 'utf8')).toBe('hello\nboth\n')
  }, 30000)

  it('fails the merge and leaves the branch alone when the resolver ends without resolving', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await twoConflictingWorkers(sessionId)
    const before = gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)
    const pending = e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    const resolver = await resolverStart(e)
    const handle = resolverHandle(e, resolver)
    const resolverId = handle.agentId.replace('worker-', '')
    await e.call(handle, 'report_done', { summary: 'Gave up' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    const result = await pending
    expect(result).toMatchObject({ isError: true, value: { error: 'merge_failed' } })
    expect(gitIn(e.api.path, 'rev-parse', `refs/heads/${branch}`)).toBe(before)
    expect(e.rig.deps.workersRepo.get(resolverId)?.id).toBe(resolverId)
    const w2 = e.rig.deps.workersRepo.listBySession(sessionId).find((w) => w.slug === 'api-timeout')
    expect(w2?.status).toBe('done')
    expect(e.rig.deps.mergesRepo.listByWorker(w2?.id ?? '')[0]?.result).toBe('failed')
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId, '_merge'))).toBe(false)
  }, 30000)

  it('escalates an unsure resolver to the user as a question naming the file, then finishes after the answer', async () => {
    const sessionId = await start({ timings: { brainAnswerMs: 150 } })
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await twoConflictingWorkers(sessionId)
    const pending = e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    const resolver = await resolverStart(e)
    const handle = resolverHandle(e, resolver)
    const asked = e.call(handle, 'ask_brain', {
      question: 'W1 added a retry line and W2 added a timeout line. Keep both, or prefer one?'
    })

    // No brain answer: after the timeout the question goes to the user and the merge call returns.
    const early = await pending
    expect(early).toMatchObject({
      isError: false,
      value: { merged: false, result: 'needs_user', files: ['api/README.md'] }
    })
    const state = e.rig.service.attentionState(sessionId)
    expect(state.count).toBe(1)
    const request = state.requests[0]
    expect(request?.question).toContain('api/README.md')
    expect(request?.question).toContain('W2 api-timeout')
    expect(request?.question).toContain('W1 added a retry line and W2 added a timeout line')

    // The user answers; the resolver commits; the merge finishes and the brain is told.
    e.rig.service.answerAttention(request?.id ?? '', { text: 'Keep both lines.' })
    expect((await asked).value['answer']).toBe('Keep both lines.')
    await resolveConflict(e, resolver, 'README.md', 'hello\nretry on failure\ntimeout of 5s\n')
    await until(
      () =>
        e
          ?.brain()
          .sent.some((t) => t.includes('is merged now that the conflict question was answered')) ??
        false
    )
    const w2 = e.rig.deps.workersRepo.listBySession(sessionId).find((w) => w.slug === 'api-timeout')
    expect(w2?.status).toBe('merged')
    expect(e.rig.deps.mergesRepo.listByWorker(w2?.id ?? '')[0]?.result).toBe('needs_user')
    expect(readFileSync(join(e.api.path, 'README.md'), 'utf8')).toContain('timeout of 5s')
    expect(gitIn(e.api.path, 'log', '-1', '--format=%s', branch)).toBe('Merge W2 api-timeout')
  }, 30000)
  it('opens the session without waiting for a merge that is held for the user', async () => {
    const sessionId = await start({ timings: { brainAnswerMs: 150 } })
    if (!e) throw new Error('rig')
    await twoConflictingWorkers(sessionId)
    const pending = e.call(e.brain(), 'merge_worker', mergeArgs('W2'))
    const resolver = await resolverStart(e)
    const handle = resolverHandle(e, resolver)
    const asked = e.call(handle, 'ask_brain', { question: 'Keep both, or prefer one?' })
    expect(await pending).toMatchObject({ value: { result: 'needs_user' } })

    // The merge queue of the repository is held until the user answers.
    const outcome = await Promise.race([
      e.rig.service.open(sessionId),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3000))
    ])
    expect(outcome).not.toBe('hung')
    if (outcome === 'hung' || !('header' in outcome)) throw new Error('open did not return')
    expect(outcome.attention).toHaveLength(1)
    expect(outcome.attention[0]?.kind === 'question' && outcome.attention[0].question).toContain(
      'api/README.md'
    )
    expect(outcome.workers.filter((w) => w.role === 'resolver')).toHaveLength(1)
    expect(outcome.workers.filter((w) => w.role === 'worker').length).toBeGreaterThan(0)

    // Clean up: answer so the held merge ends before the rig closes.
    const request = e.rig.service.attentionState(sessionId).requests[0]
    e.rig.service.answerAttention(request?.id ?? '', { text: 'Keep both lines.' })
    await asked
    await resolveConflict(e, resolver, 'README.md', 'hello\nretry on failure\ntimeout of 5s\n')
  }, 30000)
})

describe('sync_worker', () => {
  it("brings a merged worker's change into a running worker and tells it", async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'retry_status.sql': 'alter table x;\n' })
    const w3 = await spawnWorker(e, 'web-client', 'api')
    await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    expect(existsSync(join(w3.treePath, 'retry_status.sql'))).toBe(false)

    const result = await e.call(e.brain(), 'sync_worker', {
      workerId: 'W2',
      fromWorkerId: 'W1',
      note: 'retry_status column'
    })
    expect(result).toMatchObject({
      isError: false,
      value: { synced: true, files: ['api/retry_status.sql'], notified: true }
    })
    expect(readFileSync(join(w3.treePath, 'retry_status.sql'), 'utf8')).toBe('alter table x;\n')
    expect(w3.handle.sent.at(-1)).toContain("W1 api-retry's changes are now in your working copy")
    expect(w3.handle.sent.at(-1)).toContain('retry_status column')
    expect(eventTexts(e, sessionId)).toContain('Shared W1 → W2: retry_status column')
  })

  it('uses a default note listing the files, and can share a Done worker that is not merged yet', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'api-retry', 'api', { 'a.txt': 'a\n' })
    const w2 = await spawnWorker(e, 'second', 'api')
    const result = await e.call(e.brain(), 'sync_worker', { workerId: 'W2', fromWorkerId: 'W1' })
    expect(result.value).toMatchObject({ synced: true, files: ['api/a.txt'], notified: true })
    expect(w2.handle.sent.at(-1)).toContain(
      "W1 api-retry's changes to api/a.txt are now in your working copy."
    )
    expect(eventTexts(e, sessionId)).toContain('Shared W1 → W2: api/a.txt')
  })

  it('leaves conflicts for the receiving worker and says so in the message', async () => {
    await start()
    if (!e) throw new Error('rig')
    await doneWorker(e, 'one', 'api', { 'README.md': 'hello\nfrom one\n' })
    const w2 = await spawnWorker(e, 'two', 'api', { 'README.md': 'hello\nfrom two\n' })
    const result = await e.call(e.brain(), 'sync_worker', { workerId: 'W2', fromWorkerId: 'W1' })
    expect(result.value).toMatchObject({ synced: true, conflicts: ['api/README.md'] })
    expect(w2.handle.sent.at(-1)).toContain('conflicts in api/README.md')
    expect(gitIn(w2.treePath, 'diff', '--name-only', '--diff-filter=U')).toBe('README.md')
  })

  it('refuses an unfinished source, the same worker twice, and workers with no repo in common', async () => {
    await start()
    if (!e) throw new Error('rig')
    const w1 = await spawnWorker(e, 'one', 'api', { 'a.txt': 'a\n' })
    await spawnWorker(e, 'two', 'api')
    const notReady = await e.call(e.brain(), 'sync_worker', { workerId: 'W2', fromWorkerId: 'W1' })
    expect(notReady.value['error']).toBe('source_not_ready')
    const same = await e.call(e.brain(), 'sync_worker', { workerId: 'W1', fromWorkerId: 'W1' })
    expect(same.value['error']).toBe('invalid_sync')
    await finishWorker(e, w1)
    await spawnWorker(e, 'web', 'web')
    const none = await e.call(e.brain(), 'sync_worker', { workerId: 'W3', fromWorkerId: 'W1' })
    expect(none.value['error']).toBe('no_shared_repo')
    const unknown = await e.call(e.brain(), 'sync_worker', { workerId: 'W9', fromWorkerId: 'W1' })
    expect(unknown.value['error']).toBe('unknown_worker')
    expect(handleOf(e, w1.workerId)).toBeDefined()
  })
})

describe('final summary', () => {
  it('prompts the brain once every worker is merged or failed, with the machine-made commit list', async () => {
    const sessionId = await start()
    if (!e) throw new Error('rig')
    const branch = branchOf(e, sessionId)
    await doneWorker(e, 'api-retry', 'api', { 'retry.txt': 'retry\n' })
    const w2 = await spawnWorker(e, 'docs', 'web', { 'docs.md': 'docs\n' })
    await e.call(e.brain(), 'merge_worker', mergeArgs('W1'))
    // W2 is still running: no summary yet.
    await new Promise((r) => setTimeout(r, 100))
    expect(e.brain().sent.some((t) => t.startsWith('[Arc] All workers finished'))).toBe(false)

    w2.handle.emit({ type: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })
    await until(
      () => e?.brain().sent.some((t) => t.startsWith('[Arc] All workers finished')) ?? false
    )
    const summary = e.brain().sent.find((t) => t.startsWith('[Arc] All workers finished')) ?? ''
    expect(
      summary.startsWith(
        '[Arc] All workers finished. Summarise per repository: what changed, the commits on the session branch, and anything left undone.'
      )
    ).toBe(true)
    expect(summary).toContain('W1 api-retry: merged')
    expect(summary).toContain('W2 docs: failed')
    expect(summary).toContain(`api (${branch}, base dev):`)
    expect(summary).toContain('Merge W1 api-retry')
    expect(summary).toContain('api-retry: retry.txt')
    expect(summary).toContain('web (' + branch + ', base dev):')
    expect(summary).toContain('(no commits)')
    expect(summary).toContain('W2 docs failed; its work was not merged.')
    expect(e.brain().sent.filter((t) => t.startsWith('[Arc] All workers finished'))).toHaveLength(1)
  })
})
