/**
 * The body of an A2UI v1.0 `createSurface` as Arc stores and draws it. A surface is a
 * flat list of components that refer to each other by id, plus a data model the components bind to
 * with `{"@path": "/json/pointer"}`. The main process checks the components against Arc's catalog
 * when it compiles them (`main/surface/express.ts`); this file only checks the shape.
 */
import { z } from 'zod'

const id = z.string().min(1).max(120)

export const surfaceNodeSchema = z.looseObject({ id, component: z.string().min(1).max(40) })

export const surfaceSchema = z.object({
  surfaceId: id,
  components: z.array(surfaceNodeSchema).min(1).max(300),
  dataModel: z.record(z.string(), z.unknown()).optional()
})

export type SurfaceNode = z.infer<typeof surfaceNodeSchema>
export type Surface = z.infer<typeof surfaceSchema>

/** `{"@path": "/a/b"}`: a binding into the data model. */
export function pathOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const path = (value as Record<string, unknown>)['@path']
  return typeof path === 'string' ? path : null
}

/** The ids a component points at. */
export function childIds(node: SurfaceNode): string[] {
  const ids: string[] = []
  if (typeof node['child'] === 'string') ids.push(node['child'])
  if (Array.isArray(node['children'])) {
    for (const child of node['children']) if (typeof child === 'string') ids.push(child)
  }
  return ids
}

/** Unique ids, one `root`, no dangling references, no cycles. Null when sound. */
export function surfaceProblem(surface: Surface): string | null {
  const byId = new Map<string, SurfaceNode>()
  for (const c of surface.components) {
    if (byId.has(c.id)) return `Component id "${c.id}" is used twice.`
    byId.set(c.id, c)
  }
  if (!byId.has('root')) return 'One component must be assigned to `root`.'
  for (const c of surface.components) {
    for (const child of childIds(c)) {
      if (!byId.has(child)) return `Component "${c.id}" refers to "${child}", which does not exist.`
    }
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const cyclic = (at: string): boolean => {
    if (done.has(at)) return false
    if (visiting.has(at)) return true
    visiting.add(at)
    const node = byId.get(at)
    const hit = node ? childIds(node).some(cyclic) : false
    visiting.delete(at)
    done.add(at)
    return hit
  }
  if (cyclic('root')) return 'The components form a cycle.'
  return null
}

/** Reads a JSON Pointer (`/a/0/b`) from the data model; undefined when the path is absent. */
export function readPointer(model: unknown, pointer: string): unknown {
  let at: unknown = model
  for (const key of pointerKeys(pointer)) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** Writes a JSON Pointer into the data model, creating objects on the way. */
export function writePointer(
  model: Record<string, unknown>,
  pointer: string,
  value: unknown
): void {
  const keys = pointerKeys(pointer)
  const last = keys.pop()
  if (last === undefined) return
  let at: Record<string, unknown> = model
  for (const key of keys) {
    const next = at[key]
    if (next === null || typeof next !== 'object') at[key] = {}
    at = at[key] as Record<string, unknown>
  }
  at[last] = value
}

function pointerKeys(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
}

export const SURFACE_ACTION_PREFIX = '[Surface action] '

/** A click as the conversation shows it; the brain still gets the full message text. */
export interface SurfaceActionView {
  label: string
  values: { key: string; value: string }[]
}

/** Reads a `[Surface action] {...}` user message; null for any other text. */
export function parseSurfaceAction(content: string): SurfaceActionView | null {
  if (!content.startsWith(SURFACE_ACTION_PREFIX)) return null
  try {
    const parsed = JSON.parse(content.slice(SURFACE_ACTION_PREFIX.length)) as {
      name?: unknown
      label?: unknown
      context?: unknown
    } | null
    if (typeof parsed?.name !== 'string') return null
    const context =
      parsed.context !== null && typeof parsed.context === 'object'
        ? Object.entries(parsed.context as Record<string, unknown>)
        : []
    return {
      label: typeof parsed.label === 'string' && parsed.label !== '' ? parsed.label : parsed.name,
      values: context
        .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
        .map(([key, v]) => ({
          key,
          value: Array.isArray(v)
            ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
            : typeof v === 'string'
              ? v
              : JSON.stringify(v)
        }))
    }
  } catch {
    return null
  }
}

/** The event a button raises: its name and the context bindings it carries. */
export interface SurfaceEvent {
  name: string
  context: Record<string, unknown>
}

/** Reads `action.event` off a component; null when it names no event. */
export function eventOf(node: SurfaceNode): SurfaceEvent | null {
  const event = (node['action'] as { event?: { name?: unknown; context?: unknown } } | undefined)
    ?.event
  if (typeof event?.name !== 'string') return null
  const context =
    event.context !== null && typeof event.context === 'object'
      ? (event.context as Record<string, unknown>)
      : {}
  return { name: event.name, context }
}

/** A literal, or the value its `@path` points at in the data model. */
export function resolveValue(model: unknown, value: unknown): unknown {
  const path = pathOf(value)
  return path === null ? value : readPointer(model, path)
}

/** An event context with every binding replaced by a plain copy of its value (absent becomes null). */
export function resolveContext(
  model: unknown,
  context: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    const resolved = resolveValue(model, value)
    out[key] = resolved === undefined ? null : (JSON.parse(JSON.stringify(resolved)) as unknown)
  }
  return out
}

/** What a button click hands to `onAction`. */
export interface SurfaceAction {
  surfaceId: string
  name: string
  label: string
  sourceComponentId: string
  context: Record<string, unknown>
}

/** True for a non-empty (trimmed) string or a non-empty list: what counts as "filled in". */
function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== ''
  return Array.isArray(value) && value.length > 0
}

/**
 * Whether a button's `requires` holds. Every entry must be satisfied; an entry that is a list is
 * satisfied when any one of its paths is. No `requires` (or one that is not a list) is met.
 */
export function requiresMet(requires: unknown, model: unknown): boolean {
  if (!Array.isArray(requires)) return true
  const filled = (entry: unknown): boolean => {
    const path = pathOf(entry)
    return path !== null && isFilled(readPointer(model, path))
  }
  return requires.every((entry) => (Array.isArray(entry) ? entry.some(filled) : filled(entry)))
}

/** The first `maxLines` lines, then at most `maxChars` characters, then "…"; null when nothing is cut. */
export function cutText(text: string, maxLines: number, maxChars: number): string | null {
  const lines = text.split('\n')
  if (lines.length <= maxLines && text.length <= maxChars) return null
  const head = lines.slice(0, maxLines).join('\n')
  return (head.length > maxChars ? head.slice(0, maxChars) : head) + '\n…'
}
