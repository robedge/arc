import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import RingLogo from '../../src/renderer/src/lib/components/ui/RingLogo.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { SessionHeader as Header } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Old name',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  invoke = mockHarness(() => ({
    ok: true,
    data: {
      id: 's1',
      groupId: 'g1',
      name: 'New name',
      lastActiveAt: 2,
      status: 'active',
      attentionCount: 0
    }
  }))
})
afterEach(cleanup)

it('shows group, name and mode text', () => {
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn() })
  expect(screen.getByText('Team')).toBeTruthy()
  expect(screen.getByText('Old name')).toBeTruthy()
  expect(screen.getByText('Autonomous · Limit 4')).toBeTruthy()
})

const branch = (projectId: string, base: string | null, over = {}) => ({
  projectId,
  projectName: projectId,
  branchName: 'arc/fix-order-sync',
  baseBranch: base,
  readOnly: false,
  ...over
})

it('shows one chip when every repository shares the branch and base', () => {
  const branches = [branch('api', 'dev'), branch('web', 'dev')]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  const chips = document.querySelectorAll('[data-branch-chip="branch"]')
  expect(chips).toHaveLength(1)
  expect(chips[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('arc/fix-order-sync ← dev')
})

it('shows a chip per repository when the base differs, and Read only chips', () => {
  const branches = [
    branch('api', 'dev'),
    branch('web', 'main'),
    branch('docs', null, { branchName: null, readOnly: true })
  ]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  const chips = [...document.querySelectorAll('[data-branch-chip="branch"]')].map((c) =>
    c.textContent?.replace(/\s+/g, ' ').trim()
  )
  expect(chips).toEqual(['api arc/fix-order-sync ← dev', 'web arc/fix-order-sync ← main'])
  const readOnly = document.querySelectorAll('[data-branch-chip="read-only"]')
  expect(readOnly).toHaveLength(1)
  expect(readOnly[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('docs Read only')
})

it('shows a removed project as Removed, in words, and not as a branch', () => {
  const branches = [branch('api', 'dev'), branch('web', 'dev', { removed: true })]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  const removed = document.querySelectorAll('[data-branch-chip="removed"]')
  expect(removed).toHaveLength(1)
  expect(removed[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('web Removed')
  const branchChips = [...document.querySelectorAll('[data-branch-chip="branch"]')]
  expect(branchChips).toHaveLength(1)
  expect(branchChips[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('arc/fix-order-sync ← dev')
})

it('shows no chips before any branch exists', () => {
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn() })
  expect(document.querySelectorAll('[data-branch-chip]')).toHaveLength(0)
})

it('Enter saves a rename; Escape cancels', async () => {
  activeSession.setSnapshot({
    header,
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  })
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn() })
  await fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
  let input = screen.getByLabelText('Session name')
  await fireEvent.input(input, { target: { value: 'Discarded' } })
  await fireEvent.keyDown(input, { key: 'Escape' })
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.getByText('Old name')).toBeTruthy()

  await fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
  input = screen.getByLabelText('Session name')
  await fireEvent.input(input, { target: { value: 'New name' } })
  await fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:rename', { sessionId: 's1', name: 'New name' })
  )
  await waitFor(() => expect(activeSession.header?.name).toBe('New name'))
})

it('RingLogo spins by default and not when spinning is false', () => {
  const a = render(RingLogo)
  expect(a.container.querySelector('svg')?.getAttribute('data-spin')).toBe('true')
  cleanup()
  const b = render(RingLogo, { spinning: false })
  expect(b.container.querySelector('svg')?.hasAttribute('data-spin')).toBe(false)
})
