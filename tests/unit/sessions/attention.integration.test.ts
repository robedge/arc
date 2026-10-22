import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { fakeAdapter, records } from './fake-cli'

const dir = useTempDir('arc-attention-int-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function start(
  scenario: string,
  request = 'Fix order sync'
): Promise<{ sessionId: string; logPath: string; rig: EngineRig }> {
  const logPath = join(dir(), 'fake.log')
  e = await makeEngineRig(dir(), { adapter: fakeAdapter(scenario, logPath) })
  const created = await e.rig.service.create(e.rig.groupId, request, 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  return { sessionId: created.sessionId, logPath, rig: e }
}

async function waitForPending(
  rig: EngineRig,
  sessionId: string,
  ms = 20000
): Promise<AttentionRequestRow> {
  await until(() => rig.rig.deps.attentionRepo.listPending(sessionId).length > 0, ms)
  return rig.rig.deps.attentionRepo.listPending(sessionId)[0] as AttentionRequestRow
}

const workerStatus = (rig: EngineRig, sessionId: string): string | undefined =>
  rig.rig.deps.workersRepo.listBySession(sessionId)[0]?.status

const eventTexts = (rig: EngineRig, sessionId: string): string[] =>
  rig.rig.eventsRepo.latest(sessionId, 100).map((x) => x.text)

describe('git push through the real bridge and the fake CLI', () => {
  it('is escalated, shows Needs approval, and the worker continues after the user approves', async () => {
    const { sessionId, logPath, rig } = await start('attention-push')
    const row = await waitForPending(rig, sessionId)
    expect(row).toMatchObject({
      kind: 'permission',
      toolName: 'Bash',
      action: 'git push origin arc/fix-order-sync',
      category: 'leaves_machine',
      mustEscalate: true,
      escalated: true
    })
    await until(() => workerStatus(rig, sessionId) === 'needs_approval')
    expect(rig.rig.service.attentionState(sessionId).count).toBe(1)

    // The brain was told and said it cannot approve.
    await until(() =>
      rig.rig.messagesRepo
        .latest(sessionId, 50)
        .some((m) => m.content.includes('The push needs your approval.'))
    )

    rig.rig.service.answerAttention(row.id, { approve: true })
    await until(() => workerStatus(rig, sessionId) === 'done', 20000)
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
    expect(eventTexts(rig, sessionId)).toContain('Approved by you')

    const permission = records(logPath).find((r) => r.permission)?.permission
    expect(permission).toMatchObject({
      tool_name: 'Bash',
      input: { command: 'git push origin arc/fix-order-sync' },
      behavior: 'allow'
    })
  })

  it('is denied: the worker is told, keeps going, and the log says Denied by you', async () => {
    const { sessionId, logPath, rig } = await start('attention-push')
    const row = await waitForPending(rig, sessionId)
    rig.rig.service.answerAttention(row.id, { approve: false })
    await until(() => workerStatus(rig, sessionId) === 'done', 20000)

    expect(eventTexts(rig, sessionId)).toContain('Denied by you')
    expect(rig.rig.deps.attentionRepo.get(row.id)).toMatchObject({
      status: 'denied',
      delivered: true
    })
    const permission = records(logPath).find((r) => r.permission)?.permission
    expect(permission).toMatchObject({
      behavior: 'deny',
      message: 'The user denied this request.'
    })
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
  })
})

describe('brew install through the real bridge and the fake CLI', () => {
  it('reaches the user even though the plan mentions the tool', async () => {
    const { sessionId, rig } = await start('attention-brew', 'Add jq tooling')
    const row = await waitForPending(rig, sessionId)
    expect(row).toMatchObject({
      action: 'brew install jq',
      category: 'global_install',
      mustEscalate: true,
      escalated: true
    })
    expect(rig.rig.deps.workersRepo.listBySession(sessionId)[0]?.task).toContain('brew install jq')
    expect(rig.rig.service.attentionState(sessionId).count).toBe(1)
    rig.rig.service.answerAttention(row.id, { approve: false })
    await until(() => workerStatus(rig, sessionId) === 'done', 20000)
  })
})

describe('questions through the real bridge and the fake CLI', () => {
  it('a question the brain answers from its notes: the worker continues and no badge appears', async () => {
    const { sessionId, logPath, rig } = await start('attention-question', 'Retry count question')
    await until(() => workerStatus(rig, sessionId) === 'done', 30000)
    const rows = rig.rig.deps.attentionRepo.listUndelivered(sessionId)
    expect(rows).toEqual([])
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
    expect(eventTexts(rig, sessionId)).toContain('W1 question answered by brain')
    const asked = records(logPath).find((r) => r.mcpResult?.tool === 'ask_brain')
    expect(asked?.mcpResult?.text).toContain('Three attempts, with exponential backoff.')
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
  })

  it('a brain question for the user is answered and the brain continues', async () => {
    const { sessionId, logPath, rig } = await start('attention-ask-user', 'Ask the user')
    const row = await waitForPending(rig, sessionId)
    expect(row).toMatchObject({
      source: 'brain',
      question: 'Should the retry count be configurable?'
    })
    expect(rig.rig.service.snapshot(sessionId).brainState).toBe('waiting')
    rig.rig.service.answerAttention(row.id, { text: 'Yes, make it configurable.' })
    await until(() =>
      rig.rig.messagesRepo.latest(sessionId, 50).some((m) => m.content.includes('Thanks, noted.'))
    )
    const asked = records(logPath).find((r) => r.mcpResult?.tool === 'ask_user')
    expect(asked?.mcpResult?.text).toContain('Yes, make it configurable.')
    expect(eventTexts(rig, sessionId)).toContain('Answered by you: Yes, make it configurable.')
  })
})

describe('the brain runs shell commands through the real bridge and the fake CLI', () => {
  it('git diff is allowed with no row and no approval', async () => {
    const { sessionId, logPath, rig } = await start('brain-shell-diff', 'What changed?')
    await until(() =>
      rig.rig.messagesRepo
        .latest(sessionId, 50)
        .some((m) => m.content.includes('Here is what changed.'))
    )
    const permission = records(logPath).find((r) => r.permission)?.permission
    expect(permission).toMatchObject({
      tool_name: 'Bash',
      input: { command: 'git -C /work/api diff CLAUDE.md package-lock.json' },
      behavior: 'allow'
    })
    expect(rig.rig.deps.attentionRepo.listPending(sessionId)).toEqual([])
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
  })

  it('git commit -am x reaches Needs attention, and the brain continues once the user approves', async () => {
    const { sessionId, logPath, rig } = await start('brain-shell-commit', 'Commit it')
    const row = await waitForPending(rig, sessionId)
    expect(row).toMatchObject({
      source: 'brain',
      kind: 'permission',
      action: 'git commit -am x',
      category: 'changes_checkout',
      escalated: true
    })
    expect(rig.rig.service.attentionState(sessionId).count).toBe(1)
    expect(rig.rig.service.snapshot(sessionId).brainState).toBe('waiting')
    expect(records(logPath).some((r) => r.permission)).toBe(false)

    rig.rig.service.answerAttention(row.id, { approve: true })
    await until(() =>
      rig.rig.messagesRepo
        .latest(sessionId, 50)
        .some((m) => m.content.includes('Committed after your approval.'))
    )
    expect(records(logPath).find((r) => r.permission)?.permission).toMatchObject({
      input: { command: 'git commit -am x' },
      behavior: 'allow'
    })
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
  })
})
