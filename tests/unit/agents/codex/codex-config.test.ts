import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CodexStartRequest } from '../../../../src/main/agents/agent-adapter'
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  finishCodexEnv,
  gitRootsFor,
  writableRootsFor
} from '../../../../src/main/agents/codex/codex-config'
import { buildAgentEnv } from '../../../../src/main/agents/process-supervisor'

let dir: string
let repo: string
let tree: string
let second: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-codex-config-')))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
  // The folder name differs from the worktree id git picks, which comes from the `.git` file.
  tree = join(dir, 'trees', 'feature-folder')
  mkdirSync(join(dir, 'trees'))
  git(repo, 'worktree', 'add', '-q', '-b', 'a', tree)
  second = join(dir, 'trees', 'other')
  git(repo, 'worktree', 'add', '-q', '-b', 'b', second)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function request(over: Partial<CodexStartRequest> = {}): CodexStartRequest {
  return {
    provider: 'codex',
    agentId: 'w1',
    role: 'worker',
    cwd: tree,
    model: 'gpt-x',
    access: 'worker-write',
    codex: {},
    ...over
  }
}

describe('gitRootsFor', () => {
  it('lists the worktree admin dir read from the .git file, plus objects, refs and logs of the common dir', () => {
    const roots = gitRootsFor(tree)
    expect(roots).toEqual([
      join(repo, '.git', 'worktrees', 'feature-folder'),
      join(repo, '.git', 'objects'),
      join(repo, '.git', 'refs'),
      join(repo, '.git', 'logs')
    ])
  })

  it('takes the id from the gitdir line, not from the folder name', () => {
    const odd = join(dir, 'odd')
    mkdirSync(odd)
    writeFileSync(join(odd, '.git'), `gitdir: ${repo}/.git/worktrees/some-other-id\n`)
    expect(gitRootsFor(odd)[0]).toBe(join(repo, '.git', 'worktrees', 'some-other-id'))
  })

  it('adds nothing for a plain repository or a folder with no .git', () => {
    expect(gitRootsFor(repo)).toEqual([])
    expect(gitRootsFor(dir)).toEqual([])
  })
})

describe('writableRootsFor', () => {
  it('covers each working copy and its git dirs, and not the read-only extra dirs', () => {
    const knowledge = join(dir, 'knowledge')
    const roots = writableRootsFor(
      request({ addDirs: [second, knowledge], readOnlyDirs: [knowledge] })
    )
    expect(roots).toEqual(
      expect.arrayContaining([tree, second, join(repo, '.git', 'worktrees', 'other')])
    )
    expect(roots).not.toContain(knowledge)
    expect(roots).not.toContain(repo)
    expect(roots).not.toContain(join(repo, '.git'))
    expect(new Set(roots).size).toBe(roots.length) // shared common dirs appear once
  })
})

