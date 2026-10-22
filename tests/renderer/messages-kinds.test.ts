import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import Toaster from '../../src/renderer/src/lib/components/ui/Toaster.svelte'
import Banner from '../../src/renderer/src/lib/components/ui/Banner.svelte'
import SaveIndicator from '../../src/renderer/src/lib/components/ui/SaveIndicator.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { messageKinds, type MessageKind } from '../../src/renderer/src/lib/components/ui/kinds'

afterEach(() => {
  cleanup()
  toasts.list = []
})

const kinds: MessageKind[] = ['info', 'success', 'warning', 'error']

it('toasts default to info', () => {
  toasts.show('hello')
  expect(toasts.list[0]?.kind).toBe('info')
})

for (const kind of kinds) {
  it(`a ${kind} toast shows an aria-hidden ${messageKinds[kind].icon} icon and its text`, async () => {
    toasts.show(`Message ${kind}`, kind)
    const { container } = render(Toaster)
    const toast = await screen.findByText(`Message ${kind}`)
    const root = toast.closest('[data-kind]')!
    expect(root.getAttribute('data-kind')).toBe(kind)
    const icon = root.querySelector('svg')!
    expect(icon.getAttribute('data-icon')).toBe(messageKinds[kind].icon)
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(root.getAttribute('aria-live')).toBe(kind === 'error' ? 'assertive' : 'polite')
    expect(container.querySelectorAll('[data-kind]')).toHaveLength(1)
  })
}

for (const kind of ['info', 'warning', 'error'] as const) {
  it(`a ${kind} banner shows an icon, title and text`, () => {
    const children = createRawSnippet(() => ({ render: () => '<p>Body text</p>' }))
    const { container } = render(Banner, { kind, title: 'Heading', children })
    expect(screen.getByText('Heading')).toBeTruthy()
    expect(screen.getByText('Body text')).toBeTruthy()
    const icon = container.querySelector('svg')!
    expect(icon.getAttribute('data-icon')).toBe(messageKinds[kind].icon)
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole(kind === 'info' ? 'status' : 'alert')).toBeTruthy()
  })
}

it('SaveIndicator shows Saved with a check, and an error state with an icon', () => {
  const saved = render(SaveIndicator, { status: 'saved' })
  expect(screen.getByText('Saved')).toBeTruthy()
  expect(saved.container.querySelector('[data-icon="check"]')).not.toBeNull()
  cleanup()
  const failed = render(SaveIndicator, { status: 'error' })
  const el = screen.getByRole('status')
  expect(el.textContent).toContain("Couldn't save")
  expect(el.className).toContain('text-danger')
  expect(failed.container.querySelector('[data-icon="error"]')).not.toBeNull()
})
