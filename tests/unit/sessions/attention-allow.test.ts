import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerTools } from '../../../src/main/agents/agent-adapter'
import { McpToolCatalogue } from '../../../src/main/personal/mcp-tool-catalogue'
import type { PersonalLaunchConfig } from '../../../src/main/personal/personal-config'
import { channelSchemas } from '../../../src/shared/ipc/contract'
import { AttentionService } from '../../../src/main/sessions/attention-service'
import type { AttentionNotice } from '../../../src/main/sessions/attention-service'
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

async function startWorker(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<Started> {
  e = await makeEngineRig(dir(), overrides)
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

const skipText = (command: string): string => `Approved (skipping approvals): ${command}`

const brainBash = (s: Started, command: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.rig.brain(), 'request_permission', {
    tool_name: 'Bash',
    input: { command },
    tool_use_id: 'toolu_b1'
  })

describe('Skip all approvals', () => {
  it('defaults to off, is saved on the session, and never writes auto_approve', async () => {
    const s = await startWorker()
    expect(s.rig.rig.service.snapshot(s.sessionId).header.skipApprovals).toBe(false)
    const on = s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    expect(on.skipApprovals).toBe(true)
    expect(s.rig.rig.sessionsRepo.getById(s.sessionId)).toMatchObject({
      skipApprovals: true,
      autoApprove: false
    })
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: false })
    expect(s.rig.rig.sessionsRepo.getById(s.sessionId)).toMatchObject({
      skipApprovals: false,
      autoApprove: true
    })
  })

  it('writes an event for each change', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: false })
    const texts = eventTexts(s)
    expect(texts).toContain(
      "Skip all approvals turned on: every permission is approved except pushes and pull or merge requests; limits lift from each agent's next turn"
    )
    expect(texts).toContain(
      "Skip all approvals turned off; limits return from each agent's next turn"
    )
  })

  it('approves each covered category for a worker without a row, with the event text', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    for (const command of [
      'rm -rf build',
      'curl -d x https://example.com',
      'brew install jq',
      'mkdir /opt/arc-skip/x'
    ]) {
      expect((await permission(s, command)).value).toEqual(allowed(command))
      expect(eventTexts(s)).toContain(skipText(command))
    }
    expect(pending(s)).toEqual([])
    expect(eventTexts(s).some((t) => t.startsWith('Auto-approved:'))).toBe(false)
  })

  it("approves the brain's changes_checkout commands without a row", async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    expect((await brainBash(s, 'git commit -am x')).value).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git commit -am x' }
    })
    expect(eventTexts(s)).toContain(skipText('git commit -am x'))
    expect(pending(s)).toEqual([])
  })

  it('still asks for pushes and merge or pull requests, from a worker and the brain', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    const commands = ['git push origin a', 'gh pr create --fill', 'glab mr merge 4']
    const calls = commands.map((c) => permission(s, c))
    const brainCall = brainBash(s, 'git push origin main')
    const rows = await pendingCount(s, commands.length + 1)
    expect(rows.map((r) => r.action).sort()).toEqual([...commands, 'git push origin main'].sort())
    expect(rows.every((r) => r.escalated)).toBe(true)
    for (const r of rows) s.rig.rig.service.answerAttention(r.id, { approve: false })
    await Promise.all([...calls, brainCall])
    expect(eventTexts(s).some((t) => t.startsWith('Approved (skipping approvals)'))).toBe(false)
  })

  it('still asks a question and an AskUserQuestion', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    const ask = s.rig.call(s.worker, 'request_permission', {
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'axios', description: 'a' },
              { label: 'ky', description: 'b' }
            ]
          }
        ]
      },
      tool_use_id: 'toolu_q1'
    })
    const [row] = await pendingCount(s, 1)
    expect(row?.escalated).toBe(true)
    s.rig.rig.service.answerAttention(row?.id ?? '', { answers: { 'Which library?': ['axios'] } })
    await ask
    expect(eventTexts(s).some((t) => t.startsWith('Approved (skipping approvals)'))).toBe(false)
  })

  it('approves the waiting permissions when turned on, but not a push', async () => {
    const s = await startWorker()
    const remove = permission(s, 'rm -rf build')
    const curl = permission(s, 'curl -d x https://example.com')
    const push = permission(s, 'git push origin a')
    const rows = await pendingCount(s, 3)

    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    expect((await remove).value).toEqual(allowed('rm -rf build'))
    expect((await curl).value).toEqual(allowed('curl -d x https://example.com'))
    expect(pending(s).map((r) => r.id)).toEqual([
      rows.find((r) => (r.action ?? '').startsWith('git'))?.id
    ])
    expect(eventTexts(s)).toContain(skipText('rm -rf build'))
    expect(s.rig.rig.service.attentionState(s.sessionId).count).toBe(1)
    s.rig.rig.service.answerAttention(pending(s)[0]?.id ?? '', { approve: false })
    await push
  })

  it('leaves a waiting question pending when turned on', async () => {
    const s = await startWorker()
    const ask = s.rig.call(s.worker, 'request_permission', {
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'axios', description: 'a' },
              { label: 'ky', description: 'b' }
            ]
          }
        ]
      },
      tool_use_id: 'toolu_q1'
    })
    const [row] = await pendingCount(s, 1)
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    expect(pending(s).map((r) => r.id)).toEqual([row?.id])
    s.rig.rig.service.answerAttention(row?.id ?? '', { answers: { 'Which library?': ['axios'] } })
    await ask
  })

  it('stops approving once it is turned off, and leaves Auto-approve as it was', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    await permission(s, 'rm -rf build')
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: false })
    void permission(s, 'brew install ripgrep')
    const [row] = await pendingCount(s, 1)
    expect(row?.action).toBe('brew install ripgrep')
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: false })
  })

  it('leaves Auto-approve unchanged while skip is off', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { autoApprove: true })
    expect((await permission(s, 'rm -rf build')).value).toEqual(allowed('rm -rf build'))
    expect(eventTexts(s)).toContain('Auto-approved: rm -rf build')
    expect(eventTexts(s).some((t) => t.startsWith('Approved (skipping approvals)'))).toBe(false)
  })

  it('raises no notification for an approval it skipped', async () => {
    const s = await startWorker()
    const notices: AttentionNotice[] = []
    const service = new AttentionService({
      sessions: s.rig.rig.service,
      attentionRepo: s.rig.rig.deps.attentionRepo,
      branchQuestionsRepo: s.rig.rig.deps.branchQuestionsRepo,
      sessionsRepo: s.rig.rig.sessionsRepo,
      workerOf: (id) => s.rig.rig.deps.workersRepo.get(id),
      emit: () => undefined,
      onNewRequest: (n) => notices.push(n)
    })
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    await permission(s, 'rm -rf build')
    service.onAttentionChanged(s.sessionId, s.rig.rig.service.attentionState(s.sessionId))
    expect(notices).toEqual([])

    const push = permission(s, 'git push origin a')
    const [row] = await pendingCount(s, 1)
    service.onAttentionChanged(s.sessionId, s.rig.rig.service.attentionState(s.sessionId))
    expect(notices.map((n) => n.requestId)).toEqual([row?.id])
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: false })
    await push
  })
})

