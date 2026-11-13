// @spec: 013-session-branches-on-demand
// @regression
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import { AttentionService } from '../../../src/main/sessions/attention-service'
import type { AttentionNotice } from '../../../src/main/sessions/attention-service'
import { SessionService } from '../../../src/main/sessions/session-service'
import { trackedFile } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-branch-attention-')
let e: EngineRig | undefined

afterEach(async () => {
  // A push that reads git may still be in flight; let it finish before the database closes.
  await new Promise((resolve) => setTimeout(resolve, 60))
  await e?.close()
  e = undefined
})

interface Wired {
  attention: AttentionService
  pushes: IpcEvents['session:attention'][]
  notices: AttentionNotice[]
}

/** An engine rig whose branch-question changes reach a real AttentionService. */
async function rigWithAttention(): Promise<{ rig: EngineRig; wired: Wired }> {
  const wired = { pushes: [], notices: [] } as unknown as Wired
  wired.pushes = []
  wired.notices = []
  const rig = await makeEngineRig(dir(), {
    onBranchQuestionsChanged: (id) => wired.attention.onBranchQuestionsChanged(id)
  })
  wired.attention = new AttentionService({
    sessions: rig.rig.service,
    attentionRepo: rig.rig.deps.attentionRepo,
    branchQuestionsRepo: rig.rig.deps.branchQuestionsRepo,
    sessionsRepo: rig.rig.sessionsRepo,
    workerOf: (id) => rig.rig.deps.workersRepo.get(id),
    emit: (_event, payload) => void wired.pushes.push(payload),
    onNewRequest: (n) => wired.notices.push(n)
  })
  return { rig, wired }
}

const spawnArgs = (name: string, repos: string[]): Record<string, unknown> => ({
  name,
  task: `Do ${name}`,
  repos,
  model: 'sonnet'
})

/** Starts a session, leaves unsaved changes in api and spawns a worker there, so a card opens. */
async function waitingOnApi(
  rig: EngineRig,
  extraFiles = 0
): Promise<{ sessionId: string; workerId: string }> {
  const sessionId = await rig.startSession('autonomous')
  writeFileSync(join(rig.api.path, trackedFile), 'changed\n')
  for (let i = 0; i < extraFiles; i++) writeFileSync(join(rig.api.path, `extra-${i}.txt`), 'x\n')
  const result = await rig.call(rig.brain(), 'spawn_worker', spawnArgs('api-fix', ['api']))
  expect(result.value['status']).toBe('queued')
  return { sessionId, workerId: String(result.value['workerId']) }
}

describe('the unsaved-changes card in the attention snapshot and push', () => {
  it('shows the project, the changed files, the waiting workers and "Arc" as the sender', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    const { sessionId } = await waitingOnApi(rig)
    await until(() =>
      wired.pushes.some((p) => p.requests.some((r) => r.kind === 'branch' && r.workers.length > 0))
    )
    const push = wired.pushes.at(-1)
    const apiRow = rig.rig.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .find((p) => p.projectName === 'api')
    expect(push?.requests).toEqual([
      {
        id: rig.rig.deps.branchQuestionsRepo.listPending(sessionId)[0]?.id,
        route: 'queue',
        kind: 'branch',
        from: 'Arc',
        projectId: apiRow?.projectId,
        projectName: 'api',
        files: [trackedFile],
        moreFiles: 0,
        workers: ['W1 api-fix']
      }
    ])
    // The session snapshot a renderer gets on open carries the same card.
    const opened = await rig.rig.service.open(sessionId)
    expect('attention' in opened && opened.attention.map((r) => r.kind)).toEqual(['branch'])
  })

  it('lists at most 10 files and counts the rest', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    await waitingOnApi(rig, 11)
    await until(() => wired.pushes.some((p) => p.requests.some((r) => r.kind === 'branch')))
    const card = wired.pushes.at(-1)?.requests[0]
    expect(card?.kind === 'branch' && [card.files.length, card.moreFiles]).toEqual([10, 2])
  })

  it('shows the reason after a failed "Bring them along" and lists each waiting worker', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    const { sessionId } = await waitingOnApi(rig)
    const second = await rig.call(rig.brain(), 'spawn_worker', spawnArgs('api-docs', ['api']))
    expect(second.value['status']).toBe('queued')
    const question = rig.rig.deps.branchQuestionsRepo.listPending(sessionId)[0]
    rig.rig.deps.branchQuestionsRepo.reopenWithMessage(String(question?.id), 'It clashes')
    wired.attention.onBranchQuestionsChanged(sessionId)
    await until(() => {
      const last = wired.pushes.at(-1)?.requests[0]
      return last?.kind === 'branch' && last.message !== undefined
    })
    const card = wired.pushes.at(-1)?.requests[0]
    expect(card).toMatchObject({
      kind: 'branch',
      message: 'It clashes',
      workers: ['W1 api-fix', 'W2 api-docs']
    })
  })

  it('tells the user once through a notification that names the project', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    await waitingOnApi(rig)
    await until(() => wired.notices.length > 0)
    expect(wired.notices[0]).toMatchObject({
      from: 'Arc',
      text: 'Unsaved changes in api'
    })
  })
})

