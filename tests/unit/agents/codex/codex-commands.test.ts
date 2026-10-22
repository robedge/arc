import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexCommands,
  codexHomeOf,
  expandCodexPrompt,
  parsePromptFile,
  readCodexPrompts,
  splitArgs
} from '../../../../src/main/agents/codex/codex-commands'
import type { CodexSkillInfo } from '../../../../src/main/agents/codex/codex-probe'
import type { ProviderState, ProviderStatusMap } from '../../../../src/shared/types/provider'
import { useTempDir } from '../../helpers/temp-dir'

const dir = useTempDir('arc-codex-commands-')

const expand = (body: string, args: string): string => {
  const out = expandCodexPrompt(body, args)
  if (!out.ok) throw new Error(`missing ${out.missing.join(',')}`)
  return out.text
}

describe('expandCodexPrompt', () => {
  it('fills $1..$9 from the positional arguments and leaves a missing one empty', () => {
    expect(expand('a=$1 b=$2 c=$9.', 'one two')).toBe('a=one b=two c=.')
  })

  it('$ARGUMENTS is every positional argument joined by spaces', () => {
    expect(expand('Review: $ARGUMENTS', 'the diff  of "my branch"')).toBe(
      'Review: the diff of my branch'
    )
  })

  it('fills KEY=value placeholders and keeps them out of the positional arguments', () => {
    expect(
      expand(
        'Fix $FILE ($1) per $TICKET_ID. All: $ARGUMENTS',
        'src/a.ts FILE=src/b.ts TICKET_ID=AB-1'
      )
    ).toBe('Fix src/b.ts (src/a.ts) per AB-1. All: src/a.ts')
  })

  it('keeps quoted values together', () => {
    expect(expand('$MSG|$1', 'MSG="fix the bug" "two words"')).toBe('fix the bug|two words')
  })

  it('$$ is a literal dollar sign and is not expanded again', () => {
    expect(expand('cost $$1 and $$ARGUMENTS and $1', 'x')).toBe('cost $1 and $ARGUMENTS and x')
  })

  it('returns the missing required names instead of a half-expanded prompt', () => {
    expect(expandCodexPrompt('Fix $FILE for $TICKET and $FILE', 'FILE=a')).toEqual({
      ok: false,
      missing: ['TICKET']
    })
    expect(expandCodexPrompt('Fix $FILE', '')).toEqual({ ok: false, missing: ['FILE'] })
  })

  it('splits arguments the way a shell does for quotes', () => {
    expect(splitArgs(`a 'b c' "d e"  f=''`)).toEqual(['a', 'b c', 'd e', 'f='])
  })
})

describe('parsePromptFile', () => {
  it('reads description and argument-hint from the front matter and strips it', () => {
    const parsed = parsePromptFile(
      'review',
      '---\ndescription: "Review a branch"\nargument-hint: [BRANCH=<name>]\n---\nLook at $BRANCH\n'
    )
    expect(parsed).toEqual({
      name: 'review',
      description: 'Review a branch',
      argumentHint: '[BRANCH=<name>]',
      body: 'Look at $BRANCH\n'
    })
  })

  it('treats a file without front matter as all body', () => {
    expect(parsePromptFile('plain', 'Just do $1\n')).toEqual({
      name: 'plain',
      description: '',
      body: 'Just do $1\n'
    })
  })
})

describe('readCodexPrompts', () => {
  it('reads only the top-level .md files of $CODEX_HOME/prompts', async () => {
    const home = dir()
    mkdirSync(join(home, 'prompts', 'nested'), { recursive: true })
    writeFileSync(join(home, 'prompts', 'review.md'), '---\ndescription: Review\n---\nbody')
    writeFileSync(join(home, 'prompts', 'notes.txt'), 'not a prompt')
    writeFileSync(join(home, 'prompts', 'nested', 'deep.md'), 'too deep')
    const prompts = await readCodexPrompts(home)
    expect(prompts.map((p) => p.name)).toEqual(['review'])
  })

  it('is empty when there is no prompts folder', async () => {
    expect(await readCodexPrompts(join(dir(), 'missing'))).toEqual([])
  })

  it('uses CODEX_HOME when set and ~/.codex otherwise', () => {
    expect(codexHomeOf({ CODEX_HOME: '/x/codex' })).toBe('/x/codex')
    expect(codexHomeOf({})).toMatch(/\.codex$/)
  })
})

function skill(name: string): CodexSkillInfo {
  return { name, description: `The ${name} skill`, path: `/skills/${name}/SKILL.md`, scope: 'user' }
}

