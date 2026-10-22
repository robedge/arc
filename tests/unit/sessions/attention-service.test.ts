import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import { AttentionService, attentionView } from '../../../src/main/sessions/attention-service'
import type { AttentionNotice } from '../../../src/main/sessions/attention-service'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-attention-service-')
let rig: Rig
let attention: AttentionService
let notices: AttentionNotice[]
let pushes: IpcEvents['session:attention'][]
let answered: [string, unknown][]
let seq = 0

function addSession(id: string, groupId: string): void {
  rig.sessionsRepo.create({
    id,
    groupId,
    name: id,
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
}

function addRequest(
  sessionId: string,
  extra: Partial<Parameters<Rig['deps']['attentionRepo']['create']>[0]> = {}
): AttentionRequestRow {
  seq += 1
  return rig.deps.attentionRepo.create({
    id: `r${seq}`,
    sessionId,
    source: 'brain',
    kind: 'permission',
    action: 'git push origin arc/fix-order-sync',
    escalated: true,
    createdAt: seq,
    ...extra
  })
}

beforeEach(async () => {
  seq = 0
  notices = []
  pushes = []
  answered = []
  rig = await makeRig(dir())
  attention = new AttentionService({
    sessions: { answerAttention: (id, answer) => void answered.push([id, answer]) },
    attentionRepo: rig.deps.attentionRepo,
    sessionsRepo: rig.sessionsRepo,
    workerOf: (id) => rig.deps.workersRepo.get(id),
    emit: (_event, payload) => void pushes.push(payload),
    onNewRequest: (n) => notices.push(n)
  })
})

afterEach(() => {
  rig.close()
  vi.useRealTimers()
})

describe('attention:answer validation', () => {
  const schema = channelSchemas['attention:answer']

  it('accepts approve or text, and rejects anything else', () => {
    expect(schema.safeParse({ requestId: 'r1', approve: true }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r1', approve: false }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r1', text: 'use 3' }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r1' }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r1', approve: true, text: 'x' }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r1', approve: true, extra: 1 }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r1', text: '' }).success).toBe(false)
    expect(schema.safeParse({ approve: true }).success).toBe(false)
  })

  it('passes the answer to the session service', () => {
    attention.answer('r1', { approve: false })
    attention.answer('r2', { text: 'three' })
    expect(answered).toEqual([
      ['r1', { approve: false }],
      ['r2', { text: 'three' }]
    ])
  })
})