describe('counts include pending branch questions', () => {
  it('counts a pending question in the push, the group summary and the session list badge', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    const { sessionId } = await waitingOnApi(rig)
    await until(() => wired.pushes.some((p) => p.requests.some((r) => r.kind === 'branch')))
    expect(wired.pushes.at(-1)?.count).toBe(1)
    expect(wired.attention.summary()).toEqual({ byGroup: { [rig.rig.groupId]: 1 } })
    const row = rig.rig.service.list(rig.rig.groupId).find((s) => s.id === sessionId)
    expect(row).toMatchObject({ attentionCount: 1, listStatus: 'needs-attention' })
  })

  it('drops the count and the card once the question is answered', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    const { sessionId, workerId } = await waitingOnApi(rig)
    const question = rig.rig.deps.branchQuestionsRepo.listPending(sessionId)[0]
    const result = await wired.attention.answerBranchQuestion(String(question?.id), 'stash')
    expect(result).toEqual({ status: 'ok' })
    await until(() => wired.pushes.at(-1)?.requests.length === 0)
    expect(wired.pushes.at(-1)?.count).toBe(0)
    expect(wired.attention.summary()).toEqual({ byGroup: {} })
    await until(() => rig.rig.deps.workersRepo.get(workerId)?.status !== 'queued')
  })
})

describe('sessions:answer-branch-question', () => {
  const schema = channelSchemas['sessions:answer-branch-question']

  it('accepts the four choices and nothing else', () => {
    for (const choice of ['stash', 'commit', 'carry', 'skip']) {
      expect(schema.safeParse({ questionId: 'q1', choice }).success).toBe(true)
    }
    expect(schema.safeParse({ questionId: 'q1', choice: 'cancel' }).success).toBe(false)
    expect(schema.safeParse({ choice: 'stash' }).success).toBe(false)
    expect(schema.safeParse({ questionId: 'q1', choice: 'stash', extra: 1 }).success).toBe(false)
  })

  it('answers not-open for a question that does not exist', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    expect(await wired.attention.answerBranchQuestion('nope', 'stash')).toEqual({
      status: 'not-open'
    })
  })
})

describe('a relaunch', () => {
  it('keeps the pending question, the card and the queued worker as they were', async () => {
    const { rig, wired } = await rigWithAttention()
    e = rig
    const { sessionId, workerId } = await waitingOnApi(rig)
    const questionId = rig.rig.deps.branchQuestionsRepo.listPending(sessionId)[0]?.id
    await rig.rig.service.shutdown()

    // A new service on the same database, as after a restart.
    const again = new SessionService({ ...rig.rig.deps, onBranchQuestionsChanged: vi.fn() })
    try {
      expect(rig.rig.deps.branchQuestionsRepo.listPending(sessionId).map((q) => q.id)).toEqual([
        questionId
      ])
      expect(again.list(rig.rig.groupId).find((s) => s.id === sessionId)).toMatchObject({
        attentionCount: 1
      })
      expect(wired.attention.summary()).toEqual({ byGroup: { [rig.rig.groupId]: 1 } })
      const opened = await again.open(sessionId)
      expect('attention' in opened && opened.attention.map((r) => r.id)).toEqual([questionId])
      expect(rig.rig.deps.workersRepo.get(workerId)).toMatchObject({ status: 'queued' })
      expect(rig.rig.deps.branchQuestionsRepo.countPending(sessionId)).toBe(1)
    } finally {
      await again.shutdown()
    }
  })
})
