import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { expect, it } from 'vitest'

const root = join(__dirname, '../../src/renderer')
const extensions = new Set(['.svelte', '.ts', '.css', '.html'])
const families =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const defaultPalette = new RegExp(
  `(?<![\\w-])(?:[\\w[\\]:-]*:)?[a-z]+(?:-[a-z]+)*-(?:${families})-(?:50|100|200|300|400|500|600|700|800|900|950)(?![\\w-])`
)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full)
    return extensions.has(extname(full)) ? [full] : []
  })
}

it('uses no default Tailwind palette classes in the renderer', () => {
  const offenders: string[] = []
  for (const file of walk(root)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const match = defaultPalette.exec(line)
        if (match) offenders.push(`${relative(root, file)}:${i + 1} ${match[0]}`)
      })
  }
  expect(offenders).toEqual([])
})
