import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

const dir = useTempDir('arc-attention-allow-')
let e: EngineRig | undefined

afterEach(async () => {
  vi.useRealTimers()
  await e?.close()
  e = undefined
})

interface Started {
  rig: EngineRig
  sessionId: string
  workerId: string
  worker: FakeHandle
}

async function startWorker(): Promise<Started> {
  e = await makeEngineRig(dir())
  const sessionId = await e.startSession('autonomous')
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'api-retry',
    task: 'Add retry',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const worker = e.workerHandle()
  worker.emit({
    type: 'session',
    providerSessionId: 'w-claude-1',
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { rig: e, sessionId, workerId, worker }
}

const permission = (s: Started, command: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: 'Bash',
    input: { command, description: 'x' },
    tool_use_id: 'toolu_1'
  })

const pending = (s: Started): AttentionRequestRow[] =>
  s.rig.rig.deps.attentionRepo.listPending(s.sessionId)

async function pendingCount(s: Started, count: number): Promise<AttentionRequestRow[]> {
  await until(() => pending(s).length >= count)
  return pending(s)
}

const eventTexts = (s: Started): string[] =>
  s.rig.rig.eventsRepo.latest(s.sessionId, 100).map((x) => x.text)

const rules = (s: Started): ReturnType<typeof s.rig.rig.deps.allowRulesRepo.listBySession> =>
  s.rig.rig.deps.allowRulesRepo.listBySession(s.sessionId)

const allowed = (command: string): { behavior: 'allow'; updatedInput: unknown } => ({
  behavior: 'allow',
  updatedInput: { command, description: 'x' }
})

describe('attention:answer validation', () => {
  const schema = channelSchemas['attention:answer']

  it('accepts always only together with an approval', () => {
    expect(schema.safeParse({ requestId: 'r', approve: true, always: true }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r', approve: true, always: false }).success).toBe(true)
    expect(schema.safeParse({ requestId: 'r', approve: false, always: true }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r', text: 'x', always: true }).success).toBe(false)
  })

  it('has sessions:remove-allow-rule and an autoApprove field on sessions:set-config', () => {
    expect(
      channelSchemas['sessions:remove-allow-rule'].safeParse({ sessionId: 's', ruleId: 'r' })
        .success
    ).toBe(true)
    expect(channelSchemas['sessions:remove-allow-rule'].safeParse({ sessionId: 's' }).success).toBe(
      false
    )
    expect(
      channelSchemas['sessions:set-config'].safeParse({ sessionId: 's', autoApprove: true }).success
    ).toBe(true)
    expect(
      channelSchemas['sessions:set-config'].safeParse({ sessionId: 's', autoApprove: 'yes' })
        .success
    ).toBe(false)
  })
})

describe('Always allow this in this session', () => {
  it('stores a rule from the approved request and lists it in the header', async () => {
    const s = await startWorker()
    const call = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingCount(s, 1)
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true, always: true })
    expect((await call).value).toEqual(allowed('git push origin arc/retry-work'))

    expect(rules(s)).toMatchObject([
      {
        category: 'leaves_machine',
        tool: 'Bash',
        prefix: 'git push',
        folder: null,
        text: 'git push'
      }
    ])
    expect(eventTexts(s)).toContain('Approved by you')
    expect(eventTexts(s)).toContain('Always allowed in this session: git push')
    const header = s.rig.rig.service.snapshot(s.sessionId).header
    expect(header.allowRules).toMatchObject([{ text: 'git push', category: 'leaves_machine' }])
    expect(header.autoApprove).toBe(false)
  })

  it('approves a later matching request at once: no row, an event, no brain turn', async () => {
    const s = await startWorker()
    const first = permission(s, 'git push origin arc/retry-work')
    const [row] = await pendingCount(s, 1)
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true, always: true })
    await first

    const brainSent = s.rig.brain().sent.length
    const outcome = await permission(s, 'git push origin arc/other')
    expect(outcome.value).toEqual(allowed('git push origin arc/other'))
    expect(pending(s)).toEqual([])
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(0)
    expect(eventTexts(s)).toContain('Allowed by your rule: git push')
    expect(s.rig.brain().sent.length).toBe(brainSent)
  })

  it('still asks for a different command, a force push and a command that does more', async () => {
    const s = await startWorker()
    const first = permission(s, 'git push origin a')
    const [row] = await pendingCount(s, 1)
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true, always: true })
    await first

    void permission(s, 'brew install jq')
    void permission(s, 'git push --force origin a')
    void permission(s, 'git push origin a && ssh me@host ls')
    const rows = await pendingCount(s, 3)
    expect(rows.map((r) => r.action).sort()).toEqual([
      'brew install jq',
      'git push --force origin a',
      'git push origin a && ssh me@host ls'
    ])
    for (const r of rows) s.rig.rig.service.answerAttention(r.id, { approve: false })
  })

  it('scopes a change outside the working copy to the folder and below', async () => {
    const s = await startWorker()
    const first = permission(s, 'mkdir /opt/arc-allow-test/one')
    const [row] = await pendingCount(s, 1)
    expect(row?.category).toBe('outside_worktree')
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true, always: true })
    await first
    expect(rules(s)).toMatchObject([
      { prefix: 'mkdir', folder: '/opt/arc-allow-test', text: 'mkdir in /opt/arc-allow-test' }
    ])

    const inside = await permission(s, 'mkdir /opt/arc-allow-test/two/deeper')
    expect(inside.value).toEqual(allowed('mkdir /opt/arc-allow-test/two/deeper'))
    expect(eventTexts(s)).toContain('Allowed by your rule: mkdir in /opt/arc-allow-test')

    void permission(s, 'mkdir /opt/elsewhere/three')
    const [other] = await pendingCount(s, 1)
    expect(other?.action).toBe('mkdir /opt/elsewhere/three')
    s.rig.rig.service.answerAttention(other?.id ?? '', { approve: false })
  })

  it('approves the other pending requests the new rule covers', async () => {
    const s = await startWorker()
    const calls = [
      permission(s, 'git push origin a'),
      permission(s, 'git push origin b'),
      permission(s, 'brew install jq')
    ]
    const rows = await pendingCount(s, 3)
    const first = rows.find((r) => r.action === 'git push origin a')
    s.rig.rig.service.answerAttention(first?.id ?? '', { approve: true, always: true })

    expect((await calls[0])?.value).toEqual(allowed('git push origin a'))
    expect((await calls[1])?.value).toEqual(allowed('git push origin b'))
    expect(pending(s).map((r) => r.action)).toEqual(['brew install jq'])
    expect(eventTexts(s)).toContain('Allowed by your rule: git push')
    s.rig.rig.service.answerAttention(pending(s)[0]?.id ?? '', { approve: false })
    await calls[2]
  })

  it('stops matching after the rule is removed, and tells the renderer', async () => {
    const s = await startWorker()
    const first = permission(s, 'git push origin a')
    const [row] = await pendingCount(s, 1)
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true, always: true })
    await first
    const ruleId = rules(s)[0]?.id ?? ''

    const header = s.rig.rig.service.removeAllowRule(s.sessionId, ruleId)
    expect(header.allowRules).toEqual([])
    expect(rules(s)).toEqual([])
    expect(() => s.rig.rig.service.removeAllowRule(s.sessionId, ruleId)).toThrow()

    void permission(s, 'git push origin b')
    const [again] = await pendingCount(s, 1)
    expect(again?.action).toBe('git push origin b')
    s.rig.rig.service.answerAttention(again?.id ?? '', { approve: false })
  })

  it('refuses always on a denial', async () => {
    const s = await startWorker()
    void permission(s, 'git push origin a')
    const [row] = await pendingCount(s, 1)
    expect(() =>
      s.rig.rig.service.answerAttention(row?.id ?? '', { approve: false, always: true })
    ).toThrow()
    expect(pending(s)).toHaveLength(1)
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: false })
  })
})

