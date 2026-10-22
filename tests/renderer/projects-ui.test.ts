import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import ProjectRow from '../../src/renderer/src/lib/components/sections/ProjectRow.svelte'
import ProjectsSection from '../../src/renderer/src/lib/components/sections/ProjectsSection.svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import Toaster from '../../src/renderer/src/lib/components/ui/Toaster.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { Project } from '../../src/shared/types/project'
import { mockHarness } from './helpers'

const NOT_GIT = 'Not a git repository — read-only in sessions'

function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'alpha', path: '/x/alpha', isGit: true, available: true, ...over }
}

beforeEach(() => {
  vi.useRealTimers()
  ui.closeDialog()
  groupDetail.groupId = 'g'
  groupDetail.sections = []
  groupDetail.projects = []
  toasts.list = []
})
afterEach(cleanup)

it('ProjectRow shows the not-git label only when isGit is false', () => {
  const { unmount } = render(ProjectRow, { project: project({ isGit: true }) })
  expect(screen.getByText('alpha')).toBeTruthy()
  expect(screen.getByText('/x/alpha')).toBeTruthy()
  expect(screen.queryByText(NOT_GIT)).toBeNull()
  unmount()
  render(ProjectRow, { project: project({ isGit: false, available: false }) })
  expect(screen.getByText(NOT_GIT)).toBeTruthy()
})

it('Add Project invokes projects:pick for the group', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: { added: [], skipped: [] } }))
  render(ProjectsSection)
  expect(screen.getByText('Add a project folder or drag one here')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Add Project' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('projects:pick', { groupId: 'g' }))
})

function dropFiles(target: Element, files: File[]): void {
  fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } })
}

it('dropping files reads each path synchronously and invokes projects:add', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: { added: [], skipped: [] } }))
  const getPath = window.harness.getPathForFile as ReturnType<typeof vi.fn>
  getPath.mockImplementation((f: File) => `/dropped/${f.name}`)
  render(ProjectsSection)
  const files = [new File([], 'one'), new File([], 'two')]
  const zone = screen.getByRole('region')
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  zone.dispatchEvent(event)
  // Read synchronously: already called before any await.
  expect(getPath).toHaveBeenCalledTimes(2)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('projects:add', {
      groupId: 'g',
      paths: ['/dropped/one', '/dropped/two']
    })
  )
  expect(event.defaultPrevented).toBe(true)
})

it('a skipped not-directory path shows a toast', async () => {
  mockHarness(() => ({
    ok: true,
    data: { added: [], skipped: [{ path: '/f.txt', code: 'PROJECT_NOT_DIRECTORY' }] }
  }))
  window.harness.getPathForFile = vi.fn(() => '/f.txt')
  render(ProjectsSection)
  render(Toaster)
  dropFiles(screen.getByRole('region'), [new File([], 'f.txt')])
  expect(await screen.findByText('Only folders can be added as projects.')).toBeTruthy()
})

async function openRemove(): Promise<ReturnType<typeof mockHarness>> {
  const invoke = mockHarness((channel) =>
    channel === 'projects:list'
      ? { ok: true, data: [] }
      : channel === 'sections:list'
        ? { ok: true, data: [] }
        : { ok: true, data: undefined }
  )
  groupDetail.projects = [project()]
  render(ProjectsSection)
  render(DialogHost)
  await fireEvent.click(screen.getByRole('button', { name: 'Remove project' }))
  expect(
    screen.getByText("Remove 'alpha' from this group? The folder on disk won't be changed.")
  ).toBeTruthy()
  return invoke
}

it('remove confirm Cancel does not invoke', async () => {
  const invoke = await openRemove()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('remove confirm Remove invokes projects:remove', async () => {
  const invoke = await openRemove()
  await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('projects:remove', { groupId: 'g', projectId: 'p1' })
  )
})

function emitterHarness(handler: Parameters<typeof mockHarness>[0]): {
  invoke: ReturnType<typeof mockHarness>
  emit: (payload: unknown) => void
} {
  const invoke = mockHarness(handler)
  let cb: (p: unknown) => void = () => {}
  window.harness.on = vi.fn((_n: string, fn: (p: unknown) => void) => {
    cb = fn
    return () => {}
  }) as never
  return { invoke, emit: (p) => cb(p) }
}

it('availability:changed flips a loaded project to Folder not found with Locate and Remove', async () => {
  groupDetail.projects = [project()]
  const { emit } = emitterHarness(() => ({ ok: true, data: [] }))
  window.harness.on('availability:changed', (e) => groupDetail.applyAvailability(e))
  render(ProjectsSection)
  expect(screen.queryByText('Folder not found')).toBeNull()
  emit({ groupId: 'g', projectId: 'p1', available: false })
  expect(await screen.findByText('Folder not found')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Locate…' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
})

it('availability:changed for another group is ignored', async () => {
  groupDetail.projects = [project()]
  const { emit } = emitterHarness(() => ({ ok: true, data: [] }))
  window.harness.on('availability:changed', (e) => groupDetail.applyAvailability(e))
  render(ProjectsSection)
  emit({ groupId: 'other', projectId: 'p1', available: false })
  await Promise.resolve()
  expect(screen.queryByText('Folder not found')).toBeNull()
  expect(groupDetail.projects[0]?.available).toBe(true)
})

it('Locate invokes projects:relocate and the row is available again', async () => {
  groupDetail.projects = [project({ available: false })]
  const invoke = mockHarness((channel) => {
    if (channel === 'projects:relocate')
      return { ok: true, data: project({ path: '/x/moved', name: 'moved' }) }
    if (channel === 'projects:list')
      return { ok: true, data: [project({ path: '/x/moved', name: 'moved' })] }
    return { ok: true, data: [] }
  })
  render(ProjectsSection)
  await fireEvent.click(screen.getByRole('button', { name: 'Locate…' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('projects:relocate', { groupId: 'g', projectId: 'p1' })
  )
  expect(await screen.findByText('/x/moved')).toBeTruthy()
  expect(screen.queryByText('Folder not found')).toBeNull()
})

it('selecting a group invokes groups:open with its id', () => {
  const invoke = mockHarness(() => ({ ok: true, data: [] }))
  ui.selectGroup('g7')
  expect(invoke).toHaveBeenCalledWith('groups:open', { groupId: 'g7' })
  ui.selectGroup(null)
})
