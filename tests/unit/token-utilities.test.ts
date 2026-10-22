import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, relative } from 'node:path'
import { compile } from 'tailwindcss'
import { expect, it } from 'vitest'

const root = join(__dirname, '../..')
const rendererRoot = join(root, 'src/renderer')
const tokensPath = join(rendererRoot, 'src/styles/tokens.css')
const require = createRequire(join(root, 'package.json'))
const extensions = new Set(['.svelte', '.ts', '.html'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full)
    return extensions.has(extname(full)) ? [full] : []
  })
}

/** Escape a class name the way it appears in compiled CSS selectors. */
function cssEscape(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}

it('every token-named utility used in the renderer actually generates CSS', async () => {
  const tokens = readFileSync(tokensPath, 'utf8')
  // Bare token suffixes: --duration-fast -> "fast", --size-hit -> "hit", --ease-hud -> "hud".
  const suffixes = new Set(
    [...tokens.matchAll(/^\s*--[a-z]+-([a-z][a-z-]*):/gm)].map((m) => m[1] as string)
  )
  // Only real Tailwind utility prefixes count; custom classes such as item-title are not utilities.
  const prefixes =
    'min-h|min-w|max-h|max-w|h|w|size|duration|delay|ease|gap|p|px|py|m|mx|my|top|left|right|bottom|inset|basis|rounded|shadow|tracking|text|bg|border|ring|fill|stroke|outline|opacity|z|grid-cols|translate-x|translate-y'
  const tail = new RegExp(`^(?:[a-z0-9-]+:)*!?-?(?:${prefixes})-(?:${[...suffixes].join('|')})$`)

  const used = new Map<string, string>()
  for (const file of walk(rendererRoot)) {
    for (const word of readFileSync(file, 'utf8').split(/[\s"'`{}<>=,;]+/)) {
      if (tail.test(word) && !word.startsWith('--')) used.set(word, relative(root, file))
    }
  }

  const css =
    "@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities);\n" +
    tokens
  const compiler = await compile(css, {
    base: root,
    loadStylesheet: async (id, base) => {
      const path = id.startsWith('.') ? require.resolve(id, { paths: [base] }) : require.resolve(id)
      return { path, base, content: readFileSync(path, 'utf8') }
    }
  })

  // Sanity: the compiler really rejects the known offenders and accepts the fixed forms.
  const probe = compiler.build([
    'min-h-hit',
    'min-w-hit',
    'duration-fast',
    'duration-(--duration-fast)',
    'min-h-[var(--size-hit)]'
  ])
  expect(probe).not.toContain(cssEscape('min-h-hit') + ' {')
  expect(probe).not.toContain(cssEscape('duration-fast') + ' {')
  expect(probe).toContain(cssEscape('duration-(--duration-fast)'))

  const missing = [...used]
    .filter(([name]) => !compiler.build([name]).includes(`.${cssEscape(name)}`))
    .map(([name, file]) => `${name} (${file})`)
  expect(missing).toEqual([])
})