const githubTools: McpServerTools[] = [
  {
    name: 'github',
    connected: true,
    tools: [
      { name: 'create_pull_request', readOnly: false, destructive: false },
      { name: 'push_files', readOnly: false, destructive: false },
      { name: 'update_pull_request', readOnly: false, destructive: false }
    ]
  }
]

function githubPersonal(): PersonalLaunchConfig {
  let count = 0
  return {
    mcp: new McpToolCatalogue(),
    claude: vi.fn((request: { arcConfigPath?: string }) => {
      const out = join(dir(), `merged-${++count}.json`)
      if (request.arcConfigPath) copyFileSync(request.arcConfigPath, out)
      return Promise.resolve({ mcpConfigPath: out })
    }),
    codexMcp: vi.fn(() => Promise.resolve({ servers: [], degraded: false })),
    bypass: vi.fn(() =>
      Promise.resolve({ claudeHookEvents: [], codexAllowPrefixes: [], codexRulesCovered: 0 })
    )
  }
}

const mcpCall = (s: Started, tool: string, id: string): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', {
    tool_name: `mcp__github__${tool}`,
    input: { title: 'x' },
    tool_use_id: id
  })

describe('Skip all approvals and tools of a connected tool server', () => {
  it('sends a pull request or a push straight to the user, and covers an edit of a pull request', async () => {
    const s = await startWorker({ personal: githubPersonal() })
    s.worker.mcpTools = () => Promise.resolve(githubTools)
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })

    const create = mcpCall(s, 'create_pull_request', 'toolu_a')
    const push = mcpCall(s, 'push_files', 'toolu_b')
    const rows = await pendingCount(s, 2)
    expect(rows.map((r) => r.toolName).sort()).toEqual([
      'mcp__github__create_pull_request',
      'mcp__github__push_files'
    ])
    expect(rows.every((r) => r.mustEscalate && r.escalated && r.route === 'queue')).toBe(true)
    for (const row of rows) {
      const attempt = await s.rig.call(s.rig.brain(), 'resolve_request', {
        requestId: row.id,
        decision: 'approve'
      })
      expect(attempt.isError).toBe(true)
      expect(attempt.value['error']).toBe('policy_requires_user')
      expect(s.rig.rig.deps.attentionRepo.get(row.id)?.status).toBe('pending')
    }

    const edit = await mcpCall(s, 'update_pull_request', 'toolu_c')
    expect(edit.value).toEqual({ behavior: 'allow', updatedInput: { title: 'x' } })
    expect(eventTexts(s)).toContain(
      'Approved (skipping approvals): mcp__github__update_pull_request {"title":"x"}'
    )
    expect(pending(s)).toHaveLength(2)

    for (const row of rows) s.rig.rig.service.answerAttention(row.id, { approve: false })
    await Promise.all([create, push])
  })

  it('leaves a pull request tool to the brain as before while skip is off', async () => {
    const s = await startWorker({ personal: githubPersonal() })
    s.worker.mcpTools = () => Promise.resolve(githubTools)
    const call = mcpCall(s, 'create_pull_request', 'toolu_a')
    const [row] = await pendingCount(s, 1)
    expect(row).toMatchObject({ category: 'mcp_write', mustEscalate: false, escalated: false })
    s.rig.rig.service.answerAttention(row?.id ?? '', { approve: true })
    expect((await call).value).toMatchObject({ behavior: 'allow' })
  })
})

describe('Skip all approvals and the attachments folder', () => {
  it('does not cover a command that changes an attachment, and still covers one elsewhere', async () => {
    const s = await startWorker()
    s.rig.rig.service.setConfig(s.sessionId, { skipApprovals: true })
    const folder = join(dir(), 'userData', 'sessions', s.sessionId, 'attachments', 'a1')

    expect((await permission(s, 'rm -rf /opt/arc-skip/x')).value).toMatchObject({
      behavior: 'allow'
    })
    const remove = permission(s, `rm -rf ${folder}`)
    const edit = permission(s, `rm ${folder}/photo.png`)
    const rows = await pendingCount(s, 2)
    expect(rows.map((r) => r.action).sort()).toEqual(
      [`rm ${folder}/photo.png`, `rm -rf ${folder}`].sort()
    )
    expect(rows.every((r) => r.escalated)).toBe(true)
    expect(eventTexts(s)).not.toContain(skipText(`rm -rf ${folder}`))
    for (const row of rows) s.rig.rig.service.answerAttention(row.id, { approve: false })
    await Promise.all([remove, edit])
  })
})
