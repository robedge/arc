import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import DesignPreview from '../../src/renderer/src/lib/preview/DesignPreview.svelte'

beforeEach(() => {
  Object.defineProperty(window, 'arc', {
    configurable: true,
    get() {
      throw new Error('DesignPreview must not touch window.arc')
    }
  })
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).arc
})

it('labels samples and has the Design Preview heading', () => {
  render(DesignPreview)
  expect(screen.getByRole('heading', { name: 'Design Preview' })).toBeTruthy()
  expect(screen.getAllByText('Sample').length).toBeGreaterThan(10)
})

it('shows the dock with a panel for every request kind, a failed carry, and no standalone cards', () => {
  render(DesignPreview)
  const dock = document.querySelector('[data-preview-dock] [data-attention-dock]') as HTMLElement
  expect(dock).toBeTruthy()
  expect(within(dock).getByRole('heading', { name: 'Needs attention · 7' })).toBeTruthy()
  expect(dock.querySelectorAll('[data-request-panel][data-kind="permission"]')).toHaveLength(3)
  expect(within(dock).getByText('git push origin arc/fix-order-sync')).toBeTruthy()
  expect(within(dock).getByText('create_issue')).toBeTruthy()
  expect(within(dock).getByText('Wants network access')).toBeTruthy()
  expect(dock.querySelectorAll('[data-request-panel][data-kind="question"]')).toHaveLength(2)
  expect(dock.querySelectorAll('[data-request-panel][data-structured]')).toHaveLength(1)
  const branches = dock.querySelectorAll('[data-request-panel][data-kind="branch"]')
  expect(branches).toHaveLength(2)
  // The failed carry shows the reason and offers three choices.
  const failed = branches[1] as HTMLElement
  expect(within(failed).getByText(/could not bring the changes along/)).toBeTruthy()
  expect(within(failed).getAllByRole('radio')).toHaveLength(3)
  expect(within(branches[0] as HTMLElement).getAllByRole('radio')).toHaveLength(4)
  expect(document.querySelector('[data-branch-card]')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows a folded dock sample whose list is hidden and opens from its heading button', async () => {
  render(DesignPreview)
  const dock = document.querySelector(
    '[data-preview-dock-folded] [data-attention-dock]'
  ) as HTMLElement
  expect(dock).toBeTruthy()
  const button = within(dock).getByRole('button', { name: 'Needs attention · 7' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(dock.querySelector('[data-attention-list]')!.hasAttribute('hidden')).toBe(true)
  await fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(dock.querySelector('[data-attention-list]')!.hasAttribute('hidden')).toBe(false)
})

it('shows the knowledge suggestions block: chip counts, diff snippet and one card per state', async () => {
  const { container } = render(DesignPreview)
  const chips = ['1', '3', '12'].map((n) =>
    screen.getByRole('button', { name: `Knowledge suggestions, ${n} waiting` })
  )
  expect(chips.map((c) => c.querySelector('[data-count]')?.textContent)).toEqual(['1', '3', '12'])
  await fireEvent.click(chips[1]!)

  const block = container.querySelector('[data-preview-knowledge-suggestions]') as HTMLElement
  expect(block).toBeTruthy()
  const snippets = block.querySelectorAll('[data-diff-snippet]')
  expect(snippets.length).toBeGreaterThanOrEqual(2)
  expect(block.querySelector('[data-diff-snippet] [data-diff-separator]')).toBeTruthy()

  const cards = block.querySelectorAll('[data-knowledge-suggestion]')
  expect(cards.length).toBeGreaterThanOrEqual(11)
  for (const state of [
    'new',
    'update',
    'too-large',
    'changed',
    'missing',
    'name-taken',
    'save-failed',
    'storage-busy',
    'unsaved-edits',
    'failed',
    'busy',
    'editing'
  ]) {
    expect(block.querySelector(`[data-preview-card="${state}"]`), state).toBeTruthy()
  }
  expect(block.querySelector('[data-current-note]')).toBeTruthy()
  expect(block.querySelector('[data-knowledge-suggestion-editor]')).toBeTruthy()
  expect(block.querySelector('[data-too-large]')).toBeTruthy()
})

it('shows the attachments block: chip states, a long row, notices, the warning and the drop overlay', () => {
  const { container } = render(DesignPreview)
  const block = container.querySelector('[data-preview-attachments]') as HTMLElement
  expect(block).toBeTruthy()
  expect(
    within(block.closest('section') ?? container).getAllByText('Attachments').length
  ).toBeGreaterThan(0)

  const states = (scope: string): string[] =>
    Array.from(
      block.querySelectorAll(`[data-preview-attachments-${scope}] [data-attachment-chip]`)
    ).map((chip) => (chip as HTMLElement).dataset.attachmentState ?? '')
  const draft = states('chips')
  expect(draft).toEqual(expect.arrayContaining(['ready', 'staging', 'error']))
  expect(
    block.querySelectorAll('[data-preview-attachments-chips] [data-attachment-chip]').length
  ).toBe(5)
  expect(block.querySelector('[data-preview-attachments-sent] [data-attachment-remove]')).toBeNull()
  expect(
    block.querySelectorAll('[data-preview-attachments-sent] [data-attachment-chip]').length
  ).toBe(3)

  expect(
    block.querySelectorAll('[data-preview-attachments-long] [data-attachment-item]').length
  ).toBe(10)

  for (const text of [
    "notes.exe can't be attached. Arc accepts images, PDFs and text files.",
    'huge.png is too large. The limit is 20 MB.',
    'A message can have at most 10 attachments.',
    "Folders can't be attached.",
    "broken.txt couldn't be read.",
    'and 2 more were refused.',
    "Codex can't read PDFs. It will be sent as a file the brain may not be able to open."
  ]) {
    expect(within(block).getAllByText(text).length).toBeGreaterThan(0)
  }
  expect(within(block).getByText('Drop to attach')).toBeTruthy()
})

it('shows a short and a very long answered-request record', () => {
  const { container } = render(DesignPreview)
  const records = container.querySelectorAll('[data-preview-records] [data-record]')
  expect(records).toHaveLength(2)
  expect(records[0]?.textContent).toContain('git push origin arc/fix-order-sync')
  expect((records[1]?.getAttribute('title') ?? '').length).toBeGreaterThan(300)
  expect(records[1]?.classList.contains('truncate')).toBe(true)
})

it('shows an inert Skipping approvals marker and a Skip all approvals dialog sample', async () => {
  render(DesignPreview)
  const row = document.querySelector('[data-preview-skip-approvals]') as HTMLElement
  expect(within(row).getByRole('button', { name: 'Skipping approvals' })).toBeTruthy()
  await fireEvent.click(within(row).getByRole('button', { name: 'Open Skip all approvals dialog' }))
  expect(screen.getByRole('heading', { name: 'Skip all approvals?' })).toBeTruthy()
  await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('heading', { name: 'Skip all approvals?' })).toBeNull()
})

it('shows a session list row with the skipping marker, and the Approvals settings sample', () => {
  render(DesignPreview)
  const row = document.querySelector('[data-preview-skip-row]') as HTMLElement
  expect(within(row).getByRole('img', { name: 'Skipping approvals' })).toBeTruthy()
  const section = document.querySelector('[data-approvals-settings]') as HTMLElement
  expect(
    within(section).getByRole('switch', { name: 'Skip all approvals by default' })
  ).toBeTruthy()
})