describe('request shape', () => {
  it('shows a worker request as "W1 api-retry · via brain" with the brain note as reason', () => {
    const row = {
      id: 'x',
      source: 'worker',
      kind: 'permission',
      action: 'brew install jq',
      reason: 'policy',
      mustEscalate: false,
      brainNote: 'Not in the plan',
      question: null
    } as AttentionRequestRow
    expect(attentionView(row, { number: 1, slug: 'api-retry', dependsOnJson: '[]' })).toEqual({
      id: 'x',
      kind: 'permission',
      from: 'W1 api-retry · via brain',
      action: 'brew install jq',
      reason: 'Not in the plan'
    })
  })

  it('splits an MCP call into server, tool and arguments, keeping `_` in the server', () => {
    const row = {
      id: 'm',
      source: 'worker',
      kind: 'permission',
      action: 'x',
      mustEscalate: false,
      toolName: 'mcp__claude_ai_Figma__use_figma',
      toolInputJson: JSON.stringify({ fileKey: 'abc' })
    } as AttentionRequestRow
    expect(attentionView(row, undefined)).toMatchObject({
      tool: { kind: 'mcp', server: 'claude_ai_Figma', tool: 'use_figma', args: { fileKey: 'abc' } }
    })
  })

  it('carries the access a Codex permissions request asks for', () => {
    const row = {
      id: 'c',
      source: 'worker',
      kind: 'permission',
      action: 'Extra access',
      mustEscalate: true,
      toolName: 'CodexPermissions',
      toolInputJson: JSON.stringify({
        reason: 'Needs the cache',
        fileSystem: { read: ['/a'], write: ['/b'] },
        network: true
      })
    } as AttentionRequestRow
    expect(attentionView(row, undefined)).toMatchObject({
      tool: {
        kind: 'permissions',
        reason: 'Needs the cache',
        read: ['/a'],
        write: ['/b'],
        network: true
      }
    })
  })

  it('shows a request from a merge resolver as "Conflict resolver"', () => {
    const row = {
      id: 'r',
      source: 'worker',
      kind: 'question',
      mustEscalate: true,
      question: 'Keep both?'
    } as AttentionRequestRow
    const resolver = { number: 3, slug: 'merge-conflict', dependsOnJson: '["arc:merge-resolver"]' }
    expect(attentionView(row, resolver)).toMatchObject({ from: 'Conflict resolver' })
    expect(attentionView({ ...row, mustEscalate: false }, resolver)).toMatchObject({
      from: 'Conflict resolver · via brain'
    })
  })

  it('shows a policy-escalated worker request as "W1 api-retry" with the policy reason', () => {
    const row = {
      id: 'p',
      source: 'worker',
      kind: 'permission',
      action: 'git push --force',
      reason: 'Force push',
      mustEscalate: true,
      brainNote: null,
      question: null
    } as AttentionRequestRow
    expect(attentionView(row, { number: 1, slug: 'api-retry', dependsOnJson: '[]' })).toEqual({
      id: 'p',
      kind: 'permission',
      from: 'W1 api-retry',
      action: 'git push --force',
      reason: 'Force push'
    })
  })

  it('shows a brain question as "Brain"', () => {
    const row = {
      id: 'q',
      source: 'brain',
      kind: 'question',
      question: 'Which limit?',
      action: null
    } as AttentionRequestRow
    expect(attentionView(row, undefined)).toEqual({
      id: 'q',
      kind: 'question',
      from: 'Brain',
      question: 'Which limit?'
    })
  })
})

describe('counts and pushes', () => {
  it('counts escalated pending requests per session and group, and lists them needs-attention', () => {
    addSession('s1', rig.groupId)
    addSession('s2', rig.groupId)
    addRequest('s1')
    addRequest('s1', { kind: 'question', question: 'Which?', action: null })
    addRequest('s1', { escalated: false })
    addRequest('s2', { status: 'approved' })
    expect(attention.summary()).toEqual({ byGroup: { [rig.groupId]: 2 } })
    const list = rig.service.list(rig.groupId)
    const s1 = list.find((s) => s.id === 's1')
    const s2 = list.find((s) => s.id === 's2')
    expect(s1).toMatchObject({ attentionCount: 2, listStatus: 'needs-attention' })
    expect(s2).toMatchObject({ attentionCount: 0, listStatus: 'idle' })
  })

  it('puts the escalated pending requests in the session snapshot', () => {
    addSession('s1', rig.groupId)
    addRequest('s1', { brainNote: 'Leaves the machine' })
    addRequest('s1', { escalated: false })
    expect(rig.service.snapshot('s1').attention).toEqual([
      {
        id: 'r1',
        route: 'queue',
        kind: 'permission',
        from: 'Brain',
        action: 'git push origin arc/fix-order-sync',
        reason: 'Leaves the machine'
      }
    ])
  })

  it('pushes session:attention with the group and the requests, and reports each request to notify', () => {
    addSession('s1', rig.groupId)
    addRequest('s1')
    attention.onAttentionChanged('s1', rig.service.attentionState('s1'))
    const [push] = pushes
    expect(push).toMatchObject({ sessionId: 's1', groupId: rig.groupId, count: 1 })
    expect(push?.requests[0]).toMatchObject({ id: 'r1', kind: 'permission' })
    expect(notices).toEqual([
      {
        sessionId: 's1',
        groupId: rig.groupId,
        requestId: 'r1',
        from: 'Brain',
        text: 'git push origin arc/fix-order-sync'
      }
    ])
  })

  it('pushes a zero count when the last request is answered', () => {
    addSession('s1', rig.groupId)
    attention.onAttentionChanged('s1', { count: 0, requests: [] })
    expect(pushes[0]).toMatchObject({ count: 0, requests: [] })
  })
})