function rig(
  state: ProviderState = 'ok',
  skills: CodexSkillInfo[] = [skill('publish-release')]
): {
  commands: CodexCommands
  listSkills: ReturnType<typeof vi.fn>
  home: string
  clock: { now: number }
  setState: (next: ProviderState) => void
} {
  const home = dir()
  mkdirSync(join(home, 'prompts'), { recursive: true })
  writeFileSync(
    join(home, 'prompts', 'review.md'),
    '---\ndescription: Review a branch\nargument-hint: BRANCH=<name>\n---\nReview $BRANCH. Notes: $ARGUMENTS'
  )
  const listSkills = vi.fn(() => Promise.resolve(skills))
  const clock = { now: 1000 }
  let current = state
  const status = (): ProviderStatusMap => ({
    codex: { provider: 'codex', state: current, message: '', checkedAt: 1 }
  })
  const commands = new CodexCommands({
    skills: { listSkills },
    status,
    codexHome: () => home,
    now: () => clock.now
  })
  return { commands, listSkills, home, clock, setState: (next) => void (current = next) }
}

describe('CodexCommands.list', () => {
  it('lists skills and prompts as codex entries with provider:name ids', async () => {
    const { commands } = rig()
    expect(await commands.list(['/repo'])).toEqual([
      {
        id: 'codex:publish-release',
        name: 'publish-release',
        description: 'The publish-release skill',
        source: 'codex',
        provider: 'codex',
        kind: 'skill'
      },
      {
        id: 'codex:review',
        name: 'review',
        description: 'Review a branch',
        argumentHint: 'BRANCH=<name>',
        source: 'codex',
        provider: 'codex',
        kind: 'prompt'
      }
    ])
  })

  it.each(['signed_out', 'missing', 'unsupported', 'error'] as const)(
    'lists nothing while Codex is %s',
    async (state) => {
      const { commands, listSkills } = rig(state)
      expect(await commands.list(['/repo'])).toEqual([])
      expect(listSkills).not.toHaveBeenCalled()
    }
  )

  it('lists again once Codex is ok', async () => {
    const { commands, setState } = rig('signed_out')
    expect(await commands.list(['/repo'])).toEqual([])
    setState('ok')
    expect((await commands.list(['/repo'])).map((c) => c.id)).toEqual([
      'codex:publish-release',
      'codex:review'
    ])
  })

  it('reuses a list for 60 seconds and reads again after that, on refresh and after invalidate', async () => {
    const { commands, listSkills, clock } = rig()
    await commands.list(['/repo'])
    clock.now += 59_000
    await commands.list(['/repo'])
    expect(listSkills).toHaveBeenCalledTimes(1)
    clock.now += 2_000
    await commands.list(['/repo'])
    expect(listSkills).toHaveBeenCalledTimes(2)
    await commands.list(['/repo'], true)
    expect(listSkills).toHaveBeenCalledTimes(3)
    commands.invalidate()
    await commands.list(['/repo'])
    expect(listSkills).toHaveBeenCalledTimes(4)
  })

  it('lets a skill win over a prompt of the same name and keeps the prompts when skills fail', async () => {
    const same = rig('ok', [skill('review')])
    expect((await same.commands.list(['/r'])).map((c) => `${c.id}:${c.kind}`)).toEqual([
      'codex:review:skill'
    ])
    const failing = rig()
    failing.listSkills.mockRejectedValue(new Error('boom'))
    expect((await failing.commands.list(['/r'])).map((c) => c.id)).toEqual(['codex:review'])
  })
})

describe('CodexCommands.resolve', () => {
  it('runs a skill as a skill input followed by the arguments as text', async () => {
    const { commands } = rig()
    expect(await commands.resolve('publish-release', 'v1.2 now', ['/r'])).toEqual({
      ok: true,
      kind: 'skill',
      input: [
        { type: 'skill', name: 'publish-release', path: '/skills/publish-release/SKILL.md' },
        { type: 'text', text: 'v1.2 now' }
      ]
    })
  })

  it('expands a prompt in Arc and sends it as plain text', async () => {
    const { commands } = rig()
    expect(await commands.resolve('review', 'BRANCH=main look at tests', ['/r'])).toEqual({
      ok: true,
      kind: 'prompt',
      text: 'Review main. Notes: look at tests'
    })
  })

  it('answers command_args_invalid when a required placeholder is missing', async () => {
    const { commands } = rig()
    const run = await commands.resolve('review', 'just words', ['/r'])
    expect(run).toMatchObject({ ok: false, code: 'command_args_invalid' })
    expect(run.ok ? '' : run.message).toContain('BRANCH=value')
  })

  it('answers unknown_command for a name that is neither', async () => {
    const { commands } = rig()
    expect(await commands.resolve('nope', '', ['/r'])).toMatchObject({
      ok: false,
      code: 'unknown_command'
    })
  })

  it('finds a skill by name only while Codex is ok', async () => {
    const { commands, setState } = rig()
    expect((await commands.findSkill('publish-release', ['/r']))?.path).toBe(
      '/skills/publish-release/SKILL.md'
    )
    setState('signed_out')
    expect(await commands.findSkill('publish-release', ['/r'])).toBeUndefined()
  })
})
