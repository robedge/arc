import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { err, ok } from '@shared/errors'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

const existing = { id: 'g1', name: 'Storefront', createdAt: 1, updatedAt: 1 }

function open(): void {
  render(DialogHost)
  ui.openDialog({ kind: 'group-create' })
}

async function submitWith(value: string): Promise<void> {
  const input = await screen.findByLabelText('Group name')
  await fireEvent.input(input, { target: { value } })
  await fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

beforeEach(() => {
  groups.list = [existing]
  ui.closeDialog()
  ui.selectGroup(null)
})
afterEach(cleanup)

describe('group create NameDialog', () => {
  it('shows a required message for an empty name', async () => {
    const invoke = mockHarness(() => ok(null))
    open()
    await submitWith('   ')
    expect(await screen.findByText('Group name is required.')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows a length message for 61 characters', async () => {
    const invoke = mockHarness(() => ok(null))
    open()
    await submitWith('a'.repeat(61))
    expect(await screen.findByText('Group name must be 60 characters or fewer.')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows a duplicate message case-insensitively', async () => {
    const invoke = mockHarness(() => ok(null))
    open()
    await submitWith('storefront')
    expect(await screen.findByText('A group with this name already exists.')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows a server GROUP_NAME_DUPLICATE inline', async () => {
    const invoke = mockHarness(() => err('GROUP_NAME_DUPLICATE'))
    open()
    await submitWith('Admin')
    expect(await screen.findByText('A group with this name already exists.')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('groups:create', { name: 'Admin' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('creates a valid group, selects it, and closes', async () => {
    const created = { id: 'g2', name: 'Admin', createdAt: 2, updatedAt: 2 }
    const invoke = mockHarness((channel) =>
      channel === 'groups:create' ? ok(created) : ok([existing, created])
    )
    open()
    await submitWith('Admin')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(invoke).toHaveBeenCalledWith('groups:create', { name: 'Admin' })
    expect(ui.selectedGroupId).toBe('g2')
  })
})