describe('thread params', () => {
  const bridge = { url: 'http://127.0.0.1:5555/mcp', token: 'secret-token' }

  it('starts a worker on the user subscription with approvals to the user and a workspace-write sandbox', () => {
    const params = buildThreadStartParams(
      request({ bridge, bridgeTools: ['report_done', 'ask_brain'], instructions: 'Be brief.' })
    )
    expect(params).toMatchObject({
      cwd: tree,
      model: 'gpt-x',
      modelProvider: 'openai',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: false,
      developerInstructions: 'Be brief.'
    })
    expect(params).not.toHaveProperty('baseInstructions')
    const config = params['config'] as Record<string, Record<string, unknown>>
    expect(config['sandbox_workspace_write']).toMatchObject({
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
      network_access: false
    })
    expect(config['sandbox_workspace_write']?.['writable_roots']).toEqual(
      expect.arrayContaining([tree, join(repo, '.git', 'worktrees', 'feature-folder')])
    )
  })

  it('describes the arc server by the token env var, never the token itself', () => {
    const params = buildThreadStartParams(request({ bridge, bridgeTools: ['report_done'] }))
    const config = params['config'] as { mcp_servers: Record<string, unknown> }
    expect(config.mcp_servers).toEqual({
      arc: {
        url: bridge.url,
        bearer_token_env_var: 'ARC_BRIDGE_TOKEN',
        required: true,
        startup_timeout_sec: 20,
        tool_timeout_sec: 86_400,
        default_tools_approval_mode: 'approve',
        enabled_tools: ['report_done']
      }
    })
    expect(JSON.stringify(params)).not.toContain('secret-token')
  })

  it("gives each personal MCP server only the prompt approval mode, next to arc's own entry", () => {
    const params = buildThreadStartParams(
      request({
        bridge,
        bridgeTools: ['report_done'],
        codex: { personalMcpServers: ['figma', 'github'] }
      })
    )
    const servers = (params['config'] as { mcp_servers: Record<string, Record<string, unknown>> })
      .mcp_servers
    expect(Object.keys(servers).sort()).toEqual(['arc', 'figma', 'github'])
    // Nothing but the mode: the user's command, args and env stay theirs (the override merges, S10).
    expect(servers['figma']).toEqual({ default_tools_approval_mode: 'prompt' })
    expect(servers['github']).toEqual({ default_tools_approval_mode: 'prompt' })
    expect(servers['arc']).toMatchObject({ default_tools_approval_mode: 'approve' })
  })

  it('also sets prompt on the tools the user gave an approval mode of their own, which would beat the server default', () => {
    const params = buildThreadStartParams(
      request({
        bridge,
        codex: {
          personalMcpServers: ['trello', 'figma'],
          personalMcpApprovalTools: { trello: ['trello_update_card', 'trello_get_lists'] }
        }
      })
    )
    const servers = (params['config'] as { mcp_servers: Record<string, Record<string, unknown>> })
      .mcp_servers
    expect(servers['trello']).toEqual({
      default_tools_approval_mode: 'prompt',
      tools: {
        trello_update_card: { approval_mode: 'prompt' },
        trello_get_lists: { approval_mode: 'prompt' }
      }
    })
    expect(servers['figma']).toEqual({ default_tools_approval_mode: 'prompt' })
  })

  it('disables a server the user switched off on the thread, and still asks about the ones that run (spec 009)', () => {
    const params = buildThreadStartParams(
      request({
        bridge,
        bridgeTools: ['report_done'],
        codex: { personalMcpServers: ['github'], disabledMcpServers: ['figma'] }
      })
    )
    const servers = (params['config'] as { mcp_servers: Record<string, Record<string, unknown>> })
      .mcp_servers
    expect(Object.keys(servers).sort()).toEqual(['arc', 'figma', 'github'])
    // Nothing but the switch: the override merges with the user's own entry (spike S10).
    expect(servers['figma']).toEqual({ enabled: false })
    expect(servers['github']).toEqual({ default_tools_approval_mode: 'prompt' })
    expect(servers['arc']).toMatchObject({ default_tools_approval_mode: 'approve' })
  })

  it('sends the disabled servers on resume too, and never disables arc', () => {
    const options = request({ bridge, codex: { disabledMcpServers: ['figma', 'arc'] } })
    const resumed = buildThreadResumeParams(options, 'thread-1')
    const servers = (resumed['config'] as { mcp_servers: Record<string, Record<string, unknown>> })
      .mcp_servers
    expect(servers['figma']).toEqual({ enabled: false })
    expect(servers['arc']).toMatchObject({
      url: bridge.url,
      default_tools_approval_mode: 'approve'
    })
    expect(servers['arc']).not.toHaveProperty('enabled')
  })

  it('never lets a personal server named arc replace the bridge entry', () => {
    const params = buildThreadStartParams(
      request({ bridge, codex: { personalMcpServers: ['arc'] } })
    )
    const servers = (params['config'] as { mcp_servers: Record<string, Record<string, unknown>> })
      .mcp_servers
    expect(servers['arc']).toMatchObject({
      url: bridge.url,
      default_tools_approval_mode: 'approve'
    })
  })

  it('sends the personal servers even without a bridge, for the brain and for workers', () => {
    for (const access of ['brain-readonly', 'worker-write'] as const) {
      const params = buildThreadStartParams(
        request({
          access,
          role: access === 'brain-readonly' ? 'brain' : 'worker',
          codex: { personalMcpServers: ['figma'] }
        })
      )
      expect(params['config']).toMatchObject({
        mcp_servers: { figma: { default_tools_approval_mode: 'prompt' } }
      })
    }
  })

  it('gives the brain a read-only sandbox with no writable roots', () => {
    const params = buildThreadStartParams(
      request({ role: 'brain', access: 'brain-readonly', cwd: dir, bridge })
    )
    expect(params['sandbox']).toBe('read-only')
    expect(params['config']).not.toHaveProperty('sandbox_workspace_write')
  })

  it('leaves out the arc server when there is no bridge, and the instructions when there are none', () => {
    const params = buildThreadStartParams(request())
    expect(params['config']).not.toHaveProperty('mcp_servers')
    expect(params).not.toHaveProperty('developerInstructions')
  })

  it('resumes with the same overrides and without replaying the history', () => {
    const params = buildThreadResumeParams(request({ bridge, instructions: 'Again.' }), 'thr-9')
    expect(params).toMatchObject({
      threadId: 'thr-9',
      excludeTurns: true,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      developerInstructions: 'Again.'
    })
    expect(params).not.toHaveProperty('ephemeral')
    expect((params['config'] as Record<string, unknown>)['mcp_servers']).toBeDefined()
  })
})

