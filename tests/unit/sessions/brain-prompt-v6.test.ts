import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig } from './engine-rig'
import type { EngineRig } from './engine-rig'
import {
  BRAIN_PROMPT_VERSION,
  PROMPT_UPDATE_NOTE_V5,
  PROMPT_UPDATE_NOTE_V6,
  buildBrainPrompt,
  promptUpdateNote
} from '../../../src/main/sessions/orchestrator'
import type { ProvidersPromptInput } from '../../../src/main/sessions/brain-providers'
import {
  cursorPromptModels,
  fullestPlanPercent,
  providersSection,
  unavailableReason
} from '../../../src/main/sessions/brain-providers'
import { splitCommandRef } from '../../../src/main/sessions/command-routing'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { resolveWorkerTarget } from '../../../src/main/models/provider-resolution'
import type {
  ModelInfo,
  ProviderState,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import { MIN_CURSOR_VERSION } from '../../../src/shared/types/provider'
import type { ProviderPlan } from '../../../src/shared/types/usage'

function cursorModel(id: string, label: string, base?: string, isDefault = false): ModelInfo {
  return {
    ref: { provider: 'cursor', model: id },
    label,
    tier: 'balanced',
    isDefault,
    ...(base !== undefined ? { base } : {})
  }
}

const claudeModels: ModelInfo[] = [
  {
    ref: { provider: 'claude', model: 'sonnet' },
    label: 'Sonnet',
    tier: 'balanced',
    isDefault: true
  }
]

function input(
  over: {
    cursor?: ProviderState | undefined
    codex?: ProviderState | undefined
    cursorModels?: ModelInfo[]
    claudePlanPercent?: number
  } = {}
): ProvidersPromptInput {
  const status: ProviderStatusMap = {}
  const cursor = 'cursor' in over ? over.cursor : 'ok'
  const codex = 'codex' in over ? over.codex : 'ok'
  if (cursor) status.cursor = { provider: 'cursor', state: cursor, message: '', checkedAt: 1 }
  if (codex) status.codex = { provider: 'codex', state: codex, message: '', checkedAt: 1 }
  return {
    brain: { provider: 'claude', model: 'sonnet' },
    workers: { mode: 'auto' },
    models: {
      claude: claudeModels,
      codex: [],
      cursor: over.cursorModels ?? [
        cursorModel('default[]', 'Auto', undefined, true),
        cursorModel('grok-4.7[fast=true]', 'grok-4.7 · fast', 'grok-4.7')
      ]
    },
    status,
    ...(over.claudePlanPercent !== undefined ? { claudePlanPercent: over.claudePlanPercent } : {})
  }
}

const base = { groupName: 'G', knowledgePath: '/k', projects: [], workersEnabled: true }

describe('brain prompt version 6', () => {
  it('is version 6', () => {
    expect(BRAIN_PROMPT_VERSION).toBe(6)
  })

  it('names three providers and lists the Cursor models as label (id)', () => {
    const prompt = buildBrainPrompt({ ...base, providers: input() })
    expect(prompt).toContain('Workers run on Claude, on Codex (OpenAI) or on Cursor.')
    expect(prompt).toContain('("claude", "codex" or "cursor")')
    expect(prompt).toContain(
      '- Cursor models: Auto (default[]), grok-4.7 · fast (grok-4.7[fast=true])'
    )
  })

  it('lists at most 15 Cursor models, Auto first, one per base model before more variants', () => {
    const models = [cursorModel('default[]', 'Auto', undefined, true)]
    for (let i = 0; i < 12; i++) {
      for (const v of ['low', 'high']) {
        models.push(cursorModel(`m${i}[${v}]`, `m${i} ${v}`, `m${i}`))
      }
    }
    const shown = cursorPromptModels(models)
    expect(shown).toHaveLength(15)
    expect(shown[0]?.label).toBe('Auto')
    // 13 bases fit first (Auto and 12 models); the 2 free places take the first extra variants.
    expect(shown.filter((m) => m.label.endsWith(' low'))).toHaveLength(12)
    const line = providersSection(input({ cursorModels: models }))
      .split('\n')
      .find((l) => l.startsWith('- Cursor models:'))
    expect(line?.match(/\(/g)).toHaveLength(15)
    expect(line).toContain('and 10 more variants')
  })

  it('says Cursor is unavailable and not to choose it', () => {
    const block = providersSection(input({ cursor: 'signed_out' }))
    expect(block).toContain("- Cursor: unavailable (Cursor isn't signed in). Do not choose it.")
    expect(block).not.toContain('Cursor models:')
    expect(block).not.toContain('Choose Cursor when')
  })

  it('on Auto, defaults to Claude and says when to choose Cursor', () => {
    const block = providersSection(input())
    expect(block).toContain('Default to Claude.')
    expect(block).toContain(
      'Choose Cursor when the user asks for it, when the work needs a model only Cursor offers, or when you want a third opinion'
    )
    expect(block).not.toContain('plan meter')
  })

  it("prefers Codex or Cursor when Claude's plan meter is at 80% or more", () => {
    const block = providersSection(input({ claudePlanPercent: 80 }))
    expect(block).toContain(
      "Claude's plan meter is at 80%, so prefer Codex or Cursor for new workers"
    )
    expect(providersSection(input({ claudePlanPercent: 79.4 }))).not.toContain('plan meter')
    expect(providersSection(input({ claudePlanPercent: 92, codex: 'missing' }))).toContain(
      'at 92%, so prefer Cursor for new workers'
    )
  })

  it('does not push the plan branch when neither other provider is available', () => {
    const block = providersSection(
      input({ claudePlanPercent: 95, cursor: 'missing', codex: 'missing' })
    )
    expect(block).not.toContain('plan meter')
    expect(block).toContain(
      'Codex and Cursor are unavailable now, so choose Claude for every worker'
    )
  })

  it('reads the fullest current limit of Claude, ignoring reset windows', () => {
    const limit = (usedPercent: number, stale?: boolean): ProviderPlan['limits'][number] => ({
      provider: 'claude',
      windowId: `w${usedPercent}`,
      label: 'x',
      usedPercent,
      resetsAt: null,
      observedAt: 1,
      source: 'event',
      ...(stale ? { stale } : {})
    })
    const plans: ProviderPlan[] = [
      { provider: 'claude', state: 'ok', limits: [limit(40), limit(85), limit(99, true)] }
    ]
    expect(fullestPlanPercent(plans, 'claude')).toBe(85)
    expect(fullestPlanPercent(plans, 'cursor')).toBeUndefined()
  })
})

describe('unavailableReason per provider', () => {
  const status = (provider: 'codex' | 'cursor', state: ProviderState): ProviderStatusMap => ({
    [provider]: { provider, state, message: '', checkedAt: 1 }
  })

  it.each([
    ['missing', "Cursor isn't installed"],
    ['signed_out', "Cursor isn't signed in"],
    ['unsupported', `Cursor is older than ${MIN_CURSOR_VERSION}, which Arc needs`],
    ['error', "Cursor couldn't be checked"]
  ] as const)('cursor %s', (state, text) => {
    expect(unavailableReason('cursor', status('cursor', state))).toBe(text)
  })

  it('reads the status of the provider asked about, not another', () => {
    expect(unavailableReason('cursor', status('codex', 'ok'))).toBe(
      "Cursor hasn't been checked yet"
    )
    expect(unavailableReason('codex', status('cursor', 'ok'))).toBe("Codex hasn't been checked yet")
    expect(unavailableReason('cursor', status('cursor', 'ok'))).toBeUndefined()
    expect(unavailableReason('claude', {})).toBeUndefined()
  })
})

describe('the version 6 update note', () => {
  const section = providersSection(input())

  it('reads as the task says', () => {
    expect(PROMPT_UPDATE_NOTE_V6).toBe(
      "[Arc] Updated instructions: workers can now also run on Cursor; spawn_worker and propose_plan take provider 'cursor' and a Cursor model id."
    )
  })

  it('gives a version 5 session the note and the current block once', () => {
    expect(promptUpdateNote(5, undefined, section)).toBe(`${PROMPT_UPDATE_NOTE_V6}\n${section}`)
    expect(promptUpdateNote(5, undefined, section)).not.toContain(PROMPT_UPDATE_NOTE_V5)
    expect(promptUpdateNote(6, undefined, section)).toBeUndefined()
    expect(promptUpdateNote(5, undefined, undefined)).toBeUndefined()
  })
})

describe('Cursor commands and model labels', () => {
  it('splitCommandRef accepts cursor:<name> with and without a slash', () => {
    expect(splitCommandRef('cursor:review the diff')).toEqual({
      ref: 'cursor:review',
      slashed: false,
      args: 'the diff'
    })
    expect(splitCommandRef('/cursor:review')?.slashed).toBe(true)
    expect(splitCommandRef('cursorish')).toBeNull()
    expect(splitCommandRef('cursor:')).toBeNull()
  })

  it('resolves a Cursor model by id or by label in any case', async () => {
    const status: ProviderStatusMap = {
      cursor: { provider: 'cursor', state: 'ok', message: '', checkedAt: 1 }
    }
    const registry = new ModelRegistry({
      cursor: {
        listModels: () =>
          Promise.resolve(
            mapCursorModels([
              { modelId: 'default[]', name: 'Auto' },
              { modelId: 'grok-4.7[fast=true]', name: 'grok-4.7' }
            ])
          )
      },
      status: () => status
    })
    await registry.refresh()
    const pick = (model: string): string | undefined =>
      resolveWorkerTarget({
        sessionPref: { mode: 'auto' },
        proposal: { provider: 'cursor', model },
        registry,
        status
      }).ref.model
    expect(pick('grok-4.7[fast=true]')).toBe('grok-4.7[fast=true]')
    expect(pick('GROK-4.7 · FAST')).toBe('grok-4.7[fast=true]')
    expect(pick('auto')).toBe('default[]')
    const unknown = resolveWorkerTarget({
      sessionPref: { mode: 'auto' },
      proposal: { provider: 'cursor', model: 'nope' },
      registry,
      status
    })
    expect(unknown.ref.model).toBe('default[]')
    expect(unknown.notes.join(' ')).toContain('Unknown model "nope"')
  })
})

describe('the plan figure in the launched brain prompt', () => {
  const dir = useTempDir('arc-brain-v6-')
  let e: EngineRig | undefined
  afterEach(async () => {
    await e?.close()
    e = undefined
  })

  async function promptWith(percent: number | undefined): Promise<string> {
    const status: ProviderStatusMap = {
      cursor: { provider: 'cursor', state: 'ok', message: '', checkedAt: 1 }
    }
    const plans: ProviderPlan[] =
      percent === undefined
        ? []
        : [
            {
              provider: 'claude',
              state: 'ok',
              limits: [
                {
                  provider: 'claude',
                  windowId: 'five_hour',
                  label: '5h',
                  usedPercent: percent,
                  resetsAt: null,
                  observedAt: 1,
                  source: 'event'
                }
              ]
            }
          ]
    e = await makeEngineRig(dir(), {
      providers: { get: () => status, ensureFresh: vi.fn(() => Promise.resolve(status.cursor)) },
      planUsage: { ingest: vi.fn(), meters: () => plans }
    })
    await e.startSession('plan_first')
    return e.rig.adapter.starts[0]?.instructions ?? ''
  }

  it('is read when the prompt is built', async () => {
    expect(await promptWith(85)).toContain("Claude's plan meter is at 85%, so prefer Cursor")
  })

  it('stays out below 80%', async () => {
    expect(await promptWith(50)).not.toContain('plan meter')
  })

  it('stays out when Claude has no meter yet', async () => {
    expect(await promptWith(undefined)).not.toContain('plan meter')
  })
})
