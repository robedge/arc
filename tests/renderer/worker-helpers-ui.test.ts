import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import TerminalPanel from '../../src/renderer/src/lib/components/sessions/TerminalPanel.svelte'
import { TerminalBuffer } from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import type { WorkerView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: [],
    model: 'sonnet',
    status: 'working',
    activity: 'Working',
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

beforeEach(() => {
  mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

const chip = (): HTMLElement | null => document.querySelector('[data-worker-helpers]')

it('the card chip says "2 helpers", "1 helper", and is hidden at 0 or absent', () => {
  for (const [count, text] of [
    [2, '2 helpers'],
    [1, '1 helper']
  ] as const) {
    const { unmount } = render(WorkerCard, {
      worker: worker({ helpersRunning: count }),
      onopen: () => {}
    })
    expect(chip()?.textContent?.trim()).toBe(text)
    expect(chip()?.getAttribute('data-worker-helpers')).toBe(String(count))
    unmount()
  }
  for (const over of [{ helpersRunning: 0 }, {}]) {
    const { unmount } = render(WorkerCard, { worker: worker(over), onopen: () => {} })
    expect(chip()).toBeNull()
    unmount()
  }
})

it('WorkerDetails shows the same chip', () => {
  render(WorkerDetails, { worker: worker({ helpersRunning: 2 }), onclose: () => {} })
  expect(chip()?.textContent?.trim()).toBe('2 helpers')
})

it('the terminal dims and indents helper lines and keeps their text', () => {
  const buffer = new TerminalBuffer()
  buffer.ready = true
  buffer.append('plain line\n  ↳ helper (Review): Read a.ts')
  render(TerminalPanel, { buffer, label: 'T output' })
  const lines = [...document.querySelectorAll<HTMLElement>('[data-terminal-line]')]
  const [plain, helper] = lines as [HTMLElement, HTMLElement]
  expect(lines).toHaveLength(2)
  expect(plain.hasAttribute('data-helper-line')).toBe(false)
  expect(helper.hasAttribute('data-helper-line')).toBe(true)
  expect(helper.className).toContain('text-text-muted')
  expect(helper.className).toContain('pl-6')
  expect(helper.textContent).toBe('  ↳ helper (Review): Read a.ts')
})
