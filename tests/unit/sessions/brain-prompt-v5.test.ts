import { describe, expect, it } from 'vitest'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V4,
  PROMPT_UPDATE_NOTE_V5,
  PROMPT_UPDATE_NOTE_V6,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'
import type { ProvidersPromptInput } from '../../../src/main/sessions/brain-providers'
import { providersSection } from '../../../src/main/sessions/brain-providers'
import type {
  ModelInfo,
  ProviderModels,
  ProviderState,
  ProviderStatusMap,
  WorkersPref
} from '../../../src/shared/types/provider'

const claudeModels: ModelInfo[] = [
  { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
  {
    ref: { provider: 'claude', model: 'sonnet' },
    label: 'Sonnet',
    tier: 'balanced',
    isDefault: true
  },
  { ref: { provider: 'claude', model: 'haiku' }, label: 'Haiku', tier: 'fast', isDefault: false }
]
const codexModels: ModelInfo[] = [
  {
    ref: { provider: 'codex', model: 'gpt-deep' },
    label: 'GPT Deep',
    tier: 'deep',
    isDefault: true
  },
  {
    ref: { provider: 'codex', model: 'gpt-luna' },
    label: 'GPT Luna',
    tier: 'fast',
    isDefault: false
  }
]

function input(
  over: {
    state?: ProviderState | undefined
    workers?: WorkersPref
    brain?: ProvidersPromptInput['brain']
  } = {}
): ProvidersPromptInput {
  const state = 'state' in over ? over.state : 'ok'
  const status: ProviderStatusMap =
    state === undefined ? {} : { codex: { provider: 'codex', state, message: '', checkedAt: 1 } }
  const models: ProviderModels = {
    claude: claudeModels,
    codex: state === 'ok' ? codexModels : [],
    cursor: []
  }
  return {
    brain: over.brain ?? { provider: 'claude', model: 'sonnet' },
    workers: over.workers ?? { mode: 'auto' },
    models,
    status
  }
}

const base = {
  groupName: 'G',
  knowledgePath: '/k',
  projects: [],
  workersEnabled: true
}

describe('brain prompt version 5', () => {
  it('has a note for version 5 and the version has not gone down', () => {
    expect(BRAIN_PROMPT_VERSION).toBeGreaterThanOrEqual(5)
  })

  it('has a "Providers and models" block that lists the models of each provider', () => {
    const prompt = buildBrainPrompt({ ...base, providers: input() })
    expect(prompt).toContain('Providers and models:')
    expect(prompt).toContain('You run on Claude · Sonnet.')
    expect(prompt).toContain(
      '- Claude models: opus (deep), sonnet (balanced, default), haiku (fast).'
    )
    expect(prompt).toContain('- Codex models: gpt-deep (deep, default), gpt-luna (fast).')
    expect(prompt).toContain('optional `provider` ("claude", "codex" or "cursor") and `model`')
  })

  it('leaves the block out without workers or without the input', () => {
    expect(buildBrainPrompt({ ...base, workersEnabled: false, providers: input() })).not.toContain(
      'Providers and models:'
    )
    expect(buildBrainPrompt(base)).not.toContain('Providers and models:')
  })

  it('on Auto, defaults to Claude and says when to choose Codex and to say why', () => {
    const block = providersSection(input())
    expect(block).toContain('Workers is on Auto')
    expect(block).toContain('Default to Claude.')
    expect(block).toContain('review')
    expect(block).toContain('second opinion')
    expect(block).toContain('when the user asks for Codex')
    expect(block).toContain('Say which provider you chose and why')
    expect(block).not.toContain('do not set provider')
  })

  it.each([
    ['signed_out', "Codex isn't signed in"],
    ['missing', "Codex isn't installed"],
    ['unsupported', 'Codex is older than 0.162.0, which Arc needs'],
    ['error', "Codex couldn't be checked"],
    [undefined, "Codex hasn't been checked yet"]
  ] as const)('says why Codex is unavailable (%s) and not to choose it', (state, reason) => {
    const block = providersSection(input({ state }))
    expect(block).toContain(`- Codex: unavailable (${reason}). Do not choose it.`)
    expect(block).not.toContain('Codex models:')
    expect(block).toContain('choose Claude for every worker')
    expect(block).not.toContain('Choose Codex for a review')
  })

  it('when Workers is pinned to one model, says not to set provider or model', () => {
    const block = providersSection(
      input({ workers: { mode: 'model', model: { provider: 'codex', model: 'gpt-luna' } } })
    )
    expect(block).toContain('The user pinned Workers to Codex · gpt-luna')
    expect(block).toContain('Do not set provider or model')
    expect(block).not.toContain('Default to Claude.')
  })

  it('when Workers is pinned to a provider, says not to set provider but a model may be set', () => {
    const block = providersSection(input({ workers: { mode: 'provider', provider: 'claude' } }))
    expect(block).toContain('The user set Workers to Claude')
    expect(block).toContain('Do not set provider.')
    expect(block).toContain('You may set model to one of the Claude models above')
    expect(block).not.toContain('Default to Claude.')
  })

  it('names the brain model when the brain runs on Codex', () => {
    const block = providersSection(input({ brain: { provider: 'codex', model: 'gpt-deep' } }))
    expect(block).toContain('You run on Codex · gpt-deep.')
  })
})

describe('provider-specific tool wording', () => {
  it('a Claude brain reads with Read, Grep and Glob and reaches the Arc tools through ToolSearch', () => {
    const prompt = buildBrainPrompt(base)
    expect(prompt).toContain('(Read, Grep, Glob)')
    expect(prompt).toContain('named mcp__arc__<tool>')
    expect(prompt).toContain(
      'select:mcp__arc__propose_plan,mcp__arc__spawn_worker,mcp__arc__message_worker,mcp__arc__get_worker_status,mcp__arc__merge_worker,mcp__arc__sync_worker,mcp__arc__resolve_request,mcp__arc__escalate_to_user,mcp__arc__ask_user'
    )
    expect(prompt).toContain('- You cannot edit files. When something needs edits')
  })

  it('a Codex brain reads with shell commands in a read-only sandbox, and calls the Arc tools by their bare names', () => {
    const prompt = buildBrainPrompt({ ...base, brainProvider: 'codex' })
    expect(prompt).not.toContain('(Read, Grep, Glob)')
    expect(prompt).not.toContain('WebFetch')
    expect(prompt).not.toContain('ToolSearch')
    expect(prompt).not.toContain('mcp__arc__')
    expect(prompt).toContain('with shell commands')
    expect(prompt).toContain('Your sandbox is read-only')
    expect(prompt).toContain('Arc declines every edit')
    expect(prompt).toContain(
      'from the `arc` MCP server: propose_plan, spawn_worker, message_worker, get_worker_status, merge_worker, sync_worker, resolve_request, escalate_to_user, ask_user'
    )
  })

  it('tells a Codex brain where the knowledge folder is when it runs elsewhere', () => {
    const prompt = buildBrainPrompt({
      ...base,
      brainProvider: 'codex',
      knowledgePath: '/users/know',
      workingDir: '/arc/codex-brain/s1'
    })
    expect(prompt).toContain(
      "The group's knowledge folder is /users/know; it is one of your readable folders."
    )
    expect(prompt).toContain('Your working directory is /arc/codex-brain/s1')
  })
})

describe('the one-time upgrade note', () => {
  const section = providersSection(input())

  it('gives a version 4 session the providers note with the current block', () => {
    const note = promptUpdateNote(4, undefined, section)
    // The block comes once, with the version 5 note; the version 6 note after it is short.
    expect(note).toBe(`${PROMPT_UPDATE_NOTE_V5}\n${section}\n\n${PROMPT_UPDATE_NOTE_V6}`)
    expect(note?.match(/Providers and models:/g)).toHaveLength(1)
  })

  it('puts it after the older notes, oldest first', () => {
    const note = promptUpdateNote(3, [], section) ?? ''
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V4)).toBeGreaterThanOrEqual(0)
    expect(note.indexOf(PROMPT_UPDATE_NOTE_V5)).toBeGreaterThan(note.indexOf(PROMPT_UPDATE_NOTE_V4))
  })

  it('is left out for a current session and for a session without workers', () => {
    expect(promptUpdateNote(6, [], section)).toBeUndefined()
    expect(promptUpdateNote(4, undefined, undefined)).toBeUndefined()
  })
})
