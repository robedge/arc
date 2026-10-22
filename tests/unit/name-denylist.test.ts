import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Guard for spec 002 section 2.1: the product is "Arc" and no third-party franchise names appear in
 * shipped UI, menu labels or bundled resources. Whole-word, case-insensitive.
 * Scope: all of src/renderer, the app menu (src/main/app/app-menu.ts) and text/svg files in resources/.
 * Binary resources (png, icns, tiff) are skipped, as are node_modules and the font license text
 * (resources/licenses), which names third parties by legal necessity.
 */

const repo = join(__dirname, '../..')
const banned = [
  'JARVIS',
  'EDITH',
  'FRIDAY',
  'Stark',
  'Tony Stark',
  'Iron Man',
  'Marvel',
  'Avengers',
  'Vibranium',
  'Ultron',
  'Arc Reactor'
]
const pattern = new RegExp(
  `(?<![\\w])(?:${banned.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})(?![\\w])`,
  'i'
)
const textExtensions = new Set(['.svelte', '.ts', '.css', '.html', '.svg', '.txt', '.md', '.json'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' || name === 'licenses' ? [] : walk(full)
    }
    return textExtensions.has(extname(full)) ? [full] : []
  })
}

export function findBanned(text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const m = pattern.exec(line)
    return m ? [`${i + 1}: ${m[0]}`] : []
  })
}

const files = [
  ...walk(join(repo, 'src/renderer')),
  join(repo, 'src/main/app/app-menu.ts'),
  ...walk(join(repo, 'resources'))
]

describe('franchise-name denylist', () => {
  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(30)
    expect(files.some((f) => f.endsWith('app-menu.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('arc-icon.svg'))).toBe(true)
  })

  it('no banned name appears in the renderer, app menu or resources', () => {
    const offenders = files.flatMap((f) =>
      findBanned(readFileSync(f, 'utf8')).map((hit) => `${relative(repo, f)}:${hit}`)
    )
    expect(offenders).toEqual([])
  })

  it('catches injected names and ignores substrings', () => {
    for (const w of [
      'jarvis',
      'Edith',
      'Friday',
      'STARK',
      'iron man',
      'Marvel',
      'avengers',
      'Tony  Stark',
      'Vibranium',
      'ULTRON',
      'arc reactor'
    ]) {
      expect(findBanned(`label: '${w} mode'`), w).toHaveLength(1)
    }
    expect(findBanned('starkly, Starkville, marvelous, credit, Arc, reactor')).toEqual([])
  })
})
