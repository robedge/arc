import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BridgeAgent } from '../../../src/main/bridge/types'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import {
  ASK_BRAIN_MEMO_MS,
  AttentionCoordinator,
  type AttentionHost
} from '../../../src/main/sessions/attention-coordinator'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-ask-brain-')
const agent: BridgeAgent = { sessionId: '', agentId: 'worker-w1', role: 'worker' }

let rig: Rig
let repo: AttentionRepo
let sessionId: string
let coordinator: AttentionCoordinator
let clock: number
const brainNotes: string[] = []

beforeEach(async () => {
  rig = await makeRig(dir())
  const created = await rig.service.create(rig.groupId, 'Do the thing', 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  sessionId = created.sessionId
  agent.sessionId = sessionId
  rig.deps.workersRepo.insert({
    id: 'w1',
    sessionId,
    number: 1,
    slug: 'api-retry',
    task: 't',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    providerSessionId: null,
    planId: null,
    dependsOnJson: '[]',
    stoppedBy: null,
    createdAt: 1,
    updatedAt: 1
  })
  repo = new AttentionRepo(rig.opened.db)
  brainNotes.length = 0
  clock = 1_000_000
  let n = 0
  const host: AttentionHost = {
    sessionId,
    now: () => clock,
    newId: () => `R${(n += 1)}`,
    logEvent: () => undefined,
    notifyBrain: (text) => brainNotes.push(text),
    workerOf: () => ({ id: 'w1', number: 1, slug: 'api-retry' }),
    workerLabel: () => 'W1 api-retry',
    policyContext: () => ({ worktreeRoots: [], readOnlyDirs: [], cwd: dir() }),
    setWorkerStatus: () => undefined,
    isControlled: () => false,
    onBrainWaiting: () => undefined,
    onChanged: () => undefined,
    autoApprove: () => false,
    allowRules: () => [],
    addAllowRule: () => {
      throw new Error('no rule expected')
    }
  }
  coordinator = new AttentionCoordinator(repo, host)
})

afterEach(async () => {
  coordinator.releaseAll()
  await rig.service.shutdown()
  rig.close()
})

const never = new AbortController().signal
const ask = (question: string, signal: AbortSignal = never): Promise<{ answer: string }> =>
  coordinator.askBrain(agent, { question }, signal)
const totalRows = (): number =>
  (rig.opened.sqlite.prepare('select count(*) as n from attention_requests').get() as { n: number })
    .n
const rows = (): ReturnType<AttentionRepo['listPending']> => repo.listPending(sessionId)

describe('ask_brain is idempotent per worker and question', () => {
  it('joins a call that is still pending: one request, one answer for both calls', async () => {
    const first = ask('Use Redis?')
    const second = ask('Use Redis?')
    expect(rows()).toHaveLength(1)
    expect(brainNotes).toHaveLength(1)

    coordinator.answer(rows()[0]?.id ?? '', { text: 'Redis.' })

    await expect(first).resolves.toEqual({ answer: 'Redis.' })
    await expect(second).resolves.toEqual({ answer: 'Redis.' })
    expect(totalRows()).toBe(1)
  })

  it('joins after the first call died (a timed-out Codex call made again): the request stays one', async () => {
    const dead = new AbortController()
    const first = ask('Use Redis?', dead.signal)
    const row = rows()[0]
    dead.abort()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    expect(repo.get(row?.id ?? '')?.status).toBe('pending')

    const again = ask('Use Redis?')
    expect(rows()).toHaveLength(1)
    coordinator.answer(row?.id ?? '', { text: 'Redis.' })
    await expect(again).resolves.toEqual({ answer: 'Redis.' })
    expect(repo.get(row?.id ?? '')).toMatchObject({ status: 'answered', delivered: true })
  })

  it('keeps the joined call waiting when the first one dies', async () => {
    const dead = new AbortController()
    const first = ask('Use Redis?', dead.signal)
    const second = ask('Use Redis?')
    dead.abort()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    const id = rows()[0]?.id ?? ''
    expect(repo.get(id)?.status).toBe('pending')

    coordinator.answer(id, { text: 'Redis.' })
    await expect(second).resolves.toEqual({ answer: 'Redis.' })
  })

  it('returns the same answer to a call made after the answer, without a new request', async () => {
    const first = ask('Use Redis?')
    const id = rows()[0]?.id ?? ''
    coordinator.answer(id, { text: 'Redis.' })
    await first

    clock += 60_000
    await expect(ask('Use Redis?')).resolves.toEqual({ answer: 'Redis.' })
    expect(rows()).toHaveLength(0)
    expect(totalRows()).toBe(1)
    expect(brainNotes).toHaveLength(1)
  })

  it('returns an answer that arrived while no call was waiting, and marks it delivered', async () => {
    const dead = new AbortController()
    const first = ask('Use Redis?', dead.signal)
    const id = rows()[0]?.id ?? ''
    dead.abort()
    await first.catch(() => undefined)
    coordinator.answer(id, { text: 'Redis.' })
    expect(repo.get(id)).toMatchObject({ status: 'answered', delivered: false })

    await expect(ask('Use Redis?')).resolves.toEqual({ answer: 'Redis.' })
    expect(repo.get(id)?.delivered).toBe(true)
  })

  it('a different question is a new request', async () => {
    const calls = [ask('Use Redis?'), ask('Which port?')]
    expect(rows()).toHaveLength(2)
    coordinator.releaseAll()
    await Promise.allSettled(calls)
  })

  it('forgets a question after ten minutes', async () => {
    const first = ask('Use Redis?')
    coordinator.answer(rows()[0]?.id ?? '', { text: 'Redis.' })
    await first

    clock += ASK_BRAIN_MEMO_MS + 1
    const again = ask('Use Redis?')
    expect(rows()).toHaveLength(1)
    coordinator.answer(rows()[0]?.id ?? '', { text: 'Postgres.' })
    await expect(again).resolves.toEqual({ answer: 'Postgres.' })
  })
})
