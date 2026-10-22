import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import ProjectRow from '../../src/renderer/src/lib/components/sections/ProjectRow.svelte'
import ProjectsSection from '../../src/renderer/src/lib/components/sections/ProjectsSection.svelte'
import GroupView from '../../src/renderer/src/lib/components/shell/GroupView.svelte'
import StorageProgress from '../../src/renderer/src/lib/components/settings/StorageProgress.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { Project } from '../../src/shared/types/project'
import { mockHarness } from './helpers'

function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'alpha', path: '/x/alpha', isGit: true, available: true, ...over }
}

beforeEach(() => {
  ui.closeDialog()
  groupDetail.projects = []
  groupDetail.sections = []
  groups.list = []
  ui.selectedGroupId = null
})
afterEach(cleanup)

it('shows "Folder not found" with an error icon and word', () => {
  const { container } = render(ProjectRow, { project: project({ available: false }) })
  const state = container.querySelector('[data-project-state="missing"]')!
  expect(state.textContent?.trim()).toBe('Folder not found')
  expect(state.querySelector('[data-icon="error"]')).not.toBeNull()
  expect(state.className).toContain('text-danger')
})

it('shows "Not a git repository" with a warning icon and word', () => {
  const { container } = render(ProjectRow, { project: project({ isGit: false }) })
  const state = container.querySelector('[data-project-state="not-git"]')!
  expect(state.textContent?.trim()).toBe('Not a git repository — read-only in sessions')
  expect(state.querySelector('[data-icon="warning"]')).not.toBeNull()
  expect(state.className).toContain('text-attention')
  expect(container.querySelector('[data-project-state="missing"]')).toBeNull()
})

it('the empty projects list shows a muted state with an icon', () => {
  mockHarness(() => ({ ok: true, data: [] }))
  const { container } = render(ProjectsSection)
  const empty = container.querySelector('[data-empty-state]')!
  expect(empty.textContent?.trim()).toBe('Add a project folder or drag one here')
  expect(empty.querySelector('svg')).not.toBeNull()
})

it('with no group, GroupView shows the empty state', () => {
  mockHarness(() => ({ ok: true, data: null }))
  const { container } = render(GroupView)
  expect(container.querySelector('[data-empty-state]')?.textContent?.trim()).toBe(
    'Create a group to get started.'
  )
})

it('StorageProgress is a progressbar with aria values and a mono percentage', () => {
  const { container } = render(StorageProgress, {
    progress: { phase: 'copying', done: 3, total: 10 }
  })
  const bar = screen.getByRole('progressbar', { name: 'Storage progress' })
  expect(bar.getAttribute('aria-valuemin')).toBe('0')
  expect(bar.getAttribute('aria-valuemax')).toBe('10')
  expect(bar.getAttribute('aria-valuenow')).toBe('3')
  expect((container.querySelector('[data-progress-fill]') as HTMLElement).style.width).toBe('30%')
  expect(screen.getByText('30%').className).toContain('font-mono')
  expect(screen.getByText('(3 of 10)')).toBeTruthy()
})

it('StorageProgress separates the phase label from the file count with a space', () => {
  const { container } = render(StorageProgress, {
    progress: { phase: 'copying', done: 3, total: 10 }
  })
  expect(
    container.querySelector('[role="status"] span')?.textContent?.replace(/\u00a0/g, ' ')
  ).toBe('Copying files (3 of 10)')
})
