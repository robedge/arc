import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import MarkdownPreview from '../../src/renderer/src/lib/components/items/MarkdownPreview.svelte'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const SOURCE = '```ts\nconst a = 1\n```'

function stubClipboard(writeText: (t: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

it('has no Copy button unless copyCode is on', () => {
  render(MarkdownPreview, { source: SOURCE })
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
})

it('Copy writes the code to the clipboard and shows Copied', async () => {
  const writeText = vi.fn(async () => {})
  stubClipboard(writeText)
  render(MarkdownPreview, { source: SOURCE, copyCode: true })
  await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
  expect(writeText).toHaveBeenCalledWith('const a = 1\n')
})

it('shows Copy failed when the clipboard rejects', async () => {
  stubClipboard(async () => {
    throw new Error('denied')
  })
  render(MarkdownPreview, { source: SOURCE, copyCode: true })
  await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy())
})
