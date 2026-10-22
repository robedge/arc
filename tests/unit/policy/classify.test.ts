import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classify } from '../../../src/main/policy/classify'
import type { ClassifyContext } from '../../../src/main/policy/classify'
import { BASH_CASES, fillCase, type Expected } from './classify-cases'

let base: string
let wt: string
let other: string
let tempArea: string
let ctx: ClassifyContext

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'arc-classify-')))
  wt = join(base, 'worktree')
  other = join(base, 'user-checkout')
  mkdirSync(join(wt, 'src'), { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(wt, 'README.md'), 'x')
  symlinkSync(other, join(wt, 'link-out'))
  // The folder that stands for the system temp folder; the real one holds this whole fixture.
  tempArea = join(base, 'tmp-area')
  mkdirSync(tempArea, { recursive: true })
  symlinkSync('/usr', join(tempArea, 'out'))
  ctx = {
    worktreeRoots: [wt],
    readOnlyDirs: [other],
    home: '/home/arc-test',
    tempDirs: [tempArea]
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const bash = (command: string): ReturnType<typeof classify> => classify('Bash', { command }, ctx)

describe('classify: Bash', () => {
  for (const [command, expected] of BASH_CASES) {
    it(`${JSON.stringify(command)} -> ${expected ?? 'unflagged'}`, () => {
      const text = fillCase(command, { other, tempArea })
      const result = bash(text)
      expect({ category: result.category, mustEscalate: result.mustEscalate }).toEqual({
        category: expected,
        mustEscalate: expected !== null
      })
      if (expected !== null) expect(result.reason).not.toBe('')
    })
  }

  it('has at least 60 cases and covers every category and the false positives', () => {
    expect(BASH_CASES.length).toBeGreaterThanOrEqual(60)
    const seen = new Set(BASH_CASES.map(([, c]) => c))
    for (const c of ['outside_worktree', 'leaves_machine', 'destructive', 'global_install', null]) {
      expect(seen.has(c as Expected)).toBe(true)
    }
  })

  it('says why a push needs the user', () => {
    expect(bash('git push origin arc/fix-order-sync').reason).toBe(
      'Pushing leaves your machine, so this needs you.'
    )
  })

  it('takes the most severe category when a command matches several', () => {
    expect(bash('git push --force origin main && brew install jq').category).toBe('destructive')
    expect(bash('brew install jq && git push origin main').category).toBe('leaves_machine')
    expect(bash('sudo rm -rf build').category).toBe('destructive')
  })

  it('does not flag an empty command', () => {
    expect(bash('').category).toBeNull()
    expect(bash('   \n  ').category).toBeNull()
  })

  it('reads a relative path from the cwd of the request, and follows cd inside one command', () => {
    expect(
      classify('Bash', { command: 'rm ../../x' }, { ...ctx, cwd: join(wt, 'src') }).category
    ).toBe('outside_worktree')
    expect(
      classify('Bash', { command: 'rm ../README.md' }, { ...ctx, cwd: join(wt, 'src') }).category
    ).toBeNull()
    expect(bash('cd src && cp ../README.md ../other.md').category).toBeNull()
    expect(bash('cd src && cp ../README.md ../../other.md').category).toBe('outside_worktree')
  })

  it('checks every working copy of a worker with several', () => {
    const second = join(base, 'worktree-2')
    mkdirSync(second, { recursive: true })
    const both = { ...ctx, worktreeRoots: [wt, second] }
    expect(classify('Bash', { command: `cp README.md ${second}/a.md` }, both).category).toBeNull()
    expect(classify('Bash', { command: `cp README.md ${second}/a.md` }, ctx).category).toBe(
      'outside_worktree'
    )
  })

  it('refuses to read a non-string command', () => {
    expect(classify('Bash', { command: 42 }, ctx).category).toBe('destructive')
    expect(classify('Bash', {}, ctx).category).toBe('destructive')
  })
})

describe('classify: file tools', () => {
  it('allows Edit, Write and NotebookEdit inside the worktree, including a file that does not exist yet', () => {
    expect(classify('Edit', { file_path: join(wt, 'README.md') }, ctx).category).toBeNull()
    expect(classify('Write', { file_path: join(wt, 'src', 'new', 'deep.ts') }, ctx).category).toBe(
      null
    )
    expect(classify('NotebookEdit', { notebook_path: join(wt, 'n.ipynb') }, ctx).category).toBe(
      null
    )
  })

  it('flags paths outside the worktree, the user checkout included', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: join(other, 'src', 'a.ts') }],
      ['Write', { file_path: '/etc/passwd' }],
      ['Write', { file_path: join(wt, '..', 'escape.txt') }],
      ['NotebookEdit', { notebook_path: join(base, 'n.ipynb') }],
      ['MultiEdit', { file_path: join(base, 'x.ts') }]
    ] as const) {
      const result = classify(tool, input, ctx)
      expect({ tool, category: result.category, must: result.mustEscalate }).toEqual({
        tool,
        category: 'outside_worktree',
        must: true
      })
    }
  })

  it('follows symlinks: a link inside the worktree that points outside is outside', () => {
    expect(classify('Write', { file_path: join(wt, 'link-out', 'a.ts') }, ctx).category).toBe(
      'outside_worktree'
    )
  })

  it('treats a sibling directory with the same prefix as outside', () => {
    const sibling = `${wt}-evil`
    expect(classify('Write', { file_path: join(sibling, 'a.ts') }, ctx).category).toBe(
      'outside_worktree'
    )
  })

  it('flags a missing or non-string path instead of guessing', () => {
    expect(classify('Edit', {}, ctx).category).toBe('outside_worktree')
    expect(classify('Write', { file_path: 7 }, ctx).category).toBe('outside_worktree')
  })

  it('does not gate WebFetch or WebSearch: no category, so a worker may use them freely', () => {
    for (const [tool, input] of [
      ['WebFetch', { url: 'https://example.com/docs', prompt: 'summarise' }],
      ['WebSearch', { query: 'electron 44 release notes' }]
    ] as const) {
      expect(classify(tool, input, ctx)).toMatchObject({ category: null, mustEscalate: false })
    }
  })

  it('leaves read-only and unknown tools to the brain', () => {
    expect(classify('Read', { file_path: '/etc/hosts' }, ctx).category).toBeNull()
    expect(classify('Grep', { pattern: 'x' }, ctx).category).toBeNull()
    expect(classify('mcp__other__thing', { a: 1 }, ctx).category).toBeNull()
  })
})

