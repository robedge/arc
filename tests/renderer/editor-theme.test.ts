import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import MarkdownEditor from '../../src/renderer/src/lib/components/items/MarkdownEditor.svelte'
import TextDocEditor from '../../src/renderer/src/lib/components/items/TextDocEditor.svelte'
import {
  hudEditorExtensions,
  hudEditorHostClass,
  hudThemeSpec
} from '../../src/renderer/src/lib/editor/hud-theme'

afterEach(cleanup)

const root = join(__dirname, '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

it('the factory returns a dark theme plus syntax highlighting', () => {
  const extensions = hudEditorExtensions('code')
  expect(extensions).toHaveLength(2)
  expect(hudEditorExtensions('markdown')).toHaveLength(2)
})

it('both editors take their theme from the shared factory', () => {
  expect(read('src/renderer/src/lib/components/items/MarkdownEditor.svelte')).toContain(
    "hudEditorExtensions('markdown')"
  )
  expect(read('src/renderer/src/lib/components/items/TextDocEditor.svelte')).toContain(
    "hudEditorExtensions('code')"
  )
})

it('themes read token variables only, with mono for code and Rajdhani for Markdown', () => {
  const code = JSON.stringify(hudThemeSpec('code'))
  const md = JSON.stringify(hudThemeSpec('markdown'))
  expect(code).toContain('var(--font-mono)')
  expect(md).toContain('var(--font-sans)')
  for (const spec of [code, md]) {
    expect(spec).toContain('var(--color-accent)')
    expect(spec).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(spec).not.toMatch(/rgba?\(/)
  }
})

it('only .cm-scroller scrolls, and the editor fills its host', () => {
  const spec = hudThemeSpec('code')
  expect(spec['.cm-scroller']?.overflow).toBe('auto')
  expect(spec['&']?.minHeight).toBe('0')
  expect(spec['&']?.flex).toBe('1 1 auto')
  for (const [selector, rules] of Object.entries(spec)) {
    if (selector !== '.cm-scroller') expect(rules.overflow).toBeUndefined()
  }
  for (const cls of ['flex-1', 'min-h-32', 'flex-col', 'overflow-hidden']) {
    expect(hudEditorHostClass.split(' ')).toContain(cls)
  }
  expect(hudEditorHostClass).not.toMatch(/max-h|overflow-auto|overflow-y/)
})

it('each editor container carries the focus-within ring and keeps .cm-content', () => {
  const md = render(MarkdownEditor, { value: 'hi', onchange: () => {} })
  const host = md.container.querySelector('.cm-editor')!.parentElement!
  expect(host.classList.contains('focus-within:shadow-focus')).toBe(true)
  expect(host.classList.contains('flex-1')).toBe(true)
  expect(md.container.querySelector('.cm-content')).not.toBeNull()
  cleanup()
  const txt = render(TextDocEditor, { value: 'x', fileName: 'a.txt', onchange: () => {} })
  const host2 = txt.container.querySelector('.cm-editor')!.parentElement!
  expect(host2.classList.contains('focus-within:shadow-focus')).toBe(true)
  expect(txt.container.querySelector('.cm-content')).not.toBeNull()
})

it('the preview CSS uses display headings, mono code on surface-code and cyan underlined links', () => {
  const css = read('src/renderer/src/styles/markdown-preview.css')
  expect(css).toMatch(/h1,[\s\S]*?font-family: var\(--font-display\)/)
  expect(css).toMatch(/\.markdown-preview code \{[^}]*var\(--font-mono\)/)
  expect(css).toMatch(/\.markdown-preview pre \{[^}]*var\(--color-surface-code\)/)
  expect(css).toMatch(/\.markdown-preview a \{[^}]*var\(--color-accent\)[^}]*underline/)
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
})
