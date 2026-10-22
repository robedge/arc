import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Guard for spec 002 section 2.9 (accessibility). Parses tokens.css, alpha-composites every translucent
 * surface over the backdrop it really sits on, and asserts WCAG 2.x ratios for the declared pair list:
 * 4.5:1 for text, 3:1 for large text and for functional borders (those that mark a control's boundary or state).
 * The plain --color-border is decorative panel chrome and is deliberately not asserted.
 */

const themeSource = readFileSync(
  join(__dirname, '../../src/renderer/src/lib/editor/hud-theme.ts'),
  'utf8'
)
const tokens = readFileSync(join(__dirname, '../../src/renderer/src/styles/tokens.css'), 'utf8')

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1] as string, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/i.exec(value)
  if (!rgba) throw new Error(`unsupported color value: ${value}`)
  return {
    r: +(rgba[1] as string),
    g: +(rgba[2] as string),
    b: +(rgba[3] as string),
    a: rgba[4] === undefined ? 1 : +rgba[4]
  }
}

/** Raw value of a `--color-*` token declared in tokens.css. */
function tokenValue(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(tokens)
  if (!match) throw new Error(`token --color-${name} is not declared`)
  const value = (match[1] as string).trim()
  const alias = /^var\(--color-([a-z-]+)\)$/.exec(value)
  return alias ? tokenValue(alias[1] as string) : value
}

/** Composite `fg` (with its own alpha, optionally scaled) over an opaque backdrop. */
function over(fg: Rgba, bg: Rgba, alpha = fg.a): Rgba {
  const mix = (f: number, b: number): number => Math.round(f * alpha + b * (1 - alpha))
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 }
}

function luminance(c: Rgba): number {
  const lin = [c.r, c.g, c.b].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number)
}

export function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const tok = (name: string): Rgba => parseColor(tokenValue(name))

const ground = tok('ground')
if (ground.a !== 1) throw new Error('ground must be opaque')

/** Resolved surfaces, each composited over its real backdrop. */
const panel = over(tok('surface-panel'), ground)
const surfaces: Record<string, Rgba> = {
  ground,
  panel,
  raised: tok('surface-raised'),
  code: tok('surface-code'),
  bar: over(tok('surface-bar'), ground),
  scrim: over(tok('surface-scrim'), ground),
  hover: over(tok('surface-hover'), panel),
  selected: over(tok('surface-selected'), panel),
  // Tinted banners and cards: the kind color at 10% over the panel they sit on.
  'attention/10 on panel': over(tok('attention'), panel, 0.1),
  'danger/10 on panel': over(tok('danger'), panel, 0.1),
  'accent/10 on panel': over(tok('accent'), panel, 0.1),
  'success/10 on panel': over(tok('success'), panel, 0.1)
}

const NORMAL = 4.5
const LARGE = 3

const rows: { fg: string; bg: string; min: number; kind: string; ratio: number }[] = []

function check(kind: string, fg: string, fgColor: Rgba, bg: string, min: number): void {
  rows.push({ fg, bg, min, kind, ratio: ratio(fgColor, surfaces[bg] as Rgba) })
}

const textTokens = ['text', 'text-bright', 'text-muted', 'text-faint']
const textSurfaces = ['ground', 'panel', 'raised', 'code', 'hover', 'selected']
const semanticText = ['accent', 'success', 'attention', 'attention-text', 'danger']