describe('finishCodexEnv', () => {
  const base = {
    HOME: '/h',
    OPENAI_API_KEY: 'sk-nope',
    OPENAI_BASE_URL: 'http://x',
    CODEX_API_KEY: 'nope',
    CODEX_HOME: '/user/codex',
    ANTHROPIC_API_KEY: 'nope',
    HARNESS_E2E: '1'
  } as NodeJS.ProcessEnv

  it('passes no API key and no CODEX_* but the home, and sets the Arc entries', () => {
    const env = finishCodexEnv(
      buildAgentEnv(base, '/bin', { OPENAI_ORG_ID: 'o', CODEX_API_KEY: 'x', KEEP: 'yes' }),
      request({ bridge: { url: 'u', token: 'tok' } }),
      base
    )
    expect(Object.keys(env).filter((k) => /^OPENAI_|^CODEX_|ANTHROPIC/.test(k))).toEqual([
      'CODEX_HOME'
    ])
    expect(env['CODEX_HOME']).toBe('/user/codex')
    expect(env).toMatchObject({
      KEEP: 'yes',
      ARC_AGENT: '1',
      ARC_AGENT_ROLE: 'worker',
      ARC_PROVIDER: 'codex',
      ARC_BRIDGE_TOKEN: 'tok'
    })
  })

  it('does not pass a CODEX_HOME the user never set, and lets the start options choose one', () => {
    const none = finishCodexEnv(buildAgentEnv({ HOME: '/h' }, '/bin'), request(), { HOME: '/h' })
    expect(none).not.toHaveProperty('CODEX_HOME')
    expect(none).not.toHaveProperty('ARC_BRIDGE_TOKEN')
    const chosen = finishCodexEnv(
      buildAgentEnv({ HOME: '/h' }, '/bin'),
      request({ codex: { codexHome: '/chosen' } }),
      { HOME: '/h' }
    )
    expect(chosen['CODEX_HOME']).toBe('/chosen')
  })

  it('does not let extraEnv change who the agent is', () => {
    const env = finishCodexEnv(
      buildAgentEnv(base, '/bin', { ARC_AGENT_ROLE: 'brain', ARC_BRIDGE_TOKEN: 'other' }),
      request({ bridge: { url: 'u', token: 'tok' } }),
      base
    )
    expect(env['ARC_AGENT_ROLE']).toBe('worker')
    expect(env['ARC_BRIDGE_TOKEN']).toBe('tok')
  })
})
