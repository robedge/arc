import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import DiffSnippet from '../../src/renderer/src/lib/components/ui/DiffSnippet.svelte'
import DiffLine from '../../src/renderer/src/lib/components/review/DiffLine.svelte'
import type { DiffHunk } from '../../src/shared/types/review'

afterEach(cleanup)

const hunk = (header: string, lines: DiffHunk['lines']): DiffHunk => ({
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 2,
  header,
  lines
})
const one = hunk('@@ -1,2 +1,2 @@', [
  { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
  { kind: 'del', oldNo: 2, text: 'old line' },
  { kind: 'add', newNo: 2, text: 'new line' }
])
const two = hunk('@@ -20,1 +20,1 @@', [{ kind: 'add', newNo: 20, text: 'later add' }])

it('renders added and removed rows with their markers', () => {
  render(DiffSnippet, { hunks: [one], label: 'Changes to Schema' })
  const add = document.querySelector('[data-diff-line="add"]')
  const del = document.querySelector('[data-diff-line="del"]')
  expect(add?.querySelector('[data-sign]')?.textContent).toBe('+')
  expect(del?.querySelector('[data-sign]')?.textContent).toBe('−')
  expect(add?.textContent).toContain('new line')
  expect(del?.textContent).toContain('old line')
  expect(document.querySelectorAll('[data-diff-line="ctx"]').length).toBe(1)
})

it('hides hunk headers', () => {
  render(DiffSnippet, { hunks: [one], label: 'x' })
  expect(document.querySelector('[data-diff-hunk]')).toBeNull()
  expect(document.body.textContent).not.toContain('@@')
})

it('puts a separator between hunks and not before the first', () => {
  render(DiffSnippet, { hunks: [one, two], label: 'x' })
  const region = document.querySelector('[data-diff-snippet]')!
  expect(region.querySelectorAll('[data-diff-separator]').length).toBe(1)
  const first = region.firstElementChild as HTMLElement
  expect(first.hasAttribute('data-diff-separator')).toBe(false)
  expect(region.children[3]?.hasAttribute('data-diff-separator')).toBe(true)
})

it('is a named, focusable, scrollable region', () => {
  render(DiffSnippet, { hunks: [one], label: 'Changes to Schema' })
  const region = screen.getByRole('region', { name: 'Changes to Schema' })
  expect(region.getAttribute('tabindex')).toBe('0')
  expect(region.hasAttribute('data-diff-snippet')).toBe(true)
  expect(region.className).toContain('overflow-auto')
})

it('does not wrap a long line', () => {
  const long = 'x'.repeat(400)
  render(DiffSnippet, {
    hunks: [hunk('@@', [{ kind: 'add', newNo: 1, text: long }])],
    label: 'x'
  })
  const row = document.querySelector('[data-diff-line="add"]')!
  expect(row.textContent).toContain(long)
  expect(row.innerHTML).toContain('whitespace-pre')
  expect(row.innerHTML).not.toContain('whitespace-pre-wrap')
})

it('DiffLine keeps its two line-number columns without compact', () => {
  render(DiffLine, { row: { type: 'line', kind: 'add', oldNo: 3, newNo: 4, text: 't' } })
  expect(document.querySelector('[data-old-no]')?.textContent).toBe('3')
  expect(document.querySelector('[data-new-no]')?.textContent).toBe('4')
  expect(document.querySelector('[data-old-no]')?.className).toContain('w-16')
})

it('DiffLine compact shows one narrow gutter', () => {
  render(DiffLine, {
    row: { type: 'line', kind: 'add', oldNo: 3, newNo: 4, text: 't' },
    compact: true
  })
  expect(document.querySelector('[data-old-no]')).toBeNull()
  expect(document.querySelector('[data-new-no]')).toBeNull()
  expect(document.querySelector('[data-line-no]')?.className).not.toContain('w-16')
})
