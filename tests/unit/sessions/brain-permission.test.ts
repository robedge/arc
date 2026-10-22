import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { attentionView } from '../../../src/main/sessions/attention-service'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-brain-permission-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

async function startBrain(): Promise<{ rig: EngineRig; sessionId: string }> {
  e = await makeEngineRig(dir())
  const sessionId = await e.startSession('autonomous')
  return { rig: e, sessionId }
}

const bash = (rig: EngineRig, command: string): Promise<ToolCallOutcome> =>
  rig.call(rig.brain(), 'request_permission', {
    tool_name: 'Bash',
    input: { command },
    tool_use_id: 'toolu_b1'
  })

const pending = (rig: EngineRig, sessionId: string): AttentionRequestRow[] =>
  rig.rig.deps.attentionRepo.listPending(sessionId)

const allowed = (command: string): { behavior: 'allow'; updatedInput: unknown } => ({
  behavior: 'allow',
  updatedInput: { command }
})

describe('the brain launch', () => {
  it('gets the permission prompt tool, and is not shown it as a tool to call', async () => {
    const { rig } = await startBrain()
    const start = rig.rig.adapter.starts.find((s) => s.role === 'brain')
    expect(start?.claude.permissionPromptTool).toBe('mcp__arc__request_permission')
    expect(start?.bridgeTools).not.toContain('request_permission')
    expect(start?.bridgeTools).toContain('ask_user')
  })
})

describe('the brain reads freely', () => {
  it('allows git diff at once, with no row, no event and no waiting state', async () => {
    const { rig, sessionId } = await startBrain()
    const outcome = await bash(rig, 'git -C /Users/me/api diff CLAUDE.md package-lock.json')
    expect(outcome.value).toEqual(allowed('git -C /Users/me/api diff CLAUDE.md package-lock.json'))
    expect(pending(rig, sessionId)).toEqual([])
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
    expect(rig.rig.service.snapshot(sessionId).brainState).not.toBe('waiting')
  })

  it('denies any tool other than Bash without a row', async () => {
    const { rig, sessionId } = await startBrain()
    const outcome = await rig.call(rig.brain(), 'request_permission', {
      tool_name: 'Write',
      input: { file_path: '/tmp/x', content: 'y' }
    })
    expect(outcome.value['behavior']).toBe('deny')
    expect(String(outcome.value['message'])).toContain('cannot use Write')
    expect(pending(rig, sessionId)).toEqual([])
  })
})

describe('the brain asks before changing a checkout', () => {
  it('escalates git commit to the user, blocks the brain as waiting, and continues on approval', async () => {
    const { rig, sessionId } = await startBrain()
    const call = bash(rig, 'git commit -am x')
    await until(() => pending(rig, sessionId).length === 1)
    const row = pending(rig, sessionId)[0] as AttentionRequestRow
    expect(row).toMatchObject({
      source: 'brain',
      kind: 'permission',
      workerId: null,
      toolName: 'Bash',
      action: 'git commit -am x',
      category: 'changes_checkout',
      mustEscalate: true,
      escalated: true,
      status: 'pending'
    })
    expect(rig.rig.service.attentionState(sessionId).count).toBe(1)
    expect(rig.rig.service.snapshot(sessionId).brainState).toBe('waiting')
    // The brain cannot resolve its own request.
    const own = await rig.call(rig.brain(), 'resolve_request', {
      requestId: row.id,
      decision: 'approve'
    })
    expect(own.value['error']).toBe('not_resolvable')
    const view = attentionView(row, undefined)
    expect(view).toMatchObject({ kind: 'permission', from: 'Brain', action: 'git commit -am x' })

    rig.rig.service.answerAttention(row.id, { approve: true })
    expect((await call).value).toEqual(allowed('git commit -am x'))
    expect(rig.rig.service.snapshot(sessionId).brainState).toBe('thinking')
    expect(rig.rig.service.attentionState(sessionId).count).toBe(0)
  })

  it('tells the brain when the user denies', async () => {
    const { rig, sessionId } = await startBrain()
    const call = bash(rig, 'git checkout main')
    await until(() => pending(rig, sessionId).length === 1)
    rig.rig.service.answerAttention((pending(rig, sessionId)[0] as AttentionRequestRow).id, {
      approve: false
    })
    expect((await call).value).toEqual({
      behavior: 'deny',
      message: 'The user denied this request.'
    })
  })

  it.each([
    ['git add .', 'changes_checkout'],
    ['git stash', 'changes_checkout'],
    ['npm install', 'changes_checkout'],
    ['rm -rf dist', 'destructive'],
    ['git push origin main', 'leaves_machine']
  ])('%s is escalated as %s', async (command, category) => {
    const { rig, sessionId } = await startBrain()
    void bash(rig, command)
    await until(() => pending(rig, sessionId).length === 1)
    expect(pending(rig, sessionId)[0]).toMatchObject({ source: 'brain', category, escalated: true })
  })
})

describe('Auto-approve and Always allow', () => {
  it('Auto-approve covers changes_checkout without a row, but a push still asks', async () => {
    const { rig, sessionId } = await startBrain()
    rig.rig.service.setConfig(sessionId, { autoApprove: true })
    expect((await bash(rig, 'git commit -am x')).value).toEqual(allowed('git commit -am x'))
    expect(pending(rig, sessionId)).toEqual([])
    expect(rig.rig.eventsRepo.latest(sessionId, 50).map((x) => x.text)).toContain(
      'Auto-approved: git commit -am x'
    )

    void bash(rig, 'git push origin main')
    await until(() => pending(rig, sessionId).length === 1)
    expect(pending(rig, sessionId)[0]).toMatchObject({ category: 'leaves_machine' })
  })

  it('turning Auto-approve on releases a brain request that is already waiting', async () => {
    const { rig, sessionId } = await startBrain()
    const call = bash(rig, 'git merge dev')
    await until(() => pending(rig, sessionId).length === 1)
    rig.rig.service.setConfig(sessionId, { autoApprove: true })
    expect((await call).value).toEqual(allowed('git merge dev'))
    expect(pending(rig, sessionId)).toEqual([])
  })

  it('an Always allow rule from a brain request covers the same kind of command later', async () => {
    const { rig, sessionId } = await startBrain()
    const first = bash(rig, 'git commit -am one')
    await until(() => pending(rig, sessionId).length === 1)
    rig.rig.service.answerAttention((pending(rig, sessionId)[0] as AttentionRequestRow).id, {
      approve: true,
      always: true
    })
    await first
    expect(rig.rig.deps.allowRulesRepo.listBySession(sessionId)).toMatchObject([
      { category: 'changes_checkout', tool: 'Bash', prefix: 'git commit', text: 'git commit' }
    ])
    expect((await bash(rig, 'git commit -m two')).value).toEqual(allowed('git commit -m two'))
    expect(pending(rig, sessionId)).toEqual([])

    void bash(rig, 'git checkout main')
    await until(() => pending(rig, sessionId).length === 1)
  })
})
