import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTECTED_PREFIXES } from '../../../../src/main/agents/codex/codex-rules'
import {
  describePrefix,
  isCoveredByArcRules,
  parseRulesFile,
  readUserAllowRules
} from '../../../../src/main/agents/codex/codex-user-rules'
import { useTempDir } from '../../helpers/temp-dir'

const dir = useTempDir('arc-codex-user-rules-')

describe('parseRulesFile', () => {
  it('reads prefix_rule calls, with comments, lists of alternatives and any layout', () => {
    const entries = parseRulesFile(`
# a comment with prefix_rule(pattern=["rm"], decision="allow") inside
prefix_rule(pattern=["git", "push"], decision="allow")
prefix_rule(
  pattern = [["npm", "pnpm"], 'run', "build"],  # trailing comma, single quotes
  decision = "prompt",
  justification = "decision = \\"allow\\" is only text here",
)
define_something(1)
prefix_rule(pattern=["node", "-e", "console.log(\\"a, b)\\")"], decision="allow")
prefix_rule(pattern=[], decision="allow")
prefix_rule(decision="allow")
`)
    expect(entries).toEqual([
      { pattern: ['git', 'push'], decision: 'allow' },
      { pattern: [['npm', 'pnpm'], 'run', 'build'], decision: 'prompt' },
      { pattern: ['node', '-e', 'console.log("a, b)")'], decision: 'allow' }
    ])
  })

  it('treats a missing decision as allow, like Codex', () => {
    expect(parseRulesFile('prefix_rule(pattern=["ls"])')).toEqual([
      { pattern: ['ls'], decision: 'allow' }
    ])
  })
})

describe('isCoveredByArcRules', () => {
  it.each([
    [['git', 'push']],
    [['git', 'push', 'origin']],
    [['curl']],
    [['curl', '-L']],
    [['rm', '-rf']],
    [['gh', 'pr', 'create']],
    [[['ssh', 'scp']]],
    [['pnpm', 'add', '-g']]
  ])('%j is covered: Arc makes Codex ask again', (pattern) => {
    expect(isCoveredByArcRules(pattern)).toBe(true)
  })

  it.each([
    [['git', 'commit']],
    [['git', 'add']],
    [['cp']],
    [['mkdir', '-p']],
    [['npm', 'install']],
    [['git']],
    [['node', '-e']],
    [[['curl', 'jq']]]
  ])('%j is not covered: it still skips Arc', (pattern) => {
    expect(isCoveredByArcRules(pattern)).toBe(false)
  })

  it('covers every protected prefix itself', () => {
    for (const prefix of PROTECTED_PREFIXES) expect(isCoveredByArcRules(prefix)).toBe(true)
  })
})

describe('describePrefix', () => {
  it('spells plain words and alternatives', () => {
    expect(describePrefix(['git', 'commit'])).toBe('git commit')
    expect(describePrefix([['npm', 'pnpm'], 'run', 'build'])).toBe('npm|pnpm run build')
  })

  it('stops at the first odd or long word, so a script never leaves the rules file', () => {
    expect(describePrefix(['node', '-e', 'import { Client } from "x"; run()'])).toBe('node -e …')
    expect(describePrefix(['a', 'b', 'c', 'd', 'e'])).toBe('a b c d …')
  })
})

describe('readUserAllowRules', () => {
  it('collects the distinct allow prefixes of every .rules file, and nothing else', async () => {
    const home = dir()
    mkdirSync(join(home, 'rules'))
    writeFileSync(
      join(home, 'rules', 'default.rules'),
      'prefix_rule(pattern=["git","push"], decision="allow")\nprefix_rule(pattern=["rm"], decision="prompt")\n'
    )
    writeFileSync(
      join(home, 'rules', 'more.rules'),
      'prefix_rule(pattern=["git","push"], decision="allow")\nprefix_rule(pattern=["ls"], decision="allow")\n'
    )
    writeFileSync(join(home, 'rules', 'notes.txt'), 'prefix_rule(pattern=["x"], decision="allow")')
    expect((await readUserAllowRules(home)).prefixes).toEqual([['git', 'push'], ['ls']])
  })

  it('finds none without a rules folder', async () => {
    expect(await readUserAllowRules(join(dir(), 'missing'))).toEqual({ prefixes: [] })
  })
})
