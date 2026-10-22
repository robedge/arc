import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import DesignPreview from '../../src/renderer/src/lib/preview/DesignPreview.svelte'

beforeEach(() => {
  Object.defineProperty(window, 'harness', {
    configurable: true,
    get() {
      throw new Error('DesignPreview must not touch window.harness')
    }
  })
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).harness
})

it('labels samples and has the Design Preview heading', () => {
  render(DesignPreview)
  expect(screen.getByRole('heading', { name: 'Design Preview' })).toBeTruthy()
  expect(screen.getAllByText('Sample').length).toBeGreaterThan(10)
})

it('opens the attention dialog with one permission and one question; Escape keeps count 2', async () => {
  render(DesignPreview)
  const badge = screen.getByRole('button', { name: 'Needs attention, 2 waiting' })
  expect(badge.querySelector('[data-count]')?.textContent).toBe('2')
  await fireEvent.click(badge)
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelectorAll('[data-kind="permission"]')).toHaveLength(1)
  expect(dialog.querySelectorAll('[data-kind="question"]')).toHaveLength(1)
  expect(within(dialog).getByText('git push origin arc/fix-order-sync')).toBeTruthy()
  await fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Needs attention, 2 waiting' }).querySelector('[data-count]')
      ?.textContent
  ).toBe('2')
})
