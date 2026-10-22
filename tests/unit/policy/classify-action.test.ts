import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classify, classifyAction } from '../../../src/main/policy/classify'
import type { ClassifyContext } from '../../../src/main/policy/classify'
import { classifyBrainAction, classifyBrainBash } from '../../../src/main/policy/brain-policy'
import { normalizeClaudeCall, toStoredCall } from '../../../src/main/policy/normalized-action'
import type { NormalizedAction } from '../../../src/main/policy/normalized-action'
import { BASH_CASES, fillCase } from './classify-cases'

let base: string
let wt: string
let other: string
let tempArea: string
let ctx: ClassifyContext

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'arc-classify-action-')))
  wt = join(base, 'worktree')
  other = join(base, 'user-checkout')
  mkdirSync(join(wt, 'src'), { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(wt, 'README.md'), 'x')
  symlinkSync(other, join(wt, 'link-out'))
  tempArea = join(base, 'tmp-area')
  mkdirSync(tempArea, { recursive: true })
  symlinkSync('/usr', join(tempArea, 'out'))
  ctx = { worktreeRoots: [wt], readOnlyDirs: [other], home: '/home/arc-test', tempDirs: [tempArea] }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Every non-Bash case of the Claude entry point's tests: [tool, input]. */
function toolCases(): [string, Record<string, unknown>][] {
  return [
    ['Edit', { file_path: join(wt, 'README.md') }],
    ['Write', { file_path: join(wt, 'src', 'new', 'deep.ts') }],
    ['NotebookEdit', { notebook_path: join(wt, 'n.ipynb') }],
    ['Edit', { file_path: join(other, 'src', 'a.ts') }],
    ['Write', { file_path: '/etc/passwd' }],
    ['Write', { file_path: join(wt, '..', 'escape.txt') }],
    ['NotebookEdit', { notebook_path: join(base, 'n.ipynb') }],
    ['MultiEdit', { file_path: join(base, 'x.ts') }],
    ['Write', { file_path: join(wt, 'link-out', 'a.ts') }],
    ['Write', { file_path: `${wt}-evil/a.ts` }],
    ['Edit', {}],
    ['Write', { file_path: 7 }],
    ['Edit', { file_path: '   ' }],
    ['NotebookEdit', { notebook_path: 5, file_path: join(wt, 'a.ipynb') }],
    ['Write', { file_path: join(tempArea, 'out.txt') }],
    ['Edit', { file_path: join(tempArea, 'deep', 'er', 'a.ts') }],
    ['Write', { file_path: join(tempArea, 'out', 'x.txt') }],
    ['Write', { file_path: join(tempArea, '..', 'x.txt') }],
    ['Bash', {}],
    ['Bash', { command: 42 }],
    ['WebFetch', { url: 'https://example.com/docs', prompt: 'summarise' }],
    ['WebSearch', { query: 'electron 44 release notes' }],
    ['Read', { file_path: '/etc/hosts' }],
    ['Grep', { pattern: 'x', path: '/tmp/w1-dl' }],
    ['Glob', { pattern: '**/*.ts', path: '/opt/other' }],
    ['mcp__other__thing', { a: 1 }]
  ]
}

describe('classifyAction parity with classify()', () => {
  it('runs every shell case of the classifier table', () => {
    // The same table classify.test.ts runs; a case added there is checked here too.
    expect(BASH_CASES.length).toBeGreaterThanOrEqual(60)
    const seen = new Set<string | null>()
    for (const [command, expected] of BASH_CASES) {
      const text = fillCase(command, { other, tempArea })
      const viaClaude = classify('Bash', { command: text }, ctx)
      const viaAction = classifyAction({ kind: 'bash', command: text }, ctx)
      // The neutral entry point agrees with the Claude one in every field, and with the table.
      expect(viaAction, command).toEqual(viaClaude)
      expect(viaAction.category, command).toBe(expected)
      expect(viaAction.mustEscalate, command).toBe(expected !== null)
      seen.add(expected)
    }
    for (const c of ['outside_worktree', 'leaves_machine', 'destructive', 'global_install', null]) {
      expect(seen.has(c)).toBe(true)
    }
  })

  it('runs the file tools, the unreadable inputs and the tools that are not gated', () => {
    const results: Record<string, unknown> = {}
    for (const [tool, input] of toolCases()) {
      const viaClaude = classify(tool, input, ctx)
      const viaAction = classifyAction(normalizeClaudeCall(tool, input), ctx)
      expect(viaAction, `${tool} ${JSON.stringify(input)}`).toEqual(viaClaude)
      results[`${tool} ${JSON.stringify(input)}`] = viaAction.category
    }
    expect(results[`Edit ${JSON.stringify({ file_path: join(wt, 'README.md') })}`]).toBeNull()
    expect(results[`Edit ${JSON.stringify({})}`]).toBe('outside_worktree')
    expect(results[`Bash ${JSON.stringify({ command: 42 })}`]).toBe('destructive')
    expect(results[`mcp__other__thing ${JSON.stringify({ a: 1 })}`]).toBeNull()
    expect(results[`Read ${JSON.stringify({ file_path: '/etc/hosts' })}`]).toBeNull()
  })

  it('round-trips an action through its stored form to the same verdict', () => {
    const actions: NormalizedAction[] = [
      { kind: 'bash', command: 'git push origin main', cwd: wt },
      { kind: 'bash', command: 'ls' },
      { kind: 'edit', tool: 'Edit', paths: [join(wt, 'a.ts'), join(other, 'b.ts')] },
      { kind: 'edit', tool: 'Edit', paths: [join(wt, 'a.ts')] },
      { kind: 'edit', tool: 'Edit', paths: [], unknownPaths: true },
      {
        kind: 'permission',
        reason: 'write to /opt',
        fileSystem: { write: ['/opt'] },
        network: true
      }
    ]
    for (const action of actions) {
      const stored = toStoredCall(action)
      const again = normalizeClaudeCall(stored.toolName, stored.input)
      expect(classifyAction(again, ctx), JSON.stringify(action)).toEqual(
        classifyAction(action, ctx)
      )
    }
  })
})

describe('classifyAction: the Codex shapes', () => {
  it('classifies a bash command against the directory Codex runs it in', () => {
    const inSrc = classifyAction(
      { kind: 'bash', command: 'rm ../README.md', cwd: join(wt, 'src') },
      ctx
    )
    expect(inSrc.category).toBeNull()
    const escape = classifyAction(
      { kind: 'bash', command: 'rm ../../x', cwd: join(wt, 'src') },
      ctx
    )
    expect(escape.category).toBe('outside_worktree')
  })

  it('treats a Codex git push as leaving the machine: it must go to the user', () => {
    expect(classifyAction({ kind: 'bash', command: 'git push origin HEAD' }, ctx)).toMatchObject({
      category: 'leaves_machine',
      mustEscalate: true
    })
  })

  it('checks every file of a multi-file change, and fails closed when the files are unknown', () => {
    expect(
      classifyAction(
        { kind: 'edit', tool: 'Edit', paths: [join(wt, 'a.ts'), join(wt, 'b.ts')] },
        ctx
      ).category
    ).toBeNull()
    const mixed = classifyAction(
      { kind: 'edit', tool: 'Edit', paths: [join(wt, 'a.ts'), join(other, 'b.ts')] },
      ctx
    )
    expect(mixed).toMatchObject({ category: 'outside_worktree', mustEscalate: true })
    expect(mixed.paths).toEqual([join(other, 'b.ts')])
    // Codex gave only a grant root, or nothing: Arc cannot tell what changes, so even a root inside the worktree asks.
    expect(
      classifyAction({ kind: 'edit', tool: 'Edit', paths: [wt], unknownPaths: true }, ctx).category
    ).toBe('outside_worktree')
    expect(
      classifyAction({ kind: 'edit', tool: 'Edit', paths: [], unknownPaths: true }, ctx).category
    ).toBe('outside_worktree')
  })

  it('lets a read-only MCP tool run, and asks about any other: the brain may approve it', () => {
    const mcp = (readOnly: 'yes' | 'no' | 'unknown'): NormalizedAction => ({
      kind: 'mcp',
      server: 'figma',
      tool: 'get_file',
      readOnly
    })
    expect(classifyAction(mcp('yes'), ctx)).toMatchObject({ category: null, mustEscalate: false })
    for (const readOnly of ['no', 'unknown'] as const) {
      expect(classifyAction(mcp(readOnly), ctx)).toMatchObject({
        category: 'mcp_write',
        mustEscalate: false
      })
    }
  })

  it('sends an extra-permissions request to the user only', () => {
    expect(
      classifyAction({ kind: 'permission', reason: 'needs the network', network: true }, ctx)
    ).toMatchObject({ category: 'extra_permissions', mustEscalate: true })
  })

  it('does not gate a tool it has no rule for', () => {
    expect(classifyAction({ kind: 'other', tool: 'WebFetch', input: {} }, ctx).category).toBeNull()
  })
})

describe('classifyBrainAction', () => {
  let brainCtx: ClassifyContext
  beforeAll(() => {
    brainCtx = { worktreeRoots: [], readOnlyDirs: [], tempDirs: [tempArea] }
  })

  it('keeps the brain rules for shell commands', () => {
    for (const command of [
      'ls',
      'git status',
      'git commit -m x',
      'git push',
      `echo > ${other}/a`
    ]) {
      const verdict = classifyBrainAction({ kind: 'bash', command }, brainCtx)
      expect(verdict, command).toEqual({ classification: classifyBrainBash(command, brainCtx) })
    }
  })

  it('always refuses edits and permission requests, and what it has no rule for', () => {
    expect(
      classifyBrainAction({ kind: 'edit', tool: 'Edit', paths: [join(tempArea, 'a')] }, brainCtx)
    ).toEqual({
      refuse: expect.stringContaining('The brain cannot use Edit') as unknown as string
    })
    expect(classifyBrainAction({ kind: 'permission', reason: 'x' }, brainCtx).refuse).toBeDefined()
    expect(
      classifyBrainAction({ kind: 'other', tool: 'WebFetch', input: {} }, brainCtx).refuse
    ).toContain('The brain cannot use WebFetch')
    expect(classifyBrainAction({ kind: 'bash', command: null }, brainCtx).refuse).toBe(
      'The command could not be read.'
    )
  })

  it('asks the user about an MCP tool that is not known to be read-only', () => {
    const verdict = classifyBrainAction(
      { kind: 'mcp', server: 'figma', tool: 'set', readOnly: 'unknown' },
      brainCtx
    )
    expect(verdict.refuse).toBeUndefined()
    expect(verdict).toMatchObject({ classification: { category: 'mcp_write' } })
  })
})

describe('normalizeClaudeCall and toStoredCall', () => {
  it('keeps a Claude call in its own shape', () => {
    expect(toStoredCall(normalizeClaudeCall('Bash', { command: 'git push' }))).toEqual({
      toolName: 'Bash',
      input: { command: 'git push' }
    })
    expect(toStoredCall(normalizeClaudeCall('Edit', { file_path: '/a/b.ts' }))).toEqual({
      toolName: 'Edit',
      input: { file_path: '/a/b.ts' }
    })
    expect(
      toStoredCall(normalizeClaudeCall('NotebookEdit', { notebook_path: '/a/n.ipynb' }))
    ).toEqual({ toolName: 'NotebookEdit', input: { notebook_path: '/a/n.ipynb' } })
    expect(toStoredCall(normalizeClaudeCall('WebFetch', { url: 'u' }))).toEqual({
      toolName: 'WebFetch',
      input: { url: 'u' }
    })
  })

  it('stores Codex actions under Claude-shaped names', () => {
    expect(toStoredCall({ kind: 'bash', command: 'git push', cwd: '/w' })).toEqual({
      toolName: 'Bash',
      input: { command: 'git push', cwd: '/w' }
    })
    expect(toStoredCall({ kind: 'edit', tool: 'Edit', paths: ['/w/a.ts', '/w/b.ts'] })).toEqual({
      toolName: 'Edit',
      input: { file_path: '/w/a.ts', paths: ['/w/a.ts', '/w/b.ts'] }
    })
    expect(
      toStoredCall({
        kind: 'mcp',
        server: 'figma',
        tool: 'get_file',
        args: { id: 1 },
        readOnly: 'no'
      })
    ).toEqual({ toolName: 'mcp__figma__get_file', input: { id: 1 } })
    expect(
      toStoredCall({
        kind: 'permission',
        reason: 'r',
        fileSystem: { write: ['/opt'] },
        network: true
      })
    ).toEqual({
      toolName: 'CodexPermissions',
      input: { reason: 'r', fileSystem: { write: ['/opt'] }, network: true }
    })
  })
})
