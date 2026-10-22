import { describe, expect, it } from 'vitest'
import {
  resolveWorkerTarget,
  standInFor,
  type FallbackReason,
  type ModelCatalog,
  type TargetSource,
  type WorkerTargetInput
} from '../../../src/main/models/provider-resolution'
import type {
  ModelRef,
  ModelTier,
  ProviderState,
  ProviderStatusMap,
  WorkersPref
} from '../../../src/shared/types/provider'

const claude = (model: string): ModelRef => ({ provider: 'claude', model })
const codex = (model: string): ModelRef => ({ provider: 'codex', model })

const CODEX_MODELS: Record<string, ModelTier> = {
  'gpt-deep': 'balanced',
  'gpt-astra': 'deep',
  'gpt-luna': 'fast'
}

/** A catalog like the registry's while Codex is ok: three Claude aliases, a learned full id, three Codex models. */
const catalog: ModelCatalog = {
  has: (ref) =>
    ref.provider === 'claude'
      ? ['opus', 'sonnet', 'haiku', 'claude-opus-5-1'].includes(ref.model.toLowerCase()) ||
        ref.model === 'claude-opus-5-1'
      : ref.model in CODEX_MODELS,
  defaultFor: (provider) => (provider === 'claude' ? claude('sonnet') : codex('gpt-deep')),
  tierOf: (ref) => (ref.provider === 'codex' ? (CODEX_MODELS[ref.model] ?? 'deep') : 'balanced')
}

/** Codex is up but lists nothing (the probe failed and nothing was cached). */
const emptyCodexCatalog: ModelCatalog = {
  ...catalog,
  has: (ref) => ref.provider === 'claude' && catalog.has(ref),
  defaultFor: (provider) => (provider === 'claude' ? claude('sonnet') : undefined)
}

function status(state: ProviderState | undefined): ProviderStatusMap {
  return state === undefined
    ? {}
    : { codex: { provider: 'codex', state, message: '', checkedAt: 1 } }
}

const auto: WorkersPref = { mode: 'auto' }
const pinProvider = (provider: 'claude' | 'codex'): WorkersPref => ({ mode: 'provider', provider })
const pinModel = (model: ModelRef): WorkersPref => ({ mode: 'model', model })

type Picks = Partial<Pick<WorkerTargetInput, 'command' | 'planChoice' | 'proposal'>>

function resolve(
  sessionPref: WorkersPref,
  picks: Picks = {},
  options: { codex?: ProviderState | undefined; registry?: ModelCatalog } = {}
): ReturnType<typeof resolveWorkerTarget> {
  return resolveWorkerTarget({
    sessionPref,
    ...picks,
    registry: options.registry ?? catalog,
    status: status('codex' in options ? options.codex : 'ok')
  })
}

interface Row {
  name: string
  pref: WorkersPref
  picks?: Picks
  ref: ModelRef
  source: TargetSource
  /** Fragments the joined notes must contain; empty means no notes at all. */
  notes?: (string | RegExp)[]
}

