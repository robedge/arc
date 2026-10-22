import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Guard for spec 002 section 2.6: entrance animations and transitions last at most 300ms.
 * Scans every renderer .svelte/.css/.ts file for CSS animation and transition durations, Tailwind
 * duration-* utilities, and the DRAW_MS constant, resolving var(--duration-*) against tokens.css.
 */

const root = join(__dirname, '../../src/renderer')
const CAP_MS = 300
const tokens = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8')

/**
 * Ambient effects are exempt from the cap: they loop forever and are not entrances.
 * Keep this list explicit; anything else must fit the cap.
 */
const ambientKeyframes = new Set(['ring-spin', 'badge-pulse', 'btn-spin'])
const ambientTokens = new Set(['--duration-pulse', '--duration-idle-spin'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full)
    return ['.svelte', '.css', '.ts'].includes(extname(full)) ? [full] : []
  })
}

function toMs(value: string): number {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(value.trim())
  if (!m) throw new Error(`unparseable duration: ${value}`)
  return m[2] === 's' ? parseFloat(m[1] as string) * 1000 : parseFloat(m[1] as string)
}

function tokenMs(name: string): number {
  const m = new RegExp(`${name}:\\s*([\\d.]+m?s)\\s*;`).exec(tokens)
  if (!m) throw new Error(`${name} is not declared in tokens.css`)
  return toMs(m[1] as string)
}

export interface Finding {
  where: string
  source: string
  ms: number
  ambient: boolean
}

/** Pulls every duration out of one source text. Exported shape is exercised by the self-tests below. */
export function scan(file: string, text: string): Finding[] {
  const found: Finding[] = []
  const lines = text.split('\n')
  const resolve = (raw: string): { ms: number; ambient: boolean } | null => {
    const v = /^var\((--duration-[a-z-]+)\)$/.exec(raw.trim())
    if (v) return { ms: tokenMs(v[1] as string), ambient: ambientTokens.has(v[1] as string) }
    if (/^-?[\d.]+m?s$/.test(raw.trim())) return { ms: toMs(raw), ambient: false }
    return null
  }
  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`
    // animation: <name> <duration> ... (shorthand, first time value) and animation-duration
    const anim = /animation(?:-duration)?\s*:\s*([^;]+);/.exec(line)
    if (anim && !/^none\b/.test((anim[1] as string).trim())) {
      const parts = (anim[1] as string).match(/var\([^)]+\)|\S+/g) ?? []
      const name = parts.find((p) => ambientKeyframes.has(p))
      const time = parts.find((p) => /^var\(--duration-/.test(p) || /^-?[\d.]+m?s$/.test(p))
      if (time) {
        const r = resolve(time)
        if (r)
          found.push({
            where,
            source: line.trim(),
            ms: r.ms,
            ambient: r.ambient || name !== undefined
          })
      }
    }
    // transition: prop <duration> ... (multi-line values keep their durations on later lines)
    const trans = /transition(?:-duration)?\s*:\s*([^;]*)/.exec(line)
    const tail = trans ? (trans[1] as string) : /^\s+\S+\s+var\(--duration-/.test(line) ? line : ''
    for (const t of tail.matchAll(/var\(--duration-[a-z-]+\)|(?<![\w.-])[\d.]+m?s\b/g)) {
      const r = resolve(t[0])
      if (r) found.push({ where, source: line.trim(), ms: r.ms, ambient: r.ambient })
    }
    // Tailwind: duration-(--duration-x), duration-[300ms], duration-300
    for (const m of line.matchAll(
      /(?<![\w-])duration-(?:\((--duration-[a-z-]+)\)|\[([\d.]+m?s)\]|(\d+))/g
    )) {
      const ms = m[1] ? tokenMs(m[1]) : m[2] ? toMs(m[2]) : Number(m[3])
      found.push({
        where,
        source: m[0],
        ms,
        ambient: m[1] !== undefined && ambientTokens.has(m[1])
      })
    }
    // Svelte transition params and the draw constant
    for (const m of line.matchAll(
      /\bduration:\s*(?:motion\.reduced\s*\?\s*0\s*:\s*)?(\d+|[A-Z_]+)\b/g
    )) {
      const raw = m[1] as string
      const ms = /^\d+$/.test(raw) ? Number(raw) : raw === 'DRAW_MS' ? drawMs : NaN
      if (!Number.isNaN(ms)) found.push({ where, source: line.trim(), ms, ambient: false })
    }
    const drawConst = /export const DRAW_MS\s*=\s*(\d+)/.exec(line)
    if (drawConst)
      found.push({ where, source: line.trim(), ms: Number(drawConst[1]), ambient: false })
  })
  return found
}

const drawMs = Number(
  /export const DRAW_MS\s*=\s*(\d+)/.exec(
    readFileSync(join(root, 'src/lib/motion.ts'), 'utf8')
  )?.[1]
)

describe('motion cap', () => {
  const all = walk(root).flatMap((file) => scan(relative(root, file), readFileSync(file, 'utf8')))
  const offenders = all.filter((f) => !f.ambient && f.ms > CAP_MS)

  it('finds the known entrance and transition durations', () => {
    expect(all.length).toBeGreaterThan(10)
    expect(all.some((f) => f.ms === CAP_MS && !f.ambient)).toBe(true)
  })

  it('no entrance animation or transition exceeds 300ms', () => {
    expect(offenders.map((f) => `${f.where} ${f.ms}ms ${f.source}`)).toEqual([])
  })

  it('the entrance token and the draw constant do not exceed the cap', () => {
    expect(tokenMs('--duration-draw')).toBeLessThanOrEqual(CAP_MS)
    expect(drawMs).toBeLessThanOrEqual(CAP_MS)
  })

  it('exempts only the explicit ambient allowlist', () => {
    const ambient = all.filter((f) => f.ambient)
    expect(ambient.length).toBeGreaterThan(0)
    for (const f of ambient) {
      expect(
        /ring-spin|badge-pulse|btn-spin|--duration-(pulse|idle-spin)/.test(f.source),
        f.where
      ).toBe(true)
    }
  })

  it('scanner catches injected over-cap entrances', () => {
    expect(
      scan('x.svelte', '  animation: panel-draw 450ms ease both;').filter((f) => f.ms > CAP_MS)
    ).toHaveLength(1)
    expect(
      scan('x.svelte', '  transition: opacity 0.6s;').filter((f) => f.ms > CAP_MS)
    ).toHaveLength(1)
    expect(
      scan('x.svelte', '<div class="duration-500">').filter((f) => f.ms > CAP_MS)
    ).toHaveLength(1)
    expect(
      scan('x.svelte', '  animation: fade-in var(--duration-pulse) both;').filter((f) => !f.ambient)
    ).toHaveLength(0)
    expect(
      scan('x.svelte', '  animation: spinner 2s linear infinite;').filter(
        (f) => f.ms > CAP_MS && !f.ambient
      )
    ).toHaveLength(1)
  })
})
