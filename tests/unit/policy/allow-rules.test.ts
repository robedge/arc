import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowRuleMatches,
  allowRuleText,
  deriveAllowRule
} from '../../../src/main/policy/allow-rules'
import {
  classify,
  classifyAction,
  commandPrefix,
  isPublishAction
} from '../../../src/main/policy/classify'
import { toStoredCall } from '../../../src/main/policy/normalized-action'
import type { NormalizedAction } from '../../../src/main/policy/normalized-action'
import type { ClassifyContext } from '../../../src/main/policy/classify'

let base: string
let wt: string
let ctx: ClassifyContext

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'arc-allow-rules-')))
  wt = join(base, 'worktree')
  mkdirSync(wt, { recursive: true })
  ctx = { worktreeRoots: [wt], readOnlyDirs: [], home: '/home/arc-test', tempDirs: [] }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const bashInput = (command: string): Record<string, unknown> => ({ command })

/** Derives the rule for `first`, then says whether it covers `second`. */
function covers(first: string, second: string, tool = 'Bash'): boolean {
  const a = tool === 'Bash' ? bashInput(first) : { file_path: first }
  const b = tool === 'Bash' ? bashInput(second) : { file_path: second }
  const rule = deriveAllowRule(tool, a, classify(tool, a, ctx))
  if (!rule) throw new Error(`no rule for ${first}`)
  return allowRuleMatches(rule, tool, b, classify(tool, b, ctx))
}

describe('commandPrefix', () => {
  it.each([
    ['git push origin main', 'git push'],
    ['git -C sub push --force', 'git push'],
    ['curl -X POST https://example.com -d x', 'curl'],
    ['gh pr create --fill', 'gh pr create'],
    ['npm publish', 'npm publish'],
    ['sudo brew install jq', 'brew install'],
    ['cd src && git push', 'git push'],
    ['git push && curl -d x https://e.com', 'curl && git push'],
    ['FOO=1 mkdir /opt/x', 'mkdir']
  ])('%s -> %s', (command, prefix) => {
    expect(commandPrefix(command)).toBe(prefix)
  })

  it('uses the whole command when Arc cannot read it', () => {
    expect(commandPrefix('bash -c "git push"')).toBe('bash -c "git push"')
  })
})

describe('isPublishAction', () => {
  it.each([
    'git push',
    'git push origin arc/x',
    'git push --force origin main',
    'git -C sub push',
    'cd src && git push',
    'sudo git push',
    'gh pr create --fill',
    'gh pr merge 3',
    'gh pr view 3',
    'glab mr create --fill',
    'glab mr merge 4',
    'gh release create v1',
    'gh issue create -t x',
    'gh api -X POST repos/a/b/issues',
    'gh api repos/a/b/issues -f title=x',
    'bash -c "git push origin main"'
  ])('%s is a publish action', (command) => {
    expect(isPublishAction('Bash', bashInput(command))).toBe(true)
  })

  it.each([
    'git status',
    'git commit -m "x"',
    'curl -X POST https://example.com',
    'npm publish',
    'brew install jq',
    'rm -rf build',
    'gh issue list',
    'gh api repos/a/b/issues'
  ])('%s is not', (command) => {
    expect(isPublishAction('Bash', bashInput(command))).toBe(false)
  })

  it('is false for tools other than Bash', () => {
    expect(isPublishAction('Write', { file_path: '/etc/x' })).toBe(false)
  })
})

