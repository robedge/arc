import { describe, expect, it } from 'vitest'
import type {
  AgentRole,
  ClaudeStartOptions,
  ClaudeStartRequest
} from '../../../src/main/agents/agent-adapter'
import { buildClaudeArgs } from '../../../src/main/agents/claude-adapter'

type Given = Partial<Omit<ClaudeStartRequest, 'claude' | 'provider'>> & {
  role: AgentRole
  claude?: ClaudeStartOptions
}

/** `buildClaudeArgs` over the common start options; `claude` carries the Claude-only block. */
function build(given: Given): string[] {
  return buildClaudeArgs({
    provider: 'claude',
    agentId: 'brain',
    cwd: '/k',
    model: 'sonnet',
    access: given.role === 'brain' ? 'brain-readonly' : 'worker-write',
    claude: {},
    ...given
  })
}

describe('buildClaudeArgs', () => {
  it('builds the exact brain argv', () => {
    const args = build({
      role: 'brain',
      addDirs: ['/repo/a', '/repo/b'],
      instructions: 'You are the brain.'
    })
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--model',
      'sonnet',
      '--setting-sources',
      'project',
      '--add-dir',
      '/repo/a',
      '--add-dir',
      '/repo/b',
      '--append-system-prompt',
      'You are the brain.',
      '--allowedTools',
      'Read Grep Glob WebFetch WebSearch',
      '--disallowedTools',
      'Edit Write NotebookEdit AskUserQuestion'
    ])
  })

  it('brain: allows WebFetch and WebSearch, never edits, and leaves Bash to the permission tool', () => {
    const args = build({ role: 'brain' })
    const allowed = args[args.indexOf('--allowedTools') + 1]?.split(' ') ?? []
    expect(allowed).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']))
    // Bash is neither allowed outright nor disallowed: it reaches the permission prompt tool.
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash'])
      expect(allowed).not.toContain(tool)
    const disallowed = (args[args.indexOf('--disallowedTools') + 1] ?? '').split(' ')
    expect(disallowed).toEqual(['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion'])
    expect(disallowed).not.toContain('Bash')
  })

  it('brain: passes the permission prompt tool when given one', () => {
    const args = build({
      role: 'brain',
      claude: { permissionPromptTool: 'mcp__arc__request_permission' }
    })
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__arc__request_permission')
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(
      'Edit Write NotebookEdit AskUserQuestion'
    )
  })

  it('brain: default permission mode, no plan mode, no permission-prompt tool unless given, no mcp config', () => {
    const args = build({ role: 'brain' })
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('plan')
    expect(args).not.toContain('--permission-prompt-tool')
    expect(args.some((a) => a.startsWith('--mcp-config'))).toBe(false)
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('adds --resume only when resuming', () => {
    expect(build({ role: 'brain' })).not.toContain('--resume')
    const args = build({ role: 'brain', resume: { threadId: 'abc' } })
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      'abc'
    ])
  })

  it('uses the = form for --mcp-config when given', () => {
    const args = build({ role: 'brain', claude: { mcpConfigPath: '/tmp/m.json' } })
    expect(args).toContain('--mcp-config=/tmp/m.json')
    expect(args).toContain('--strict-mcp-config')
  })

  it('brain: lists the exact bridge tools and ToolSearch instead of a wildcard', () => {
    const args = build({
      role: 'brain',
      bridgeTools: ['propose_plan', 'spawn_worker']
    })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read Grep Glob WebFetch WebSearch ToolSearch mcp__arc__propose_plan mcp__arc__spawn_worker'
    )
    expect(args.join(' ')).not.toContain('mcp__arc__*')
  })

  it('worker: acceptEdits and read tools only, with no Bash or edit allowlist so they reach the permission tool', () => {
    const args = build({ role: 'worker', bridgeTools: ['report_done'] })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    const allowed = args.slice(args.indexOf('--allowedTools') + 1)
    expect(allowed).toEqual(['Read', 'Grep', 'Glob', 'ToolSearch', 'mcp__arc__report_done'])
    expect(allowed.some((t) => t.startsWith('Bash'))).toBe(false)
    expect(allowed).not.toContain('Edit')
    expect(allowed).not.toContain('Write')
  })

  it('worker: passes the permission prompt tool when one is given', () => {
    const args = build({
      role: 'worker',
      claude: { permissionPromptTool: 'mcp__arc__request_permission' }
    })
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__arc__request_permission')
  })

  it('worker: denies edits in the read-only directories with absolute-path rules', () => {
    const args = build({ role: 'worker', readOnlyDirs: ['/repo/other'] })
    expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual([
      'Edit(//repo/other/**)',
      'Write(//repo/other/**)',
      'NotebookEdit(//repo/other/**)'
    ])
  })
})

describe('buildClaudeArgs personal hooks and MCP', () => {
  it.each(['brain', 'worker'] as const)(
    'adds the hooks-only --settings file for the %s and keeps --setting-sources project',
    (role) => {
      const args = build({
        role,
        claude: { hooksSettingsPath: '/ud/agent-config/abc/hooks.settings.json' }
      })
      expect(args[args.indexOf('--settings') + 1]).toBe('/ud/agent-config/abc/hooks.settings.json')
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('project')
      // `user` never joins the sources: that would load the user's permission rules and env.
      expect(args.join(' ')).not.toMatch(/--setting-sources [^ ]*user/)
    }
  )

  it('omits --settings when the user has no hooks', () => {
    expect(build({ role: 'brain' })).not.toContain('--settings')
  })

  it('keeps the brain allowed-tools list when personal files are given', () => {
    const args = build({
      role: 'brain',
      bridgeTools: ['propose_plan'],
      claude: { mcpConfigPath: '/ud/agent-config/abc/mcp.json', hooksSettingsPath: '/h.json' }
    })
    expect(args).toContain('--mcp-config=/ud/agent-config/abc/mcp.json')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read Grep Glob WebFetch WebSearch ToolSearch mcp__arc__propose_plan'
    )
  })
})

describe('buildClaudeArgs --plugin-dir', () => {
  it.each(['brain', 'worker'] as const)('adds the plugin view for the %s', (role) => {
    const args = build({ role, claude: { pluginViewDir: '/ud/agent-plugins/abc' } })
    const i = args.indexOf('--plugin-dir')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('/ud/agent-plugins/abc')
  })

  it('omits the flag without a view', () => {
    expect(build({ role: 'brain' })).not.toContain('--plugin-dir')
  })
})
