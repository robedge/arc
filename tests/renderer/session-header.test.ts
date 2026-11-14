// @spec: 013-session-branches-on-demand
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import RingLogo from '../../src/renderer/src/lib/components/ui/RingLogo.svelte'
import { knowledgeSuggestions } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { SessionHeader as Header } from '../../src/shared/types/session'
import { mockArc } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Old name',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let invoke: ReturnType<typeof mockArc>
beforeEach(() => {
  invoke = mockArc(() => ({
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

const bare = (projectId: string) => branch(projectId, null, { branchName: null, baseBranch: null })
const chipTexts = (): string[] =>
  [...document.querySelectorAll('[data-branch-chip="branch"]')].map(
    (c) => c.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  )
const names = (n: number): string[] =>
  ['api', 'web', 'docs', 'billing', 'search', 'mail', 'auth', 'jobs', 'infra'].slice(0, n)
const countButton = (): HTMLElement | null => document.querySelector('[data-popover-list] button')

it('1 of 9 shows the api chip and 8 more projects', () => {
  const branches = [branch('api', 'dev'), ...names(9).slice(1).map(bare)]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  expect(chipTexts()).toEqual(['api arc/fix-order-sync ← dev'])
  expect(countButton()?.textContent?.replace(/\s+/g, ' ').trim()).toBe('8 more projects')
})

it('0 of 9 shows only the count, 9 projects', () => {
  render(SessionHeader, {
    header: { ...header, branches: names(9).map(bare) },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect(chipTexts()).toEqual([])
  expect(countButton()?.textContent?.trim()).toBe('9 projects')
})

it('3 of 9 lists three named chips and 6 more projects', () => {
  const all = names(9)
  const branches = [...all.slice(0, 3).map((n) => branch(n, 'dev')), ...all.slice(3).map(bare)]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  expect(chipTexts()).toHaveLength(3)
  expect(chipTexts()[2]).toBe('docs arc/fix-order-sync ← dev')
  expect(countButton()?.textContent?.trim()).toBe('6 more projects')
})

it('all 9 with the same label shows the single chip and no count', () => {
  const branches = names(9).map((n) => branch(n, 'dev'))
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  expect(chipTexts()).toEqual(['arc/fix-order-sync ← dev'])
  expect(countButton()).toBeNull()
})

it('singular counts: 1 more project and 1 project', () => {
  render(SessionHeader, {
    header: { ...header, branches: [branch('api', 'dev'), bare('web')] },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect(countButton()?.textContent?.trim()).toBe('1 more project')
  cleanup()
  render(SessionHeader, {
    header: { ...header, branches: [bare('web')] },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect(countButton()?.textContent?.trim()).toBe('1 project')
})

it('does not count read only or removed projects', () => {
  const branches = [
    branch('api', 'dev'),
    bare('web'),
    branch('docs', null, { branchName: null, readOnly: true }),
    branch('old', null, { branchName: null, removed: true })
  ]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  expect(countButton()?.textContent?.trim()).toBe('1 more project')
  expect(document.querySelectorAll('[data-branch-chip="read-only"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-branch-chip="removed"]')).toHaveLength(1)
})

it('opening the count lists the unbranched project names', async () => {
  const branches = [branch('api', 'dev'), bare('web'), bare('docs')]
  render(SessionHeader, { header: { ...header, branches }, groupName: 'Team', onback: vi.fn() })
  await fireEvent.click(countButton() as HTMLElement)
  const list = screen.getByRole('list', { name: 'Projects without a session branch' })
  expect([...list.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
    'web',
    'docs'
  ])
})

it('updates live when a project gets its branch', async () => {
  const view = render(SessionHeader, {
    header: { ...header, branches: [branch('api', 'dev'), bare('web')] },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect(countButton()?.textContent?.trim()).toBe('1 more project')
  await view.rerender({
    header: { ...header, branches: [branch('api', 'dev'), branch('web', 'dev')] },
    groupName: 'Team',
    onback: vi.fn()
  })
  expect(countButton()).toBeNull()
  expect(chipTexts()).toEqual(['arc/fix-order-sync ← dev'])
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
    knowledgeSuggestions: [],
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

const suggestion = (id: string) => ({
  id,
  sessionId: 's1',
  kind: 'new' as const,
  title: `Title ${id}`,
  reason: 'Why.',
  sectionId: 'sec',
  sectionName: 'Notes',
  target: { itemId: null, name: 'Service map.md', relPath: null },
  text: 'body',
  createdAt: 1
})

it('shows the Suggestions chip with waiting suggestions and opens the dialog', async () => {
  knowledgeSuggestions.reset()
  knowledgeSuggestions.setSnapshot('s1', [suggestion('a'), suggestion('b'), suggestion('c')])
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn() })
  const chip = screen.getByRole('button', { name: 'Knowledge suggestions, 3 waiting' })
  expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('Suggestions 3')
  expect(screen.queryByRole('button', { name: /Needs attention/ })).toBeNull()
  await fireEvent.click(chip)
  expect(screen.getByRole('dialog', { name: 'Knowledge suggestions' })).toBeTruthy()
  knowledgeSuggestions.reset()
})

it('shows no Suggestions chip at zero, and a waiting request adds no header button', () => {
  knowledgeSuggestions.reset()
  activeSession.attention = [
    {
      id: 'p1',
      kind: 'permission',
      route: 'queue',
      from: 'W1',
      action: 'x',
      reason: 'y',
      tool: 't'
    }
  ] as never
  render(SessionHeader, { header, groupName: 'Team', onback: vi.fn() })
  expect(document.querySelector('[data-knowledge-suggestions-chip]')).toBeNull()
  expect(screen.queryByRole('button', { name: /Needs attention/ })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  activeSession.attention = []
})