const matrix: Row[] = [
  // ---- Auto: the plan card, then the brain, then Claude ----
  {
    name: 'auto with no picks is Claude sonnet',
    pref: auto,
    ref: claude('sonnet'),
    source: 'default'
  },
  {
    name: 'auto: the brain proposes a Claude model',
    pref: auto,
    picks: { proposal: { provider: 'claude', model: 'haiku' } },
    ref: claude('haiku'),
    source: 'brain'
  },
  {
    name: 'auto: the brain proposes Codex with a model',
    pref: auto,
    picks: { proposal: { provider: 'codex', model: 'gpt-luna' } },
    ref: codex('gpt-luna'),
    source: 'brain'
  },
  {
    name: 'auto: the brain proposes Codex without a model, so the Codex default runs',
    pref: auto,
    picks: { proposal: { provider: 'codex' } },
    ref: codex('gpt-deep'),
    source: 'brain'
  },
  {
    name: 'auto: the plan card provider beats the brain provider',
    pref: auto,
    picks: {
      planChoice: { provider: 'codex', model: 'gpt-astra' },
      proposal: { provider: 'claude', model: 'haiku' }
    },
    ref: codex('gpt-astra'),
    source: 'plan'
  },
  {
    name: 'auto: the plan card chose Claude over a Codex proposal',
    pref: auto,
    picks: {
      planChoice: { provider: 'claude', model: 'opus' },
      proposal: { provider: 'codex', model: 'gpt-luna' }
    },
    ref: claude('opus'),
    source: 'plan'
  },
  {
    name: 'auto: a plan model with no provider joins the brain provider',
    pref: auto,
    picks: {
      planChoice: { model: 'gpt-astra' },
      proposal: { provider: 'codex', model: 'gpt-luna' }
    },
    ref: codex('gpt-astra'),
    source: 'plan'
  },
  {
    name: 'auto: the plan model that belongs to another provider is skipped for the brain model',
    pref: auto,
    picks: {
      planChoice: { provider: 'claude', model: 'opus' },
      proposal: { provider: 'claude', model: 'haiku' }
    },
    ref: claude('opus'),
    source: 'plan'
  },
  {
    name: 'auto: the plan card names only a provider, so the brain model of that provider runs',
    pref: auto,
    picks: {
      planChoice: { provider: 'codex' },
      proposal: { provider: 'codex', model: 'gpt-luna' }
    },
    ref: codex('gpt-luna'),
    source: 'brain'
  },
  {
    name: 'auto: the brain model of another provider is dropped when the plan card chose a provider',
    pref: auto,
    picks: {
      planChoice: { provider: 'codex' },
      proposal: { provider: 'claude', model: 'haiku' }
    },
    ref: codex('gpt-deep'),
    source: 'plan'
  },

  // ---- Workers pinned to a provider ----
  {
    name: 'a pinned provider beats the brain proposal of another provider',
    pref: pinProvider('codex'),
    picks: { proposal: { provider: 'claude', model: 'haiku' } },
    ref: codex('gpt-deep'),
    source: 'session',
    notes: ['Workers is set to Codex, so this worker uses a Codex model.']
  },
  {
    name: 'a pinned Claude provider beats a Codex proposal',
    pref: pinProvider('claude'),
    picks: { proposal: { provider: 'codex', model: 'gpt-luna' } },
    ref: claude('sonnet'),
    source: 'session',
    notes: ['Workers is set to Claude, so this worker uses a Claude model.']
  },
  {
    name: 'a pinned provider beats the plan card provider',
    pref: pinProvider('claude'),
    picks: { planChoice: { provider: 'codex', model: 'gpt-astra' } },
    ref: claude('sonnet'),
    source: 'session',
    notes: ['Workers is set to Claude']
  },
  {
    name: 'a pinned provider still takes the brain model of that provider',
    pref: pinProvider('codex'),
    picks: { proposal: { provider: 'codex', model: 'gpt-luna' } },
    ref: codex('gpt-luna'),
    source: 'brain'
  },
  {
    name: 'a pinned provider takes the plan card model of that provider',
    pref: pinProvider('claude'),
    picks: {
      planChoice: { provider: 'claude', model: 'opus' },
      proposal: { provider: 'claude', model: 'haiku' }
    },
    ref: claude('opus'),
    source: 'plan'
  },

  // ---- Workers pinned to one model ----
  {
    name: 'a pinned Claude model beats everything',
    pref: pinModel(claude('haiku')),
    picks: {
      planChoice: { provider: 'claude', model: 'opus' },
      proposal: { provider: 'claude', model: 'sonnet' }
    },
    ref: claude('haiku'),
    source: 'session'
  },
  {
    name: 'a pinned Claude model beats a Codex plan choice, with a note',
    pref: pinModel(claude('haiku')),
    picks: { planChoice: { provider: 'codex', model: 'gpt-astra' } },
    ref: claude('haiku'),
    source: 'session',
    notes: ['Workers is set to Claude · Haiku, so this worker uses it instead of Codex.']
  },
  {
    name: 'a pinned Codex model beats a Claude proposal',
    pref: pinModel(codex('gpt-luna')),
    picks: { proposal: { provider: 'claude', model: 'opus' } },
    ref: codex('gpt-luna'),
    source: 'session',
    notes: ['Workers is set to Codex · gpt-luna']
  },
  {
    name: 'a pinned Codex model beats another Codex model from the plan card (no note: same provider)',
    pref: pinModel(codex('gpt-luna')),
    picks: { planChoice: { provider: 'codex', model: 'gpt-astra' } },
    ref: codex('gpt-luna'),
    source: 'session'
  },

  // ---- a command forces its provider ----
  {
    name: 'a Claude command beats a pinned Codex provider',
    pref: pinProvider('codex'),
    picks: {
      command: { provider: 'claude', name: '/awos:spec' },
      proposal: { provider: 'codex', model: 'gpt-luna' }
    },
    ref: claude('sonnet'),
    source: 'command',
    notes: ['/awos:spec is a Claude Code command, so this worker runs on Claude.']
  },
  {
    name: 'a Codex command beats a pinned Claude model, which is dropped',
    pref: pinModel(claude('opus')),
    picks: { command: { provider: 'codex', name: '/review' } },
    ref: codex('gpt-deep'),
    source: 'command'
  },
  {
    name: 'a command takes the brain model of its own provider',
    pref: auto,
    picks: {
      command: { provider: 'codex' },
      proposal: { provider: 'codex', model: 'gpt-astra' }
    },
    ref: codex('gpt-astra'),
    source: 'brain'
  },
  {
    name: 'a command without a name still explains the override',
    pref: auto,
    picks: { command: { provider: 'claude' }, proposal: { provider: 'codex' } },
    ref: claude('sonnet'),
    source: 'command',
    notes: ['The command is a Claude Code command']
  },

  // ---- models that do not exist ----
  {
    name: 'an unknown brain model gives the default with a note',
    pref: auto,
    picks: { proposal: { provider: 'claude', model: 'claude-fake' } },
    ref: claude('sonnet'),
    source: 'default',
    notes: ['Unknown model "claude-fake" (brain); used sonnet instead.']
  },
  {
    name: 'an unknown plan model falls to the default, not to the next value',
    pref: auto,
    picks: {
      planChoice: { provider: 'claude', model: 'gpt-9' },
      proposal: { provider: 'claude', model: 'haiku' }
    },
    ref: claude('sonnet'),
    source: 'default',
    notes: ['Unknown model "gpt-9" (plan)']
  },
  {
    name: 'an unknown pinned model falls to the default',
    pref: pinModel(claude('llama')),
    picks: { planChoice: { provider: 'claude', model: 'opus' } },
    ref: claude('sonnet'),
    source: 'default',
    notes: ['Unknown model "llama" (session)']
  },
  {
    name: 'an unknown Codex model gives the Codex default',
    pref: auto,
    picks: { proposal: { provider: 'codex', model: 'gpt-nope' } },
    ref: codex('gpt-deep'),
    source: 'default',
    notes: ['Unknown model "gpt-nope" (brain); used gpt-deep instead.']
  },
  {
    name: 'a Claude alias in capitals is accepted',
    pref: auto,
    picks: { planChoice: { provider: 'claude', model: 'Opus' } },
    ref: claude('opus'),
    source: 'plan'
  },
  {
    name: 'a full Claude id that an agent reported is accepted as given',
    pref: auto,
    picks: { proposal: { provider: 'claude', model: 'claude-opus-5-1' } },
    ref: claude('claude-opus-5-1'),
    source: 'brain'
  },
  {
    name: 'blank values count as unset',
    pref: auto,
    picks: { planChoice: { model: '  ' }, proposal: { model: '' } },
    ref: claude('sonnet'),
    source: 'default'
  }
]

