import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import GroupSidebar from '../../src/renderer/src/lib/components/shell/GroupSidebar.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

beforeEach(() => {
  groups.list = [
    { id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 1 },
    { id: 'b', name: 'Beta', createdAt: 2, updatedAt: 2 }
  ]
  ui.closeDialog()
  ui.selectGroup(null)
})
afterEach(cleanup)

it('lists groups from the store and selects on click', async () => {
  mockHarness(() => ({ ok: true, data: [] }))
  render(GroupSidebar)
  expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
  expect(ui.selectedGroupId).toBe('b')
})

it('opens the create dialog from New Group', async () => {
  render(GroupSidebar)
  await fireEvent.click(screen.getByRole('button', { name: 'New Group' }))
  expect(ui.dialog).toEqual({ kind: 'group-create' })
})

it('marks only the selected group row with hud-row data-selected', async () => {
  mockHarness(() => ({ ok: true, data: [] }))
  ui.selectGroup('a')
  render(GroupSidebar)
  const alpha = screen.getByRole('button', { name: 'Alpha' })
  const beta = screen.getByRole('button', { name: 'Beta' })
  expect(alpha.classList.contains('hud-row')).toBe(true)
  expect(alpha.getAttribute('data-selected')).toBe('true')
  expect(beta.getAttribute('data-selected')).toBe('false')
  expect(
    screen.getAllByRole('button', { name: 'Group options' })[0]!.getAttribute('aria-label')
  ).toBe('Group options')
})

it('hands focus back to the Group options button before a menu choice opens a dialog', async () => {
  render(GroupSidebar)
  const trigger = screen.getAllByRole('button', { name: 'Group options' })[0]!
  await fireEvent.click(trigger)
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  // The menu item unmounts with the menu; a dialog opened from it must restore focus to the trigger.
  expect(document.activeElement).toBe(trigger)
  expect(ui.dialog).toEqual({ kind: 'group-rename', groupId: 'a' })
})
