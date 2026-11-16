import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeArgs } from '../../../src/main/agents/claude/claude-adapter'
import { HAND_BACK_TEXT } from '../../../src/main/sessions/worker-manager'
import type { ClaudeStartRequest } from '../../../src/main/agents/agent-adapter'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-skip-relaunch-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const NUDGE = '[Arc] You have not called report_done.'
const turnOver = (handle: FakeHandle): void =>
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })

/** The `--disallowedTools` rules of one worker launch, built the way the adapter builds them. */
function denyRules(start: ClaudeStartRequest | undefined): string[] {
  if (!start) throw new Error('no launch')
  const args = buildClaudeArgs(start)
  const at = args.indexOf('--disallowedTools')
  return at === -1 ? [] : args.slice(at + 1)
}

async function liveWorker(): Promise<{
  rig: EngineRig
  sessionId: string
  workerId: string
  first: FakeHandle
}> {
  const rig = await makeEngineRig(dir())
  e = rig
  const sessionId = await rig.startSession('autonomous')
  const started = await rig.call(rig.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retries',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const first = rig.workerHandle()
  first.emit({ type: 'session', providerSessionId: 'w1', model: 'sonnet', mcpServers: [] })
  await until(() => rig.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { rig, sessionId, workerId, first }
}

const workerStarts = (rig: EngineRig): ClaudeStartRequest[] =>
  rig.rig.adapter.starts.filter((s) => s.role === 'worker')

describe('Skip all approvals on a live Claude worker (spec 015)', () => {
  it('launches with every deny, then relaunches with --resume after its turn once skip is on, keeping only the attachments deny', async () => {
    const { rig, sessionId, workerId, first } = await liveWorker()
    const initial = workerStarts(rig)[0]
    const initialDeny = denyRules(initial)
    expect(initial?.claude.skipApprovals).toBeUndefined()
    const knowledge = initial?.readOnlyDirs?.[0] ?? ''
    expect(initialDeny).toContain(`Edit(/${knowledge}/**)`)

    // The turn is running: the toggle marks the worker and nothing is replaced.
    first.idle = false
    rig.rig.service.setConfig(sessionId, { skipApprovals: true })
    expect(first.stopped).toBe(false)
    expect(rig.rig.adapter.resumes).toHaveLength(0)

    // The turn ends: the nudge is the first message of a process that resumes the conversation.
    first.idle = true
    turnOver(first)
    await until(() => rig.rig.adapter.resumes.length === 1)
    expect(first.stopped).toBe(true)
    const resumed = rig.rig.adapter.resumes[0]
    expect(resumed?.resume?.threadId).toBe('w1')
    expect(resumed?.claude.skipApprovals).toBe(true)
    const deny = denyRules(resumed)
    expect(deny.some((d) => d.includes(knowledge))).toBe(false)
    expect(deny.length).toBeGreaterThan(0)
    expect(deny.every((d) => d.includes('/attachments/'))).toBe(true)
    const second = rig.workerHandle(1)
    await until(() => second.sent.length === 1)
    expect(second.sent[0]).toContain(NUDGE)
    expect(first.sent.filter((t) => t.includes(NUDGE))).toEqual([])
    // The old process's exit was not the worker ending.
    expect(rig.rig.deps.workersRepo.get(workerId)?.status).not.toBe('failed')
  })

  it('does the same in the other direction, bringing the denies back at the next boundary', async () => {
    const { rig, sessionId, first } = await liveWorker()
    rig.rig.service.setConfig(sessionId, { skipApprovals: true })
    turnOver(first)
    await until(() => rig.rig.adapter.resumes.length === 1)
    const second = rig.workerHandle(1)
    second.emit({ type: 'session', providerSessionId: 'w1', model: 'sonnet', mcpServers: [] })
    await until(() => second.sent.length === 1)

    rig.rig.service.setConfig(sessionId, { skipApprovals: false })
    // Idle between turns: the brain's next message is the boundary.
    const sent = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'go on' })
    expect(sent.value).toMatchObject({ delivered: true })
    await until(() => rig.rig.adapter.resumes.length === 2)
    expect(second.stopped).toBe(true)
    const restored = rig.rig.adapter.resumes[1]
    expect(restored?.resume?.threadId).toBe('w1')
    expect(restored?.claude.skipApprovals).toBeUndefined()
    expect(denyRules(restored)).toEqual(denyRules(workerStarts(rig)[0]))
    const third = rig.workerHandle(2)
    await until(() => third.sent.length === 1)
    expect(third.sent[0]).toContain('go on')
  })

  it('does not replace the process when the flag is back where it started before the turn ends', async () => {
    const { rig, sessionId, first } = await liveWorker()
    rig.rig.service.setConfig(sessionId, { skipApprovals: true })
    rig.rig.service.setConfig(sessionId, { skipApprovals: false })
    turnOver(first)
    await until(() => first.sent.some((t) => t.includes(NUDGE)))
    expect(first.stopped).toBe(false)
    expect(rig.rig.adapter.resumes).toHaveLength(0)
  })

  it('does not replace it mid-turn when a message arrives, and sends it to the new process at the boundary', async () => {
    const { rig, sessionId, workerId, first } = await liveWorker()
    rig.rig.service.setConfig(sessionId, { skipApprovals: true })
    first.idle = false
    const queued = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'use v2' })
    expect(queued.value).toMatchObject({ delivered: true })
    expect(first.stopped).toBe(false)
    expect(first.sent.at(-1)).toContain('use v2')
    expect(rig.rig.adapter.resumes).toHaveLength(0)

    first.idle = true
    const next = await rig.call(rig.brain(), 'message_worker', { workerId: 'W1', text: 'and v3' })
    expect(next.value).toMatchObject({ delivered: true })
    await until(() => rig.rig.adapter.resumes.length === 1)
    expect(first.stopped).toBe(true)
    const second = rig.workerHandle(1)
    await until(() => second.sent.length === 1)
    expect(second.sent[0]).toContain('and v3')
    expect(rig.rig.deps.workersRepo.get(workerId)?.status).not.toBe('failed')
  })

  it('waits while the user is in control and replaces the process at hand-back', async () => {
    const { rig, sessionId, workerId, first } = await liveWorker()
    await rig.rig.service.stepInWorker(workerId)
    rig.rig.service.setConfig(sessionId, { skipApprovals: true })
    turnOver(first)
    await new Promise((r) => setTimeout(r, 150))
    expect(first.stopped).toBe(false)
    expect(rig.rig.adapter.resumes).toHaveLength(0)

    await rig.rig.service.handBackWorker(workerId)
    await until(() => rig.rig.adapter.resumes.length === 1)
    expect(first.stopped).toBe(true)
    expect(rig.rig.adapter.resumes[0]?.claude.skipApprovals).toBe(true)
    const second = rig.workerHandle(1)
    await until(() => second.sent.length === 1)
    expect(second.sent[0]).toContain(HAND_BACK_TEXT)
    expect(rig.rig.deps.workersRepo.get(workerId)?.userControl).toBeNull()
  })
})
