import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import Modal from '../../src/renderer/src/lib/components/ui/Modal.svelte'

afterEach(cleanup)

const body = createRawSnippet(() => ({
  render: () =>
    '<div><input aria-label="Name" /><button type="button">Other</button><button type="submit">Save</button></div>'
}))

function open(props: Record<string, unknown> = {}) {
  const onsubmit = vi.fn()
  const oncancel = vi.fn()
  render(Modal, { title: 'Sample', onsubmit, oncancel, children: body, ...props })
  return { onsubmit, oncancel }
}

it('exposes an accessible modal dialog named by its title', () => {
  open()
  const dialog = screen.getByRole('dialog', { name: 'Sample' })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
})

it('moves focus into the dialog synchronously on mount', () => {
  open()
  expect(document.activeElement).toBe(screen.getByLabelText('Name'))
})

it('traps focus: Tab from the last control wraps to the first, Shift+Tab the reverse', async () => {
  open()
  const dialog = screen.getByRole('dialog')
  const first = screen.getByLabelText('Name')
  const last = screen.getByRole('button', { name: 'Save' })
  last.focus()
  await fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  // Tab in the middle is left to the browser.
  const middle = screen.getByRole('button', { name: 'Other' })
  middle.focus()
  const notPrevented = fireEvent.keyDown(middle, { key: 'Tab' })
  expect(await notPrevented).toBe(true)
  expect(dialog.contains(document.activeElement)).toBe(true)
})

it('Escape cancels', async () => {
  const { oncancel } = open()
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(oncancel).toHaveBeenCalledTimes(1)
})

it('ignores Escape while busy', async () => {
  const { oncancel } = open({ busy: true })
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(oncancel).not.toHaveBeenCalled()
})

it('ignores Escape when not closeable', async () => {
  const { oncancel } = open({ closeable: false })
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(oncancel).not.toHaveBeenCalled()
})

it('Tab and Enter work immediately after opening, with no timers advanced', async () => {
  vi.useFakeTimers()
  try {
    const { onsubmit } = open()
    const first = screen.getByLabelText('Name')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(document.activeElement).toBe(first)
    // Tab at the edge is handled at once (wraps), not deferred behind the entrance.
    save.focus()
    const tab = await fireEvent.keyDown(save, { key: 'Tab' })
    expect(tab).toBe(false)
    expect(document.activeElement).toBe(first)
    // Enter on the submit button submits at once.
    save.focus()
    await fireEvent.click(save)
    expect(onsubmit).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it('never blocks input during the entrance and picks the size width', () => {
  open({ size: 'lg' })
  const dialog = screen.getByRole('dialog')
  const scrim = dialog.parentElement!
  for (const el of [scrim, dialog]) {
    expect(el.getAttribute('inert')).toBeNull()
    expect(el.style.pointerEvents).toBe('')
  }
  expect(scrim.className).toContain('backdrop-blur')
  expect(scrim.className).toContain('no-drag')
  expect(dialog.className).toContain('w-[32rem]')
  expect(dialog.querySelector('[data-bracket]')).not.toBeNull()
})

it('keeps focus inside the dialog when the focused control becomes disabled while busy', async () => {
  const { rerender } = render(Modal, {
    title: 'Sample',
    onsubmit: vi.fn(),
    oncancel: vi.fn(),
    children: createRawSnippet(() => ({
      render: () => '<div><button type="button">Only</button></div>'
    })),
    busy: false
  })
  const only = screen.getByRole<HTMLButtonElement>('button', { name: 'Only' })
  only.focus()
  only.disabled = true // what Chromium does to focus: it falls to <body>
  ;(document.activeElement as HTMLElement | null)?.blur()
  await rerender({ busy: true })
  await new Promise((r) => setTimeout(r, 0))
  const dialog = screen.getByRole('dialog')
  expect(dialog.contains(document.activeElement)).toBe(true)
  const notPrevented = await fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(notPrevented).toBe(false)
  expect(dialog.contains(document.activeElement)).toBe(true)
})