describe('allow rules', () => {
  it('derives the category, tool and prefix from the request', () => {
    const input = bashInput('git push -u origin arc/x')
    const rule = deriveAllowRule('Bash', input, classify('Bash', input, ctx))
    expect(rule).toEqual({
      category: 'leaves_machine',
      tool: 'Bash',
      prefix: 'git push',
      folder: null
    })
    expect(allowRuleText(rule!)).toBe('git push')
  })

  it('matches the same command with other arguments', () => {
    expect(covers('git push origin a', 'git push origin b')).toBe(true)
    expect(covers('curl -d x https://a.com', 'curl -d y https://b.com')).toBe(true)
  })

  it('does not match another command, another category or a longer command', () => {
    expect(covers('git push origin a', 'git remote add o u')).toBe(false)
    expect(covers('git push origin a', 'git push --force origin a')).toBe(false)
    expect(covers('git push origin a', 'git push origin a && ssh me@host ls')).toBe(false)
    expect(covers('brew install jq', 'brew install ripgrep')).toBe(true)
    expect(covers('brew install jq', 'brew uninstall jq')).toBe(false)
  })

  it('scopes a change outside the working copy to the target folder and below', () => {
    const input = bashInput('mkdir /opt/app/new')
    const rule = deriveAllowRule('Bash', input, classify('Bash', input, ctx))
    expect(rule).toMatchObject({
      category: 'outside_worktree',
      prefix: 'mkdir',
      folder: '/opt/app'
    })
    expect(allowRuleText(rule!)).toBe('mkdir in /opt/app')
    expect(covers('mkdir /opt/app/new', 'mkdir /opt/app/other')).toBe(true)
    expect(covers('mkdir /opt/app/new', 'mkdir /opt/app/deep/er/dir')).toBe(true)
    expect(covers('mkdir /opt/app/new', 'mkdir /opt/other/new')).toBe(false)
    expect(covers('mkdir /opt/app/new', 'mkdir /opt/application/new')).toBe(false)
    expect(covers('mkdir /opt/app/new', 'touch /opt/app/new')).toBe(false)
  })

  it('does not cover a command that also changes something outside the folder', () => {
    expect(covers('mkdir /opt/app/new', 'mkdir /opt/app/a /var/b')).toBe(false)
  })

  it('works for the file tools', () => {
    expect(covers('/opt/app/a.txt', '/opt/app/sub/b.txt', 'Write')).toBe(true)
    expect(covers('/opt/app/a.txt', '/opt/zzz/b.txt', 'Write')).toBe(false)
    const edit = { file_path: '/opt/app/b.txt' }
    const writeRule = deriveAllowRule(
      'Write',
      { file_path: '/opt/app/a.txt' },
      classify('Write', { file_path: '/opt/app/a.txt' }, ctx)
    )
    expect(allowRuleMatches(writeRule!, 'Edit', edit, classify('Edit', edit, ctx))).toBe(false)
    const input = { file_path: '/opt/app/a.txt' }
    const rule = deriveAllowRule('Write', input, classify('Write', input, ctx))
    expect(allowRuleText(rule!)).toBe('Write in /opt/app')
  })

  it('makes no rule for a request that is too broad or unclassified', () => {
    const root = bashInput('touch /rootfile')
    expect(deriveAllowRule('Bash', root, classify('Bash', root, ctx))).toBeNull()
    const none = bashInput('ls')
    expect(deriveAllowRule('Bash', none, classify('Bash', none, ctx))).toBeNull()
  })
})

describe('MCP tools', () => {
  const mcp = (
    readOnly: 'yes' | 'no' | 'unknown',
    server = 'figma',
    tool = 'set_node'
  ): NormalizedAction => ({
    kind: 'mcp',
    server,
    tool,
    readOnly
  })

  function ruleFor(action: NormalizedAction): ReturnType<typeof deriveAllowRule> {
    const stored = toStoredCall(action)
    return deriveAllowRule(stored.toolName, stored.input, classifyAction(action, ctx))
  }

  function covered(
    rule: NonNullable<ReturnType<typeof deriveAllowRule>>,
    action: NormalizedAction
  ): boolean {
    const stored = toStoredCall(action)
    return allowRuleMatches(rule, stored.toolName, stored.input, classifyAction(action, ctx))
  }

  it('stores the exact mcp__server__tool, with no prefix and no folder', () => {
    const rule = ruleFor(mcp('unknown'))
    expect(rule).toEqual({
      category: 'mcp_write',
      tool: 'mcp__figma__set_node',
      prefix: '',
      folder: null
    })
    expect(rule && allowRuleText(rule)).toBe('mcp__figma__set_node')
  })

  it('never covers another tool of the same server, or the same tool name on another server', () => {
    const rule = ruleFor(mcp('no'))
    if (!rule) throw new Error('no rule')
    expect(covered(rule, mcp('no'))).toBe(true)
    expect(covered(rule, mcp('no', 'figma', 'delete_node'))).toBe(false)
    expect(covered(rule, mcp('no', 'figma', 'set_node_extra'))).toBe(false)
    expect(covered(rule, mcp('no', 'other', 'set_node'))).toBe(false)
  })

  it('refuses to derive a rule for a name that stands for a whole server', () => {
    for (const tool of ['mcp__figma', 'mcp__figma__', 'mcp__figma__*', 'mcp__*']) {
      expect(deriveAllowRule(tool, {}, classifyAction(mcp('no'), ctx))).toBeNull()
    }
  })

  it('never remembers extra access', () => {
    const action: NormalizedAction = { kind: 'permission', reason: 'x', network: true }
    expect(ruleFor(action)).toBeNull()
  })
})
