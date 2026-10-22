import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SectionNav from '../../src/renderer/src/lib/components/shell/SectionNav.svelte'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import type { Section } from '../../src/shared/types/section'
import { mockHarness } from './helpers'

const BUILT_INS = ['Projects', 'Notes', 'Docs', 'Playbooks', 'Links']

function seed(itemCount = 0): Section[] {
  const built = BUILT_INS.map((name, i): Section => ({
    id: `b${i}`,
    groupId: 'g',
    kind: name.toLowerCase() as Section['kind'],
    name,
    builtIn: true,
    itemCount: 0,
    sortOrder: i
  }))
  return [
    ...built,
    {
      id: 'c1',
      groupId: 'g',
      kind: 'custom',
      name: 'Runbooks',
      builtIn: false,
      itemCount,
      sortOrder: 100
    }
  ]
}

beforeEach(() => {
  ui.closeDialog()
  ui.selectedGroupId = 'g'
  ui.selectSection(null)
  groupDetail.groupId = 'g'
  groupDetail.sections = seed(3)
})
afterEach(cleanup)

function harness(): ReturnType<typeof mockHarness> {
  return mockHarness((channel) => {
    if (channel === 'sections:list') return { ok: true, data: groupDetail.sections }
    return { ok: true, data: { removed: 3 } }
  })
}

it('renders Sessions then the 5 built-in tabs in order, with options only on the custom one', () => {
  groupDetail.sections = seed().slice(0, 5)
  render(SectionNav)
  const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim())
  expect(tabs).toEqual(['Sessions', ...BUILT_INS])
  expect(screen.queryAllByRole('button', { name: 'Section options' })).toHaveLength(0)
  expect(screen.getByRole('tab', { name: 'Sessions' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected')).toBe('false')
})

it('a custom section follows the built-ins and has an options button', () => {
  render(SectionNav)
  const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim())
  expect(tabs).toEqual(['Sessions', ...BUILT_INS, 'Runbooks'])
  expect(screen.getAllByRole('button', { name: 'Section options' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Add Section' })).toBeTruthy()
})

async function openAdd(): Promise<HTMLInputElement> {
  render(SectionNav)
  render(DialogHost)
  await fireEvent.click(screen.getByRole('button', { name: 'Add Section' }))
  return screen.getByLabelText('Section name') as HTMLInputElement
}

it.each([
  ['runbooks', 'A section with this name already exists in this group.'],
  ['Docs', 'A section with this name already exists in this group.'],
  ['x'.repeat(41), 'Section name must be 1–40 characters.'],
  ['   ', 'Section name must be 1–40 characters.']
])('Add Section with %j shows the validation message', async (value, message) => {
  const invoke = harness()
  const input = await openAdd()
  await fireEvent.input(input, { target: { value } })
  await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByText(message)).toBeTruthy()
  expect(invoke).not.toHaveBeenCalledWith('sections:create', expect.anything())
})

it('delete dialog states the item count and Cancel does not invoke', async () => {
  const invoke = harness()
  render(SectionNav)
  render(DialogHost)
  await fireEvent.click(screen.getByRole('button', { name: 'Section options' }))
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(screen.getByText("Delete 'Runbooks' and its 3 items?")).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('delete dialog is a plain confirm for an empty section and Delete invokes', async () => {
  const invoke = harness()
  groupDetail.sections = seed(0)
  ui.selectSection('c1')
  render(SectionNav)
  render(DialogHost)
  await fireEvent.click(screen.getByRole('button', { name: 'Section options' }))
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(screen.getByText("Delete 'Runbooks'?")).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('sections:delete', { sectionId: 'c1' }))
  await waitFor(() => expect(ui.selectedSectionId).toBeNull())
})

it('hands focus back to the Section options button before a menu choice opens a dialog', async () => {
  harness()
  render(SectionNav)
  const trigger = screen.getByRole('button', { name: 'Section options' })
  await fireEvent.click(trigger)
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  expect(document.activeElement).toBe(trigger)
})