describe('declared contrast pairs', () => {
  for (const fg of textTokens) {
    for (const bg of textSurfaces) check('text', fg, tok(fg), bg, NORMAL)
  }
  for (const fg of semanticText) {
    for (const bg of textSurfaces) check('text', fg, tok(fg), bg, NORMAL)
  }
  // Primary text on bars, scrim and kind-tinted banners/cards.
  for (const bg of ['bar', 'scrim']) {
    for (const fg of ['text', 'text-bright', 'text-muted', 'text-faint'])
      check('text', fg, tok(fg), bg, NORMAL)
  }
  for (const [bg, kinds] of [
    ['attention/10 on panel', ['text', 'text-muted', 'attention', 'attention-text']],
    ['danger/10 on panel', ['text', 'text-muted', 'danger']],
    ['accent/10 on panel', ['text', 'text-muted', 'accent']],
    ['success/10 on panel', ['text', 'text-muted', 'success']]
  ] as [string, string[]][]) {
    for (const fg of kinds) check('text', fg, tok(fg), bg, NORMAL)
  }
  // Ink on solid fills (button text).
  for (const [ink, fill] of [
    ['accent-ink', 'accent'],
    ['danger-ink', 'danger'],
    ['attention-ink', 'attention']
  ] as const) {
    rows.push({
      fg: ink,
      bg: `${fill} (solid)`,
      min: NORMAL,
      kind: 'ink',
      ratio: ratio(tok(ink), tok(fill))
    })
  }
  // Placeholder text is text-faint (placeholder:text-text-faint) on the field background.
  for (const bg of ['panel', 'raised'])
    check('placeholder', 'text-faint', tok('text-faint'), bg, NORMAL)

  // Display-font headings. Large text (3:1) only when >= 24px, or >= 18.66px and bold.
  // GroupView h-title: 22px bold text-bright. DesignPreview h1: 24px text-bright.
  check('large heading 22px bold', 'text-bright', tok('text-bright'), 'ground', LARGE)
  check('large heading 24px', 'text-bright', tok('text-bright'), 'ground', LARGE)
  // Modal title (18px semibold, not large), wordmark (18px bold, not large) and 14px section titles are normal text.
  check('heading 18px semibold', 'text', tok('text'), 'panel', NORMAL)
  check('wordmark 18px bold', 'text-bright', tok('text-bright'), 'ground', NORMAL)
  check('section title 14px', 'text-muted', tok('text-muted'), 'panel', NORMAL)

  // Functional borders: input/select/textarea (border over panel, next to ground), checkbox, radio and toggle
  // (border-border-strong over raised), plus state borders and the keyboard focus ring against ground.
  // --color-border (decorative) and --color-line-faint (dividers) are intentionally excluded.
  const strong = tok('border-strong')
  for (const [label, edge, adjacent] of [
    ['border-strong on panel field vs ground', over(strong, panel), 'ground'],
    ['border-strong on raised control vs ground', over(strong, surfaces.raised as Rgba), 'ground'],
    ['border-strong on raised control vs panel', over(strong, surfaces.raised as Rgba), 'panel'],
    ['border-strong on raised control vs raised', over(strong, surfaces.raised as Rgba), 'raised']
  ] as [string, Rgba, string][]) {
    rows.push({
      fg: label,
      bg: adjacent,
      min: LARGE,
      kind: 'functional border',
      ratio: ratio(edge, surfaces[adjacent] as Rgba)
    })
  }
  for (const name of ['accent', 'danger', 'attention']) {
    check('state border', `border-${name}`, tok(name), 'ground', LARGE)
    check('state border', `border-${name}`, tok(name), 'panel', LARGE)
  }
  check('focus ring', 'accent (shadow-focus)', tok('accent'), 'ground', LARGE)

  // Daily chart series: bars and their edges are graphics, 3:1 against the panel they sit on (and the
  // code-dark hatch gap). They alias palette tokens, so a retuned palette is re-checked here.
  for (const name of ['chart-claude', 'chart-codex', 'chart-cursor']) {
    check('chart series', name, tok(name), 'panel', LARGE)
    check('chart series', name, tok(name), 'code', LARGE)
  }

  it.each(rows.map((r) => [`${r.kind}: ${r.fg} on ${r.bg}`, r] as const))('%s', (_label, row) => {
    expect(row.ratio).toBeGreaterThanOrEqual(row.min)
  })

  it('covers a non-trivial pair list', () => {
    expect(rows.length).toBeGreaterThan(80)
  })
})

/** Every text color the editor's HighlightStyle paints with, as token names. */
function highlightTokens(): string[] {
  const highlight = themeSource.slice(themeSource.indexOf('HighlightStyle.define'))
  const colors = [...highlight.matchAll(/color:\s*'([^']+)'/g)].map((m) => m[1] as string)
  const names = colors.map((color) => {
    const match = /^var\(--color-([a-z-]+)\)$/.exec(color)
    if (!match) throw new Error(`highlight color ${color} must read a token variable`)
    return match[1] as string
  })
  return [...new Set(names)].sort()
}

describe('editor highlight colors', () => {
  it('uses the documented colors', () => {
    expect(highlightTokens()).toEqual(
      [
        'accent',
        'attention-text',
        'attention',
        'danger',
        'success',
        'text-bright',
        'text-muted'
      ].sort()
    )
  })

  it('every highlight color and the default text meet 4.5:1 on surface-code', () => {
    const failures = [...highlightTokens(), 'text']
      .map((name) => ({ name, ratio: ratio(tok(name), surfaces.code as Rgba) }))
      .filter(({ ratio: r }) => r < NORMAL)
    expect(failures).toEqual([])
  })

  it('every highlight color also meets 4.5:1 on the panel', () => {
    const failures = highlightTokens()
      .map((name) => ({ name, ratio: ratio(tok(name), panel) }))
      .filter(({ ratio: r }) => r < NORMAL)
    expect(failures).toEqual([])
  })
})

describe('contrast helpers', () => {
  it('composites translucent colors over their backdrop', () => {
    expect(over({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })).toEqual({
      r: 128,
      g: 128,
      b: 128,
      a: 1
    })
  })
  it('matches the WCAG extremes', () => {
    expect(ratio(parseColor('#ffffff'), parseColor('#000000'))).toBeCloseTo(21, 5)
  })
})
