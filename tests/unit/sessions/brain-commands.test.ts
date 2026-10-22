import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V2,
  PROMPT_UPDATE_NOTE_V3,
  PROMPT_UPDATE_NOTE_V4,
  PROMPT_UPDATE_NOTE_V5,
  PROMPT_UPDATE_NOTE_V6,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'
import type { CommandInfo } from '../../../src/shared/types/commands'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-brain-commands-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const spec: CommandInfo = {
  id: 'claude:' + 'awos:spec',
  provider: 'claude' as const,
  kind: 'command' as const,
  name: 'awos:spec',
  description: 'Write the functional spec',
  source: 'repo:api'
}
const base = { groupName: 'G', knowledgePath: '/k', projects: [], workersEnabled: true }

function many(count: number): CommandInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `claude:c${i}`,
    provider: 'claude' as const,
    kind: 'command' as const,
    name: `c${i}`,
    description: `command ${i}`,
    source: 'user' as const
  }))
}

describe('Commands available block', () => {
  it('lists the commands with their sources and the guidance', () => {
    const prompt = buildBrainPrompt({
      ...base,
      commands: [
        {
          id: 'claude:' + 'user:review',
          provider: 'claude',
          kind: 'command',
          name: 'user:review',
          description: 'Review code',
          source: 'user'
        },
        {
          id: 'claude:' + 'superpowers:brainstorming',
          provider: 'claude' as const,
          kind: 'command' as const,
          name: 'superpowers:brainstorming',
          description: 'Brainstorm',
          source: 'plugin:superpowers'
        },
        spec
      ]
    })
    expect(prompt).toContain('Commands available:')
    expect(prompt).toContain('- /user:review (Claude, yours) – Review code')
    expect(prompt).toContain(
      '- /superpowers:brainstorming (Claude, plugin superpowers) – Brainstorm'
    )
    expect(prompt).toContain('- /awos:spec (Claude, repo api) – Write the functional spec')
    expect(prompt).toContain('use the command: start a worker with spawn_worker(command:')
    expect(prompt).toContain('in Plan-first, list it in the plan with the command')
    expect(prompt).toContain('Name the command and give the reason in one sentence.')
    expect(prompt).toContain('Only use commands from this list.')
  })

  it('lists at most 40 commands and says how many more there are', () => {
    const prompt = buildBrainPrompt({ ...base, commands: many(45) })
    expect(prompt).toContain('- /c39 (')
    expect(prompt).not.toContain('- /c40 (')
    expect(prompt.match(/^- \/c\d+ \(/gm)).toHaveLength(40)
    expect(prompt).toContain('(and 5 more')
  })

  it('clips descriptions to 80 characters', () => {
    const long = 'x'.repeat(200)
    const prompt = buildBrainPrompt({
      ...base,
      commands: [
        {
          id: 'claude:' + 'long',
          provider: 'claude',
          kind: 'command',
          name: 'long',
          description: long,
          source: 'user'
        }
      ]
    })
    const line = prompt.split('\n').find((l) => l.startsWith('- /long'))
    expect(line).toBe(`- /long (Claude, yours) – ${'x'.repeat(79)}…`)
    expect(line?.split(' – ')[1]).toHaveLength(80)
  })

  it('says the list is unavailable, or leaves commands out, or omits the block when workers are off', () => {
    const unavailable = buildBrainPrompt({ ...base, commands: null })
    expect(unavailable).not.toContain('Commands available:')
    expect(unavailable).toContain('command list is not available right now')
    expect(unavailable).toContain('list commands later')
    expect(buildBrainPrompt(base)).not.toContain('Only use commands from this list.')
    expect(buildBrainPrompt(base)).not.toContain('command list is not available')
    const noWorkers = buildBrainPrompt({ ...base, workersEnabled: false, commands: [spec] })
    expect(noWorkers).not.toContain('Commands available:')
  })
})

describe('prompt update note for commands', () => {
  it('is version 6 with Cursor as a third provider', () => {
    expect(BRAIN_PROMPT_VERSION).toBe(6)
  })

  it('gives a version 3 session only the commands note, with the current list', () => {
    const note = promptUpdateNote(3, [spec])
    expect(note).toContain(PROMPT_UPDATE_NOTE_V4)
    expect(note).not.toContain(PROMPT_UPDATE_NOTE_V3)
    expect(note).toContain('- /awos:spec (Claude, repo api) – Write the functional spec')
    expect(note).toContain('Only use commands from this list.')
    expect(promptUpdateNote(4, [spec])).toBeUndefined()
  })

  it('adds the earlier notes for versions 1 and 2, oldest first', () => {
    expect(promptUpdateNote(2, [spec])).toBe(
      `${PROMPT_UPDATE_NOTE_V3}\n\n${promptUpdateNote(3, [spec])}`
    )
    expect(promptUpdateNote(1, [spec])).toBe(
      `${PROMPT_UPDATE_NOTE_V2}\n\n${PROMPT_UPDATE_NOTE_V3}\n\n${promptUpdateNote(3, [spec])}`
    )
  })

  it('says the list arrives later when the catalogue failed, and skips version 4 without workers', () => {
    expect(promptUpdateNote(3, null)).toContain('not available right now')
    expect(promptUpdateNote(3, undefined)).toBeUndefined()
    expect(promptUpdateNote(2, undefined)).toBe(PROMPT_UPDATE_NOTE_V3)
  })
})

function rigWith(commands: CommandInfo[] | Error): Promise<EngineRig> {
  const list = vi.fn<CommandCatalogue['list']>(() =>
    commands instanceof Error ? Promise.reject(commands) : Promise.resolve(commands)
  )
  return makeEngineRig(dir(), { commands: { list } })
}

describe('brain launch', () => {
  it('sends a resumed version 5 Claude session only the version 6 note, once', async () => {
    e = await rigWith([spec])
    const id = await e.startSession('autonomous')
    e.rig.sessionsRepo.setBrainPromptVersion(id, 5)
    await e.rig.service.shutdown()
    await e.rig.service.sendMessage(id, 'and then?')
    await until(() => e!.rig.adapter.starts.length > 1)
    const brain = e.rig.adapter.last
    await until(() => brain.sent.length > 0)
    expect(brain.sent[0]).toContain(PROMPT_UPDATE_NOTE_V6)
    expect(brain.sent[0]).not.toContain(PROMPT_UPDATE_NOTE_V5)
    expect(e.rig.sessionsRepo.getById(id)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
    await e.rig.service.sendMessage(id, 'again')
    await until(() => brain.sent.length > 1)
    expect(brain.sent[1]).toBe('again')
  })

  it('puts the catalogue in the brain prompt when the session has repositories', async () => {
    e = await rigWith([spec])
    await e.startSession('plan_first')
    const prompt = e.rig.adapter.starts[0]?.instructions ?? ''
    expect(prompt).toContain('Commands available:')
    expect(prompt).toContain('- /awos:spec (Claude, repo api) – Write the functional spec')
  })

  it('omits the block, saying the list comes later, when the catalogue fails', async () => {
    e = await rigWith(new Error('probe failed'))
    await e.startSession('plan_first')
    const prompt = e.rig.adapter.starts[0]?.instructions ?? ''
    expect(prompt).not.toContain('Commands available:')
    expect(prompt).toContain('list commands later')
  })

  it('has no block without repositories', async () => {
    e = await rigWith([spec])
    const id = await e.startSession('autonomous')
    expect(e.rig.adapter.starts[0]?.instructions).toContain('Commands available:')
    e.rig.opened.sqlite.prepare("update session_projects set membership = 'removed'").run()
    await e.rig.service.shutdown()
    await e.rig.service.sendMessage(id, 'hello')
    await until(() => e!.rig.adapter.starts.length > 1)
    const prompt = e.rig.adapter.starts[1]?.instructions ?? ''
    expect(prompt).not.toContain('Commands available:')
    expect(prompt).not.toContain('Only use commands from this list.')
    expect(prompt).not.toContain('command list is not available')
  })

  it('sends a resumed version 3 session the commands note once', async () => {
    e = await rigWith([spec])
    const id = await e.startSession('autonomous')
    e.rig.sessionsRepo.setBrainPromptVersion(id, 3)
    await e.rig.service.shutdown()
    await e.rig.service.sendMessage(id, 'and then?')
    await until(() => e!.rig.adapter.starts.length > 1)
    const brain = e.rig.adapter.last
    await until(() => brain.sent.length > 0)
    // A version 3 session is also told about the providers, with the block as the new prompt has it.
    const providers = /Providers and models:[\s\S]*?(?=\n\n)/.exec(
      e.rig.adapter.starts.at(-1)?.instructions ?? ''
    )?.[0]
    expect(providers).toBeDefined()
    expect(brain.sent[0]).toBe(`${promptUpdateNote(3, [spec], providers)}\n\nand then?`)
    expect(brain.sent[0]).toContain(PROMPT_UPDATE_NOTE_V5)
    expect(brain.sent[0]).toContain(PROMPT_UPDATE_NOTE_V6)
    expect(e.rig.sessionsRepo.getById(id)?.brainPromptVersion).toBe(BRAIN_PROMPT_VERSION)
    await e.rig.service.sendMessage(id, 'again')
    await until(() => brain.sent.length > 1)
    expect(brain.sent[1]).toBe('again')
  })
})