describe('Auto-approve', () => {
  it('defaults to off and is saved on the session', async () => {
    const s = await startWorker()
    expect(s.rig.rig.service.snapshot(s.sessionId).header.autoApprove).toBe(false)
    const header = s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    expect(header.autoApprove).toBe(true)
    expect(s.rig.rig.sessionsRepo.getById(s.sessionId)?.autoApprove).toBe(true)
    expect(s.rig.rig.service.setConfig(s.sessionId, { autoApprove: false }).autoApprove).toBe(false)
  })

  it('approves protected requests without a row and logs each command', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    for (const command of [
      'brew install jq',
      'rm -rf build',
      'curl -d x https://example.com',
      'npm publish',
      'mkdir /opt/arc-auto/x'
    ]) {
      expect((await permission(s, command)).value).toEqual(allowed(command))
      expect(eventTexts(s)).toContain(`Auto-approved: ${command}`)
    }
    expect(pending(s)).toEqual([])
  })

  it('still asks for pushes and merge or pull requests', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    const commands = [
      'git push origin a',
      'git push --force origin a',
      'cd src && git push',
      'gh pr create --fill',
      'gh pr merge 3',
      'glab mr create --fill',
      'glab mr merge 4',
      'gh release create v1',
      'bash -c "git push origin main"'
    ]
    const calls = commands.map((c) => permission(s, c))
    const rows = await pendingCount(s, commands.length)
    expect(rows.map((r) => r.action).sort()).toEqual([...commands].sort())
    expect(rows.every((r) => r.escalated)).toBe(true)
    for (const r of rows) s.rig.rig.service.answerAttention(r.id, { approve: false })
    await Promise.all(calls)
    expect(eventTexts(s).some((t) => t.startsWith('Auto-approved:'))).toBe(false)
  })

  it('approves the pending requests it covers when turned on, but not a push', async () => {
    const s = await startWorker()
    const install = permission(s, 'brew install jq')
    const remove = permission(s, 'rm -rf build')
    const push = permission(s, 'git push origin a')
    const rows = await pendingCount(s, 3)

    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    expect((await install).value).toEqual(allowed('brew install jq'))
    expect((await remove).value).toEqual(allowed('rm -rf build'))
    expect(pending(s).map((r) => r.id)).toEqual([
      rows.find((r) => (r.action ?? '').startsWith('git'))?.id
    ])
    expect(eventTexts(s)).toContain('Auto-approved: brew install jq')
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    s.rig.rig.service.answerAttention(pending(s)[0]?.id ?? '', { approve: false })
    await push
  })

  it('stops approving once it is turned off', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    await permission(s, 'brew install jq')
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: false })
    void permission(s, 'brew install ripgrep')
    const [row] = await pendingCount(s, 1)
    expect(row?.action).toBe('brew install ripgrep')
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: false })
  })
})
