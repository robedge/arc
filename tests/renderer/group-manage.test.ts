import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import GroupSidebar from '../../src/renderer/src/lib/components/shell/GroupSidebar.svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

const seed = [
  { id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 1 },
  { id: 'b', name: 'Beta', createdAt: 2, updatedAt: 2 }
]

beforeEach(() => {
  groups.list = [...seed]
  ui.closeDialog()
  ui.selectGroup(null)
})
afterEach(cleanup)

function harness(): ReturnType<typeof mockHarness> {
  return mockHarness((channel, request) => {
    if (channel === 'groups:list') return { ok: true, data: groups.list }
    if (channel === 'groups:rename') {
      const { groupId, name } = request as { groupId: string; name: string }
      groups.list = groups.list.map((g) => (g.id === groupId ? { ...g, name } : g))
      return { ok: true, data: groups.list.find((g) => g.id === groupId) }
    }
    if (channel === 'groups:delete') {
      const { groupId } = request as { groupId: string }
      groups.list = groups.list.filter((g) => g.id !== groupId)
      return { ok: true, data: undefined }
    }
    return { ok: true, data: undefined }
  })
}

async function openMenuItem(rowIndex: number, item: string): Promise<void> {
  const buttons = screen.getAllByRole('button', { name: 'Group options' })
  await fireEvent.click(buttons[rowIndex]!)
  await fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

it('rename rejects a duplicate of another group', async () => {
  const invoke = harness()
  render(GroupSidebar)
  render(DialogHost)
  await openMenuItem(0, 'Rename')
  const input = screen.getByLabelText('Group name') as HTMLInputElement
  expect(input.value).toBe('Alpha')
  await fireEvent.input(input, { target: { value: 'beta' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  expect(screen.getByText('A group with this name already exists.')).toBeTruthy()
  expect(invoke).not.toHaveBeenCalledWith('groups:rename', expect.anything())
})

it('rename to own name in different case is allowed', async () => {
  const invoke = harness()
  render(GroupSidebar)
  render(DialogHost)
  await openMenuItem(0, 'Rename')
  await fireEvent.input(screen.getByLabelText('Group name'), { target: { value: 'ALPHA' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('groups:rename', { groupId: 'a', name: 'ALPHA' })
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('button', { name: 'ALPHA' })).toBeTruthy()
})

it('menu closes on Escape', async () => {
  harness()
  render(GroupSidebar)
  await fireEvent.click(screen.getAllByRole('button', { name: 'Group options' })[0]!)
  const menu = screen.getByRole('menu')
  expect(within(menu).getByRole('menuitem', { name: 'Delete Group' })).toBeTruthy()
  await fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
})

it('delete confirmation states folders are untouched; Cancel does not invoke', async () => {
  const invoke = harness()
  render(GroupSidebar)
  render(DialogHost)
  await openMenuItem(0, 'Delete Group')
  expect(screen.getByText(/Your project folders will not be touched\./)).toBeTruthy()
  invoke.mockClear()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
})

it('Delete invokes groups:delete, removes the row and clears selection', async () => {
  const invoke = harness()
  ui.selectGroup('a')
  render(GroupSidebar)
  render(DialogHost)
  await openMenuItem(0, 'Delete Group')
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('groups:delete', { groupId: 'a' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull())
  await waitFor(() => expect(ui.selectedGroupId).toBeNull())
})
