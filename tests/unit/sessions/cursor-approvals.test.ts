import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_APPROVAL_WITHDRAWN,
  type CursorApprovalHandler,
  type CursorApprovalRequest
} from '../../../src/main/agents/cursor/cursor-types'
import type { SessionAllowRuleRow } from '../../../src/main/db/repositories/allow-rules-repo'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import {
  AttentionCoordinator,
  type AttentionHost
} from '../../../src/main/sessions/attention-coordinator'
import { createCursorApprovalHandler } from '../../../src/main/sessions/cursor-approvals'
import type { BridgeAgent } from '../../../src/main/bridge/types'
import { approvalRequests } from '../agents/cursor/fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-cursor-approvals-')
const worker: BridgeAgent = { sessionId: '', agentId: 'worker-w1', role: 'worker' }

let rig: Rig
let repo: AttentionRepo
let sessionId: string
let wt: string
let coordinator: AttentionCoordinator
let host: AttentionHost
let workerHandler: CursorApprovalHandler
const notes: string[] = []
const rules = vi.fn()
const stored: SessionAllowRuleRow[] = []
const events: string[] = []

function makeCoordinator(): AttentionCoordinator {
  let n = 0
  host = {
    sessionId,
    now: () => Date.now(),
    newId: () => `R${(n += 1)}`,
    logEvent: (_kind, text) => events.push(text),
    notifyBrain: (text) => notes.push(text),
    workerOf: () => ({ id: 'w1', number: 1, slug: 'api-retry' }),
    workerLabel: () => 'W1 api-retry',
    policyContext: (workerId) =>
      workerId === null
        ? { worktreeRoots: [], readOnlyDirs: [], cwd: wt }
        : { worktreeRoots: [wt], readOnlyDirs: [], cwd: wt },
    setWorkerStatus: () => undefined,
    isControlled: () => false,
    onBrainWaiting: () => undefined,
    onChanged: () => undefined,
    autoApprove: () => false,
    allowRules: () => stored,
    addAllowRule: (rule) => {
      rules(rule)
      const row = { id: `A${stored.length + 1}`, sessionId, createdAt: 1, ...rule }
      stored.push(row)
      return row
    }
  }
  return new AttentionCoordinator(repo, host)
}

function handlerFor(c: AttentionCoordinator): CursorApprovalHandler {
  return createCursorApprovalHandler({
    agent: worker,
    requestAction: (agent, action, meta, call) => c.requestAction(agent, action, meta, call.signal)
  })
}

beforeEach(async () => {
  rig = await makeRig(dir())
  const created = await rig.service.create(rig.groupId, 'Do the thing', 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  sessionId = created.sessionId
  worker.sessionId = sessionId
  wt = join(dir(), 'wt')
  mkdirSync(wt, { recursive: true })
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
  notes.length = 0
  events.length = 0
  rules.mockClear()
  stored.length = 0
  coordinator = makeCoordinator()
  workerHandler = handlerFor(coordinator)
})

afterEach(async () => {
  coordinator.releaseAll()
  await rig.service.shutdown()
  rig.close()
})

const fixture = approvalRequests('m1-agent-turn.jsonl')
const never = new AbortController().signal

/** A fixture request with its command replaced, as if Cursor had asked for that command. */
function command(script: string): CursorApprovalRequest {
  const base = fixture[0] as CursorApprovalRequest
  return {
    ...base,
    title: `\`${script}\``,
    tool: {
      ...(base.tool as NonNullable<CursorApprovalRequest['tool']>),
      rawInput: { command: script }
    }
  }
}

async function pendingRow(): Promise<NonNullable<ReturnType<AttentionRepo['get']>>> {
  await vi.waitFor(() => expect(repo.listPending(sessionId).length).toBeGreaterThan(0))
  return repo.listPending(sessionId)[0] as NonNullable<ReturnType<AttentionRepo['get']>>
}

describe('a Cursor approval', () => {
  it('answers ordinary commands (the M1 git status and ls) with no attention item', async () => {
    expect(await workerHandler.handle(fixture[0] as CursorApprovalRequest, never)).toEqual({
      decision: 'allow'
    })
    expect(await workerHandler.handle(fixture[1] as CursorApprovalRequest, never)).toEqual({
      decision: 'allow'
    })
    expect(repo.listPending(sessionId)).toEqual([])
    expect(notes).toEqual([])
  })

  it('answers calls to the arc server (the M1 echo) with no attention item', async () => {
    const echo = fixture.find((r) => r.toolCallId === 'toolcall-8') as CursorApprovalRequest
    expect(await workerHandler.handle(echo, never)).toEqual({ decision: 'allow' })
    expect(repo.listPending(sessionId)).toEqual([])
  })

  it('holds a push in Needs attention and allows it only after the user approves', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    expect(row).toMatchObject({
      toolName: 'Bash',
      action: 'git push origin HEAD',
      category: 'leaves_machine',
      mustEscalate: true,
      status: 'pending'
    })
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    coordinator.answer(row.id, { approve: true })
    await expect(pending).resolves.toEqual({ decision: 'allow' })
  })

  it('rejects a denied push, with the reason as the message', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: false })
    const decision = await pending
    expect(decision.decision).toBe('reject')
    expect(decision.message).toContain('git push origin HEAD')
    expect(decision.message).toContain('declined')
    expect(decision.message).toContain('The user denied this request.')
  })

  it('never turns "always allow" into anything but a single allow', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: true, always: true })
    // the handler's vocabulary has no "always": allow is answered with the allow_once option
    expect(await pending).toEqual({ decision: 'allow' })
  })

  it('asks about an mcp tool it cannot identify, and rejects it when the user declines', async () => {
    const unknown = {
      ...(fixture[2] as CursorApprovalRequest),
      toolCallId: 'u',
      title: 'MCP: tool',
      tool: undefined
    }
    const pending = workerHandler.handle(unknown, never)
    const row = await pendingRow()
    expect(row.category).toBe('mcp_write')
    coordinator.answer(row.id, { approve: false })
    expect((await pending).decision).toBe('reject')
  })

  it('cancels the stored request when Cursor withdraws it (an interrupt)', async () => {
    const controller = new AbortController()
    const pending = workerHandler.handle(command('git push origin HEAD'), controller.signal)
    const row = await pendingRow()
    controller.abort(CURSOR_APPROVAL_WITHDRAWN)
    await pending
    expect(repo.get(row.id)).toMatchObject({ status: 'cancelled', delivered: true })
    expect(coordinator.state().count).toBe(0)
  })

  it('cancels the turn when the coordinator refuses with cancelTurn, and rejects when it fails', async () => {
    const cancelling = createCursorApprovalHandler({
      agent: worker,
      requestAction: () => Promise.resolve({ allow: false, cancelTurn: true })
    })
    expect(await cancelling.handle(command('git push'), never)).toEqual({ decision: 'cancel' })
    const failing = createCursorApprovalHandler({
      agent: worker,
      requestAction: () => Promise.reject(new Error('boom'))
    })
    expect(await failing.handle(command('git push'), never)).toEqual({ decision: 'reject' })
  })
})
