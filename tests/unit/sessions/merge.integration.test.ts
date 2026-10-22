import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { gitIn, makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { fakeAdapter, records } from './fake-cli'
import { branchOf, eventTexts } from './merge-rig'

const dir = useTempDir('arc-merge-int-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

interface Run {
  rig: EngineRig
  sessionId: string
  logPath: string
}

async function runScenario(scenario: string): Promise<Run> {
  const logPath = join(dir(), 'fake.log')
  e = await makeEngineRig(dir(), { adapter: fakeAdapter(scenario, logPath) })
  const created = await e.rig.service.create(e.rig.groupId, 'Work on the api', 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  return { rig: e, sessionId: created.sessionId, logPath }
}

const statusOf = (r: Run, slug: string): string | undefined =>
  r.rig.rig.deps.workersRepo.listBySession(r.sessionId).find((w) => w.slug === slug)?.status

const brainTexts = (r: Run): string[] =>
  r.rig.rig.messagesRepo.latest(r.sessionId, 50).map((m) => m.content)

const mergeResults = (r: Run): { isError: boolean; text: string }[] =>
  records(r.logPath).flatMap((x) => (x.mcpResult?.tool === 'merge_worker' ? [x.mcpResult] : []))

describe('merging through the bridge with the fake CLI', () => {
  it('merges a Done worker: card Merged, commit on the session branch, checkout updated, summary prompt', async () => {
    const r = await runScenario('merge-clean')
    await until(() => statusOf(r, 'api-retry') === 'merged', 40000)
    await until(() => brainTexts(r).includes('Summary: retry.txt was added to api.'), 40000)
    const { rig, sessionId } = r
    const branch = branchOf(rig, sessionId)

    expect(mergeResults(r)).toHaveLength(1)
    expect(mergeResults(r)[0]?.isError).toBe(false)
    expect(JSON.parse(mergeResults(r)[0]?.text ?? '{}')).toMatchObject({
      merged: true,
      result: 'clean',
      files: ['api/retry.txt']
    })
    expect(gitIn(rig.api.path, 'log', '--format=%s', branch).split('\n')).toEqual([
      'Merge W1 api-retry',
      'Add retry',
      'Initial commit'
    ])
    expect(gitIn(rig.api.path, 'rev-parse', 'HEAD')).toBe(
      gitIn(rig.api.path, 'rev-parse', `refs/heads/${branch}`)
    )
    expect(readFileSync(join(rig.api.path, 'retry.txt'), 'utf8')).toBe('retry\n')
    expect(eventTexts(rig, sessionId)).toContain(`Merged W1 api-retry into ${branch}`)

    // The working copies are gone.
    const tree = rig.rig.deps.worktreesRepo.listBySession(sessionId)[0]
    expect(existsSync(tree?.path ?? '')).toBe(false)
    expect(gitIn(rig.api.path, 'worktree', 'list').split('\n')).toHaveLength(1)

    // The brain was given the machine-made commit list.
    const prompt = records(r.logPath)
      .map((x) => JSON.stringify(x.stdin ?? ''))
      .find((l) => l.includes('All workers finished'))
    expect(prompt).toContain('Summarise per repository')
    expect(prompt).toContain('Merge W1 api-retry')
    expect(prompt).toContain('Add retry')
  }, 60000)

  it('resolves a conflict with a resolver worker and logs it', async () => {
    const r = await runScenario('merge-conflict')
    await until(() => statusOf(r, 'api-timeout') === 'merged', 60000)
    await until(() => brainTexts(r).includes('Summary: README.md has both notes.'), 40000)
    const { rig, sessionId } = r

    const results = mergeResults(r).map((m) => JSON.parse(m.text) as Record<string, unknown>)
    expect(results.map((m) => m['result'])).toEqual(['clean', 'resolved'])
    expect(readFileSync(join(rig.api.path, 'README.md'), 'utf8')).toBe(
      'hello\nretry on failure\ntimeout of 5s\n'
    )
    const branch = branchOf(rig, sessionId)
    const subjects = gitIn(rig.api.path, 'log', '--format=%s', branch)
    expect(subjects).toContain('Note the retry')
    expect(subjects).toContain('Note the timeout')
    expect(eventTexts(rig, sessionId)).toContain('Resolved conflict in api/README.md')
    expect(
      records(r.logPath).some((x) => x.argv?.some((a) => a.includes('[arc-worker:merge-conflict]')))
    ).toBe(true)
    expect(existsSync(join(dir(), 'userData', 'worktrees', sessionId, '_merge'))).toBe(false)
    const prompt = records(r.logPath)
      .map((x) => JSON.stringify(x.stdin ?? ''))
      .find((l) => l.includes('All workers finished'))
    expect(prompt).toContain('Conflicts resolved during merges')
    expect(prompt).toContain('api/README.md')
  }, 90000)

  it('raises a Needs attention question naming the file for an unsure resolver', async () => {
    const r = await runScenario('merge-unresolvable')
    await until(() => r.rig.rig.service.attentionState(r.sessionId).count === 1, 60000)
    const { rig, sessionId } = r
    const request = rig.rig.service.attentionState(sessionId).requests[0]
    expect(request?.question).toContain('api/README.md')
    expect(request?.question).toContain('W2 api-timeout')
    expect(request?.question).toContain('W1 notes a retry on failure, W2 notes a 5 second timeout')

    await until(() => mergeResults(r).length === 2, 30000)
    expect(JSON.parse(mergeResults(r)[1]?.text ?? '{}')).toMatchObject({
      merged: false,
      result: 'needs_user'
    })
    expect(statusOf(r, 'api-timeout')).toBe('done')

    rig.rig.service.answerAttention(request?.id ?? '', { text: 'Keep both lines.' })
    await until(() => statusOf(r, 'api-timeout') === 'merged', 60000)
    expect(readFileSync(join(rig.api.path, 'README.md'), 'utf8')).toBe(
      'hello\nretry on failure\ntimeout of 5s\n'
    )
    await until(() => brainTexts(r).includes('Merged after the answer.'), 30000)
    const w2 = rig.rig.deps.workersRepo
      .listBySession(sessionId)
      .find((w) => w.slug === 'api-timeout')
    expect(rig.rig.deps.mergesRepo.listByWorker(w2?.id ?? '')[0]?.result).toBe('needs_user')
  }, 120000)

  it('shares W1 with W3 and tells W3', async () => {
    const r = await runScenario('merge-sync')
    await until(
      () => eventTexts(r.rig, r.sessionId).includes('Shared W1 → W3: retry_status column'),
      60000
    )
    await until(() => statusOf(r, 'api-client') === 'done', 60000)
    const shell = records(r.logPath).flatMap((x) => {
      const rec = x as { shell?: { cmd: string; code: number; out: string } }
      return rec.shell ? [rec.shell] : []
    })
    const check = shell.find((s) => s.cmd.startsWith('test -f retry_status.sql'))
    expect(check).toMatchObject({ code: 0 })
    expect(check?.out).toContain('present')
    expect(statusOf(r, 'api-retry')).toBe('merged')
  }, 90000)
})
