import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Static guards for spec 002 section 2.9 (task 9.2): the rules a later screen could silently break.
 */

const root = join(__dirname, '../../src/renderer/src')

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })
}

const files = svelteFiles(root).map((path) => ({
  path: path.slice(root.length + 1),
  source: readFileSync(path, 'utf8')
}))

describe('accessibility sweep guards', () => {
  it('only ErrorText renders role="alert": every error line has an icon beside red text', () => {
    const offenders = files
      .filter((f) => f.path !== 'lib/components/ui/ErrorText.svelte')
      .filter((f) => /role="alert"/.test(f.source))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('no bare red text element: danger text lives in ErrorText, MenuItem or kind styles', () => {
    const allowed = new Set([
      'lib/components/ui/ErrorText.svelte',
      'lib/components/ui/MenuItem.svelte',
      'lib/components/ui/SaveIndicator.svelte',
      // Diff removal colour, always paired with a − sign; not an error message.
      'lib/components/review/ReviewFileRow.svelte',
      // Plan limit severity: red is always paired with an icon and hidden "critical" text.
      'lib/components/ui/PlanMeters.svelte',
      'lib/components/usage/PlanLimitRow.svelte'
    ])
    const offenders = files
      .filter((f) => !allowed.has(f.path))
      .filter((f) => /class="[^"]*\btext-danger\b/.test(f.source))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('every IconButton usage passes a non-empty label', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const m of f.source.matchAll(/<IconButton\b([\s\S]*?)\/>/g)) {
        if (!/\blabel="[^"]+"/.test(m[1] as string)) bad.push(f.path)
      }
    }
    expect(bad).toEqual([])
  })

  it('Radio has no aria-invalid (invalid on role radio)', () => {
    const radio = files.find((f) => f.path === 'lib/components/ui/Radio.svelte')
    expect(radio?.source).not.toMatch(/aria-invalid=/)
  })

  it('the worker input line is a textarea with its own label', () => {
    const bar = files.find((f) => f.path === 'lib/components/sessions/StepInBar.svelte')
    expect(bar?.source).toMatch(/<label for=\{inputId\}[^>]*>Message to \{label\}<\/label>/)
    expect(bar?.source).toMatch(/const inputId = \$derived\(`worker-input-\$\{workerId\}`\)/)
    expect(bar?.source).toMatch(/<textarea\s+id=\{inputId\}/)
  })
})