describe('resolveWorkerTarget: the resolution matrix (Codex is ok)', () => {
  it.each(matrix)('$name', (row) => {
    const result = resolve(row.pref, row.picks)
    expect(result.ref).toEqual(row.ref)
    expect(result.source).toBe(row.source)
    expect(result.fallback).toBeUndefined()
    const text = result.notes.join('\n')
    if (row.notes === undefined) expect(result.notes).toEqual([])
    else for (const fragment of row.notes) expect(text).toMatch(fragment)
  })
})

describe('resolveWorkerTarget: availability', () => {
  const reasons: [ProviderState | undefined, FallbackReason, RegExp][] = [
    ['missing', 'missing', /Codex isn't installed/],
    ['signed_out', 'signed_out', /Codex isn't signed in/],
    ['unsupported', 'unsupported', /Codex is too old/],
    ['error', 'error', /Codex isn't available right now/],
    [undefined, 'error', /Codex isn't available right now/]
  ]

  it.each(reasons)('Codex %s: the worker runs on Claude and says why', (state, reason, text) => {
    const result = resolve(pinProvider('codex'), {}, { codex: state })
    expect(result.ref).toEqual(claude('sonnet'))
    expect(result.fallback).toEqual({ from: codex('gpt-deep'), reason })
    expect(result.notes.join(' ')).toMatch(text)
    expect(result.notes.join(' ')).toContain('this worker runs on Claude · Sonnet')
  })

  it('a fast Codex model is stood in for by haiku, any other by sonnet', () => {
    const fast = resolve(
      auto,
      { proposal: { provider: 'codex', model: 'gpt-luna' } },
      { codex: 'signed_out' }
    )
    expect(fast.ref).toEqual(claude('haiku'))
    expect(fast.fallback?.from).toEqual(codex('gpt-luna'))
    const deep = resolve(
      auto,
      { proposal: { provider: 'codex', model: 'gpt-astra' } },
      { codex: 'signed_out' }
    )
    expect(deep.ref).toEqual(claude('sonnet'))
  })

  it('a pinned Codex model is not checked against the empty list while Codex is down', () => {
    const result = resolve(pinModel(codex('gpt-luna')), {}, { codex: 'signed_out' })
    expect(result.notes.join(' ')).not.toMatch(/Unknown model/)
    expect(result.ref).toEqual(claude('haiku'))
    expect(result.fallback).toMatchObject({ from: codex('gpt-luna'), reason: 'signed_out' })
  })

  it('Codex is ok but lists no model: Claude runs', () => {
    const result = resolve(pinProvider('codex'), {}, { codex: 'ok', registry: emptyCodexCatalog })
    expect(result.ref).toEqual(claude('sonnet'))
    expect(result.fallback?.reason).toBe('error')
  })

  it('a Codex command cannot fall back: no Claude stand-in, the target is blocked', () => {
    const result = resolve(
      auto,
      { command: { provider: 'codex', name: '/review' } },
      { codex: 'missing' }
    )
    expect(result.fallback).toBeUndefined()
    expect(result.ref.provider).toBe('codex')
    expect(result.source).toBe('command')
    expect(result.blocked).toEqual({
      from: result.ref,
      reason: 'missing',
      command: '/review'
    })
    expect(result.notes.join(' ')).toContain('/review needs Codex')
  })

  it('a Codex command with Codex ok is not blocked', () => {
    const result = resolve(auto, { command: { provider: 'codex', name: '/review' } })
    expect(result.blocked).toBeUndefined()
    expect(result.ref.provider).toBe('codex')
  })

  it('Claude is never subject to the Codex check', () => {
    const result = resolve(auto, {}, { codex: undefined })
    expect(result).toEqual({ ref: claude('sonnet'), source: 'default', notes: [] })
  })
})

describe('resolveWorkerTarget: the fallback chain for Cursor (tech spec 2.8)', () => {
  const cursor = (model: string): ModelRef => ({ provider: 'cursor', model })

  /** Cursor lists Auto and a fast model; Codex lists its three. */
  const threeCatalog: ModelCatalog = {
    has: (ref) =>
      ref.provider === 'cursor' ? ['default[]', 'haiku-c'].includes(ref.model) : catalog.has(ref),
    defaultFor: (provider) =>
      provider === 'cursor' ? cursor('default[]') : catalog.defaultFor(provider),
    fastFor: (provider) =>
      provider === 'cursor'
        ? cursor('haiku-c')
        : provider === 'codex'
          ? codex('gpt-luna')
          : undefined,
    tierOf: (ref) =>
      ref.provider === 'cursor'
        ? ref.model === 'haiku-c'
          ? 'fast'
          : 'balanced'
        : catalog.tierOf(ref)
  }

  function states(
    cursorState: ProviderState | undefined,
    others: { claude?: ProviderState; codex?: ProviderState } = { codex: 'ok' }
  ): ProviderStatusMap {
    const map: ProviderStatusMap = {}
    if (cursorState !== undefined) {
      map.cursor = { provider: 'cursor', state: cursorState, message: '', checkedAt: 1 }
    }
    if (others.codex !== undefined) {
      map.codex = { provider: 'codex', state: others.codex, message: '', checkedAt: 1 }
    }
    if (others.claude !== undefined) {
      map.claude = { provider: 'claude', state: others.claude, message: '', checkedAt: 1 }
    }
    return map
  }

  const pinCursor: WorkersPref = { mode: 'provider', provider: 'cursor' }

  it.each([
    ['missing', "Cursor isn't installed"],
    ['signed_out', "Cursor isn't signed in"],
    ['unsupported', 'Cursor is too old'],
    ['error', "Cursor isn't available right now"]
  ] as const)('Cursor %s: Claude stands in and the fallback names Cursor', (state, text) => {
    const result = resolveWorkerTarget({
      sessionPref: pinCursor,
      registry: threeCatalog,
      status: states(state)
    })
    expect(result.ref).toEqual(claude('sonnet'))
    expect(result.fallback).toEqual({ from: cursor('default[]'), reason: state })
    expect(result.notes.join(' ')).toContain(text)
    expect(result.notes.join(' ')).toContain('runs on Claude')
  })

  it('Cursor with no status at all counts as unavailable', () => {
    const result = resolveWorkerTarget({
      sessionPref: pinCursor,
      registry: threeCatalog,
      status: states(undefined)
    })
    expect(result.fallback).toMatchObject({ reason: 'error' })
    expect(result.ref.provider).toBe('claude')
  })

  it('Cursor at its limit while ok: Claude stands in with the limit reason', () => {
    const result = resolveWorkerTarget({
      sessionPref: pinCursor,
      registry: threeCatalog,
      status: states('ok'),
      limited: new Set(['cursor'])
    })
    expect(result.ref).toEqual(claude('sonnet'))
    expect(result.fallback).toEqual({ from: cursor('default[]'), reason: 'limit' })
    expect(result.notes.join(' ')).toContain('Cursor has reached its usage limit')
  })

  it('a fast Cursor model is stood in for by haiku', () => {
    const result = resolveWorkerTarget({
      sessionPref: { mode: 'model', model: cursor('haiku-c') },
      registry: threeCatalog,
      status: states('missing')
    })
    expect(result.ref).toEqual(claude('haiku'))
    expect(result.fallback?.from).toEqual(cursor('haiku-c'))
  })

  it('Claude also unavailable: Codex stands in with its default', () => {
    const result = resolveWorkerTarget({
      sessionPref: pinCursor,
      registry: threeCatalog,
      status: states('signed_out', { claude: 'signed_out', codex: 'ok' })
    })
    expect(result.ref).toEqual(codex('gpt-deep'))
    expect(result.fallback).toEqual({ from: cursor('default[]'), reason: 'signed_out' })
    expect(result.notes.join(' ')).toContain('runs on Codex')
  })

  it('Codex stands in with its fast model for a fast Cursor model', () => {
    expect(
      standInFor(
        'cursor',
        'fast',
        threeCatalog,
        states('missing', { claude: 'error', codex: 'ok' })
      )
    ).toEqual(codex('gpt-luna'))
  })

  it('Codex at its limit is skipped; with nothing ready Claude stands in as the last resort', () => {
    const status = states('missing', { claude: 'error', codex: 'ok' })
    expect(standInFor('cursor', 'balanced', threeCatalog, status, new Set(['codex']))).toEqual(
      claude('sonnet')
    )
    expect(
      standInFor(
        'cursor',
        'balanced',
        threeCatalog,
        states('missing', { claude: 'error', codex: 'error' })
      )
    ).toEqual(claude('sonnet'))
  })

  it('a Codex worker stands in on Claude, then Cursor when Claude is down', () => {
    const base = states('ok', { claude: 'ok', codex: 'signed_out' })
    expect(standInFor('codex', 'balanced', threeCatalog, base)).toEqual(claude('sonnet'))
    const noClaude = states('ok', { claude: 'error', codex: 'signed_out' })
    expect(standInFor('codex', 'balanced', threeCatalog, noClaude)).toEqual(cursor('default[]'))
  })

  it('a Cursor command cannot fall back: it is blocked with Cursor as the target', () => {
    const result = resolveWorkerTarget({
      sessionPref: auto,
      command: { provider: 'cursor', name: '/review' },
      registry: threeCatalog,
      status: states('signed_out')
    })
    expect(result.fallback).toBeUndefined()
    expect(result.ref.provider).toBe('cursor')
    expect(result.blocked).toMatchObject({ reason: 'signed_out', command: '/review' })
    expect(result.notes.join(' ')).toContain("/review needs Cursor, and Cursor isn't signed in.")
  })

  it('Cursor ok and within its limit runs on Cursor', () => {
    const result = resolveWorkerTarget({
      sessionPref: pinCursor,
      registry: threeCatalog,
      status: states('ok'),
      limited: new Set(['codex'])
    })
    expect(result.ref).toEqual(cursor('default[]'))
    expect(result.fallback).toBeUndefined()
  })
})
