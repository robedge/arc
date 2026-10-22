import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const src = join(root, 'src')

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full))
    else if (/\.(ts|svelte|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

const rel = (file: string): string => relative(root, file).split('\\').join('/')

describe('push guards (spec 004, tech spec 2.5)', () => {
  it('only src/main/git/push.ts constructs a runner with allowPush: true', () => {
    const offenders = sourcesUnder(src)
      .filter((file) => /allowPush\s*:\s*true/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(offenders).toEqual(['src/main/git/push.ts'])
  })

  it('nothing in the MCP bridge reaches the push module or allowPush', () => {
    const files = sourcesUnder(join(src, 'main', 'bridge'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text, rel(file)).not.toMatch(
        /allowPush|git\/push|push-service|PushService|createPushGit/
      )
      expect(text, rel(file)).not.toMatch(/review:push/)
    }
  })

  it('only the expected main modules import the push modules', () => {
    const importers = sourcesUnder(join(src, 'main'))
      .filter((file) =>
        /from '[^']*\/(git\/push|review\/push-service)'/.test(readFileSync(file, 'utf8'))
      )
      .map(rel)
      .sort()
    expect(importers).toEqual([
      'src/main/app/bootstrap.ts',
      'src/main/review/push-service.ts',
      'src/main/review/review-service.ts',
      'src/main/sessions/session-service.ts'
    ])
  })
})