describe('classify: the system temp folder and reads outside', () => {
  it('lets Edit, Write and NotebookEdit change files in the temp folder', () => {
    for (const [tool, input] of [
      ['Write', { file_path: join(tempArea, 'out.txt') }],
      ['Edit', { file_path: join(tempArea, 'deep', 'er', 'a.ts') }],
      ['NotebookEdit', { notebook_path: join(tempArea, 'n.ipynb') }]
    ] as const) {
      expect(classify(tool, input, ctx)).toMatchObject({ category: null, mustEscalate: false })
    }
  })

  it('still flags a write that leaves the temp folder through a symlink or a ..', () => {
    expect(classify('Write', { file_path: join(tempArea, 'out', 'x.txt') }, ctx).category).toBe(
      'outside_worktree'
    )
    expect(classify('Write', { file_path: join(tempArea, '..', 'x.txt') }, ctx).category).toBe(
      'outside_worktree'
    )
  })

  it('does not treat a protected folder inside the temp folder as temp', () => {
    const inTemp = { ...ctx, tempDirs: [base] }
    expect(classify('Write', { file_path: join(other, 'a.ts') }, inTemp).category).toBe(
      'outside_worktree'
    )
    expect(classify('Write', { file_path: join(base, 'free.txt') }, inTemp).category).toBeNull()
  })

  it('knows the real system temp folder, its real path and /tmp by default', () => {
    const real = { worktreeRoots: [wt], readOnlyDirs: [other], home: '/home/arc-test' }
    const write = (file: string): ReturnType<typeof classify> =>
      classify('Bash', { command: `echo hi > ${file}` }, real)
    expect(write(join(tmpdir(), 'arc-default-temp.txt')).category).toBeNull()
    expect(write(join(realpathSync(tmpdir()), 'arc-default-temp.txt')).category).toBeNull()
    expect(write('/tmp/arc-default-temp.txt').category).toBeNull()
    expect(write(join(realpathSync('/tmp'), 'arc-default-temp.txt')).category).toBeNull()
    expect(write('/opt/arc-default-temp.txt').category).toBe('outside_worktree')
    expect(write(join(other, 'a.txt')).category).toBe('outside_worktree')
  })

  it('never flags the read-only tools, whatever path they read', () => {
    for (const [tool, input] of [
      ['Read', { file_path: '/etc/hosts' }],
      ['Grep', { pattern: 'x', path: '/tmp/w1-dl' }],
      ['Glob', { pattern: '**/*.ts', path: '/opt/other' }]
    ] as const) {
      expect(classify(tool, input, ctx)).toMatchObject({ category: null, mustEscalate: false })
    }
  })

  it('reports the real paths an outside change touches', () => {
    expect(bash('cp README.md /opt/app/a.txt && touch /opt/app/b.txt').paths).toEqual([
      '/opt/app/a.txt',
      '/opt/app/b.txt'
    ])
    expect(bash('git push origin main').paths).toEqual([])
  })
})
