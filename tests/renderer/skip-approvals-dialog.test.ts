// @spec: 015-skip-all-approvals
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import ConfirmDialog from '../../src/renderer/src/lib/components/ui/ConfirmDialog.svelte'
import SkipApprovalsDialog from '../../src/renderer/src/lib/components/sessions/SkipApprovalsDialog.svelte'

afterEach(cleanup)

const show = () => {
  const onconfirm = vi.fn()
  const oncancel = vi.fn()
  render(SkipApprovalsDialog, { scope: 'session', onconfirm, oncancel })
  return { onconfirm, oncancel }
}

it('shows the warning title, text and both buttons', () => {
  show()
  expect(screen.getByRole('heading', { name: 'Skip all approvals?' })).toBeTruthy()
  expect(screen.getByText(/change files anywhere on your Mac/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Skip all approvals' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
})

it('the default scope leads with the new-session sentence', () => {
  render(SkipApprovalsDialog, { scope: 'default', onconfirm: vi.fn(), oncancel: vi.fn() })
  expect(
    screen.getByText(/^Every new session will start with Skip all approvals on\. The brain/)
  ).toBeTruthy()
})

it('focuses Cancel first, with the danger button after it', () => {
  show()
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  const confirm = screen.getByRole('button', { name: 'Skip all approvals' })
  expect(document.activeElement).toBe(cancel)
  expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(confirm.getAttribute('type')).toBe('button')
  expect(confirm.getAttribute('data-variant')).toBe('danger')
})

it('Enter on the focused button cancels instead of confirming', async () => {
  const { onconfirm, oncancel } = show()
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  // jsdom does not turn Enter into a click, so do what the browser does for a focused button.
  await fireEvent.keyDown(cancel, { key: 'Enter' })
  await fireEvent.click(cancel)
  expect(oncancel).toHaveBeenCalledTimes(1)
  expect(onconfirm).not.toHaveBeenCalled()
})

it('Escape cancels', async () => {
  const { onconfirm, oncancel } = show()
  await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(oncancel).toHaveBeenCalledTimes(1)
  expect(onconfirm).not.toHaveBeenCalled()
})

it('submitting the form (Enter in the dialog) cancels and never confirms', async () => {
  const { onconfirm, oncancel } = show()
  await fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)
  expect(oncancel).toHaveBeenCalledTimes(1)
  expect(onconfirm).not.toHaveBeenCalled()
})

it('clicking the danger button confirms', async () => {
  const { onconfirm, oncancel } = show()
  await fireEvent.click(screen.getByRole('button', { name: 'Skip all approvals' }))
  expect(onconfirm).toHaveBeenCalledTimes(1)
  expect(oncancel).not.toHaveBeenCalled()
})

it('ConfirmDialog honours the variant and a text body', () => {
  render(ConfirmDialog, {
    title: 'Sure?',
    body: 'Plain text',
    confirmLabel: 'Go',
    confirmVariant: 'secondary',
    onconfirm: vi.fn(),
    oncancel: vi.fn()
  })
  expect(screen.getByText('Plain text')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Go' }).getAttribute('data-variant')).toBe('secondary')
})
