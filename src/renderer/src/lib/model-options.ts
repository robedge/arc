import { cursorModelLabel, modelLabel, providerIds, providerName } from '@shared/provider-label'
import type {
  ModelInfo,
  ModelRef,
  ProviderId,
  ProviderModels,
  ProviderStatusMap,
  WorkersPref
} from '@shared/types/provider'

export interface PickerOption {
  value: string
  label: string
}

/** A labelled set of options: an `optgroup` in a Select, a `role="group"` in a HeaderMenu. */
export interface PickerGroup {
  group: string
  options: PickerOption[]
}

export type PickerEntry = PickerOption | PickerGroup

export function isGroup(entry: PickerEntry): entry is PickerGroup {
  return 'group' in entry
}

/** Every option of a flat or grouped list, in order. */
export function flatOptions(entries: readonly PickerEntry[]): PickerOption[] {
  return entries.flatMap((e) => (isGroup(e) ? e.options : [e]))
}

/** Picker values: a model is `<provider>:<model>`, a Workers pick is `auto`, `provider:<id>` or `model:<provider>:<model>`. */
export function encodeRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`
}

export function decodeRef(value: string): ModelRef {
  const at = value.indexOf(':')
  return { provider: value.slice(0, at) as ProviderId, model: value.slice(at + 1) }
}

export function encodeWorkers(pref: WorkersPref): string {
  if (pref.mode === 'auto') return 'auto'
  return pref.mode === 'provider' ? `provider:${pref.provider}` : `model:${encodeRef(pref.model)}`
}

export function decodeWorkers(value: string): WorkersPref {
  if (value === 'auto') return { mode: 'auto' }
  if (value.startsWith('provider:')) {
    return { mode: 'provider', provider: value.slice('provider:'.length) as ProviderId }
  }
  return { mode: 'model', model: decodeRef(value.slice('model:'.length)) }
}

const UNAVAILABLE = ' (unavailable)'

/** Which providers can run now. Claude is always ready; a missing key means not ready. */
export type Readiness = Partial<Record<ProviderId, boolean>>

/** Readiness from the provider statuses: Claude always, the others when their status is `ok`. */
export function readinessOf(statuses: ProviderStatusMap): Readiness {
  const ready: Readiness = { claude: true }
  for (const provider of providerIds) {
    if (provider !== 'claude') ready[provider] = statuses[provider]?.state === 'ok'
  }
  return ready
}

function isReady(ready: Readiness, provider: ProviderId): boolean {
  return provider === 'claude' || ready[provider] === true
}

/** "Sonnet" for Claude (bare), "Codex gpt-5.5" for Codex, "Cursor grok-4.7 · high" for Cursor. */
export function refText(ref: ModelRef, models: ProviderModels): string {
  const known = models[ref.provider]?.find((m) => m.ref.model === ref.model)
  const name = known?.label ?? modelLabel(ref).split(' · ').slice(1).join(' · ')
  return ref.provider === 'claude' ? name : `${providerName(ref.provider)} ${name}`
}

/** The header button text for a Workers pick: "Workers · Auto", "Workers · Codex", "Workers · Cursor grok-4.7 · high". */
export function workersText(pref: WorkersPref, models: ProviderModels, ready: Readiness): string {
  const down = (p: ProviderId): string => (isReady(ready, p) ? '' : UNAVAILABLE)
  if (pref.mode === 'auto') return 'Workers · Auto'
  if (pref.mode === 'provider') {
    return `Workers · ${providerName(pref.provider)}${down(pref.provider)}`
  }
  return `Workers · ${refText(pref.model, models)}${down(pref.model.provider)}`
}

export function brainText(ref: ModelRef, models: ProviderModels, ready: Readiness): string {
  return `Brain · ${refText(ref, models)}${isReady(ready, ref.provider) ? '' : UNAVAILABLE}`
}

// ---- Cursor: base models with their effort variants collapsed ----

/** One variant of a Cursor base model. */
interface CursorVariant {
  model: string
  /** The effort level, or null when the variant sets none. */
  effort: string | null
  fast: boolean
  /** The other parameters (context size, thinking); equal in variants that differ only by effort or fast. */
  rest: string
}

/** A row of the chooser: a base model standing for all its variants. */
export interface CursorRow {
  base: string
  /** "Auto (default)" for the default row, otherwise the base name. */
  label: string
  /** The full model id the row stands for: the current pick when it is one of the row's variants, else the first variant. */
  value: string
  isDefault: boolean
}

export interface CursorGroup {
  group: string
  /** "Cursor · Claude", "Cursor · GPT". */
  title: string
  rows: CursorRow[]
}

function parseVariant(info: ModelInfo): CursorVariant {
  let effort: string | null = null
  let fast = false
  const rest: string[] = []
  for (const part of (info.variant ?? '').split(',')) {
    const [key, value = 'true'] = part.trim().split('=')
    if (key === undefined || key === '') continue
    if (key === 'effort' || key === 'reasoning' || key.endsWith('_effort')) effort = value
    else if (key === 'fast') fast = value === 'true'
    else rest.push(`${key}=${value}`)
  }
  return { model: info.ref.model, effort, fast, rest: rest.sort().join(',') }
}

function baseOf(info: ModelInfo): string {
  return info.base ?? info.label
}

/** "Cursor · Claude"; the maker "GPT/Codex" reads "GPT" and Cursor's own reads "Composer". */
function groupTitle(group: string): string {
  const name = group === 'GPT/Codex' ? 'GPT' : group === 'Cursor' ? 'Composer' : group
  return `Cursor · ${name}`
}

const OTHER_GROUP = 'Other'

/**
 * Cursor's models as chooser rows: one per base model, grouped by maker. The group holding Auto
 * comes first and Auto leads it; elsewhere the account's order is kept. A `current` id that the
 * account no longer offers stays as an "(unavailable)" row.
 */
export function cursorGroups(
  models: readonly ModelInfo[],
  current: string | null = null
): CursorGroup[] {
  const groups = new Map<string, Map<string, { infos: ModelInfo[]; isDefault: boolean }>>()
  for (const info of models) {
    const group = info.group ?? OTHER_GROUP
    const bases = groups.get(group) ?? new Map()
    groups.set(group, bases)
    const base = baseOf(info)
    const row = bases.get(base) ?? { infos: [], isDefault: false }
    bases.set(base, row)
    row.infos.push(info)
    row.isDefault ||= info.isDefault
  }
  const out: CursorGroup[] = []
  for (const [group, bases] of groups) {
    const rows: CursorRow[] = [...bases].map(([base, row]) => {
      const picked = current !== null ? row.infos.find((i) => i.ref.model === current) : undefined
      return {
        base,
        label: row.isDefault ? `${base} (default)` : base,
        value: (picked ?? row.infos[0]!).ref.model,
        isDefault: row.isDefault
      }
    })
    // The default row leads; a stable sort keeps the account's order for the rest.
    rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    out.push({ group, title: groupTitle(group), rows })
  }
  out.sort((a, b) => Number(b.rows[0]?.isDefault ?? false) - Number(a.rows[0]?.isDefault ?? false))
  if (current !== null && !models.some((m) => m.ref.model === current)) {
    const row: CursorRow = {
      base: current,
      label: `${cursorModelLabel(current)}${UNAVAILABLE}`,
      value: current,
      isDefault: false
    }
    const other = out.find((g) => g.group === OTHER_GROUP)
    if (other) other.rows.push(row)
    else out.push({ group: OTHER_GROUP, title: groupTitle(OTHER_GROUP), rows: [row] })
  }
  return out
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABELS: Record<string, string> = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** What the Effort control offers for the picked Cursor model. */
export interface CursorEffort {
  /** Levels the base offers, "Default" first. */
  levels: PickerOption[]
  /** The picked model's level (`default` when it sets none). */
  effort: string
  /** True when the base has fast variants, so the Fast toggle shows. */
  fastOffered: boolean
  fast: boolean
}

function variantsOf(models: readonly ModelInfo[], model: string): CursorVariant[] {
  const info = models.find((m) => m.ref.model === model)
  if (!info) return []
  return models
    .filter(
      (m) => (m.group ?? OTHER_GROUP) === (info.group ?? OTHER_GROUP) && baseOf(m) === baseOf(info)
    )
    .map(parseVariant)
}

/** The Effort control for a picked model, or null when its base has nothing to choose between. */
export function cursorEffort(models: readonly ModelInfo[], model: string): CursorEffort | null {
  const variants = variantsOf(models, model)
  const current = variants.find((v) => v.model === model)
  if (!current) return null
  const found = new Set(variants.map((v) => v.effort ?? 'default'))
  const ordered = [
    'default',
    ...EFFORT_ORDER,
    ...[...found].filter((e) => e !== 'default' && !EFFORT_ORDER.includes(e))
  ]
  const levels = ordered
    .filter((e) => found.has(e))
    .map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1) }))
  const fastOffered = variants.some((v) => v.fast)
  if (levels.length < 2 && !fastOffered) return null
  return { levels, effort: current.effort ?? 'default', fastOffered, fast: current.fast }
}

/**
 * The full model id after changing the picked model's effort and/or fast switch. Prefers a variant
 * with the same other parameters; when the exact combination is not offered, the nearest one.
 */
export function resolveCursorEffort(
  models: readonly ModelInfo[],
  model: string,
  change: { effort?: string; fast?: boolean }
): string {
  const variants = variantsOf(models, model)
  const current = variants.find((v) => v.model === model)
  if (!current) return model
  const effort = change.effort ?? current.effort ?? 'default'
  const fast = change.fast ?? current.fast
  const level = (v: CursorVariant): string => v.effort ?? 'default'
  const sameRest = variants.filter((v) => v.rest === current.rest)
  const tiers: CursorVariant[][] = [
    sameRest.filter((v) => level(v) === effort && v.fast === fast),
    variants.filter((v) => level(v) === effort && v.fast === fast),
    sameRest.filter((v) => level(v) === effort),
    variants.filter((v) => level(v) === effort)
  ]
  return tiers.find((t) => t.length > 0)?.[0]?.model ?? model
}

interface GroupInput {
  models: ProviderModels
  ready: Readiness
  /** The picked model; kept in its group, and flagged when its provider is down or no longer offers it. */
  current: ModelRef | null
  /** False hides Codex models (the header's Brain, until Codex can run a brain). */
  offerCodex: boolean
  /** True shows Cursor's models, grouped by maker; callers pass it when Cursor is ready. */
  offerCursor?: boolean
}

/** Models grouped by provider (Cursor by maker). A current pick that the list lacks stays, flagged "(unavailable)" when its provider is down. */
export function modelGroups({
  models,
  ready,
  current,
  offerCodex,
  offerCursor = false
}: GroupInput): PickerGroup[] {
  const groups: PickerGroup[] = []
  for (const provider of providerIds) {
    if (provider === 'cursor') {
      if (!offerCursor && current?.provider !== 'cursor') continue
      const infos = offerCursor ? models.cursor : []
      const pick = current?.provider === 'cursor' ? current.model : null
      for (const g of cursorGroups(infos, pick)) {
        groups.push({
          group: g.title,
          options: g.rows.map((r) => ({
            value: encodeRef({ provider: 'cursor', model: r.value }),
            label: r.label
          }))
        })
      }
      continue
    }
    const infos: ModelInfo[] = provider === 'codex' && !offerCodex ? [] : models[provider]
    const options = infos.map((m) => ({ value: encodeRef(m.ref), label: m.label }))
    if (current?.provider === provider && !options.some((o) => o.value === encodeRef(current))) {
      const down = provider === 'codex' && !isReady(ready, 'codex')
      options.push({
        value: encodeRef(current),
        label: `${refText(current, models).replace(/^Codex /, '')}${down ? UNAVAILABLE : ''}`
      })
    }
    if (options.length > 0) groups.push({ group: providerName(provider), options })
  }
  return groups
}

/** Auto, Claude, Codex, Cursor, then the models grouped by provider. Codex and Cursor show only when ready or already picked. */
export function workersEntries(
  models: ProviderModels,
  ready: Readiness,
  current: WorkersPref
): PickerEntry[] {
  const entries: PickerEntry[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'provider:claude', label: 'Claude' }
  ]
  for (const provider of ['codex', 'cursor'] as const) {
    const picked = current.mode === 'provider' && current.provider === provider
    if (isReady(ready, provider) || picked) {
      entries.push({
        value: `provider:${provider}`,
        label: `${providerName(provider)}${isReady(ready, provider) ? '' : UNAVAILABLE}`
      })
    }
  }
  // Model values carry the `model:` prefix so they decode as a `WorkersPref`.
  const groups = modelGroups({
    models,
    ready,
    current: current.mode === 'model' ? current.model : null,
    offerCodex: isReady(ready, 'codex'),
    offerCursor: isReady(ready, 'cursor')
  }).map((g) => ({
    ...g,
    options: g.options.map((o) => ({ ...o, value: `model:${o.value}` }))
  }))
  return [...entries, ...groups]
}
