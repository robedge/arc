import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { err, ok } from '@shared/errors'
import type { Result } from '@shared/errors'
import type { StorageState } from '@shared/types/storage'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

const APP: StorageState = {
  mode: 'app',
  linkedPath: null,
  keptAside: false,
  available: true,
  hasKnowledge: true
}
const LINKED: StorageState = { ...APP, mode: 'linked', linkedPath: '/Users/me/kb' }

beforeEach(() => {
  groups.list = [{ id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 1 }]
  ui.selectGroup(null)
  ui.openDialog({ kind: 'group-delete', groupId: 'a' })
})
afterEach(cleanup)

function host(state: StorageState, extra: (channel: string) => Result<unknown> | undefined) {
  return mockHarness((channel) => {
    const custom = extra(channel)
    if (custom) return custom
    if (channel === 'storage:get') return ok(state)
    return ok(undefined)
  })
}

async function exportButton(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: 'Export knowledge first' })
}

describe('Export knowledge first', () => {
  it('a cancelled pick changes nothing', async () => {
    const invoke = host(APP, (c) =>
      c === 'storage:pickExportFolder' ? ok({ picked: false }) : undefined
    )
    render(DialogHost)
    await fireEvent.click(await exportButton())
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:pickExportFolder', { groupId: 'a' })
    )
    expect(invoke).not.toHaveBeenCalledWith('storage:export', expect.anything())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Exported/)).toBeNull()
  })

  it('a blocked folder shows the mapped message and does not export', async () => {
    const invoke = host(APP, (c) =>
      c === 'storage:pickExportFolder'
        ? ok({ picked: true, path: '/x', blocked: 'inside-other-group', token: null })
        : undefined
    )
    render(DialogHost)
    await fireEvent.click(await exportButton())
    expect((await screen.findByRole('alert')).textContent).toContain(
      "another group's knowledge folder"
    )
    expect(invoke).not.toHaveBeenCalledWith('storage:export', expect.anything())
  })

  it('success shows the path and count, returns to the confirm step, and deletes nothing', async () => {
    const invoke = host(APP, (c) => {
      if (c === 'storage:pickExportFolder')
        return ok({ picked: true, path: '/out', blocked: null, token: 't1' })
      if (c === 'storage:export') return ok({ count: 12, path: '/out/Alpha-knowledge' })
      return undefined
    })
    render(DialogHost)
    await fireEvent.click(await exportButton())
    expect(await screen.findByText('Exported 12 files to /out/Alpha-knowledge')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('storage:export', { groupId: 'a', token: 't1' })
    expect(invoke).not.toHaveBeenCalledWith('groups:delete', expect.anything())
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('a failed export shows the error and stays on the confirm step', async () => {
    const invoke = host(APP, (c) => {
      if (c === 'storage:pickExportFolder')
        return ok({ picked: true, path: '/out', blocked: null, token: 't1' })
      if (c === 'storage:export') return err('EXPORT_FAILED')
      return undefined
    })
    render(DialogHost)
    await fireEvent.click(await exportButton())
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't export the knowledge"
    )
    expect(screen.queryByText(/Exported/)).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('groups:delete', expect.anything())
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('disables Delete, Cancel and the button while exporting', async () => {
    let release: (r: Result<unknown>) => void = () => {}
    const pending = new Promise<Result<unknown>>((resolve) => (release = resolve))
    mockHarness((channel) => {
      if (channel === 'storage:get') return ok(APP)
      if (channel === 'storage:pickExportFolder')
        return ok({ picked: true, path: '/out', blocked: null, token: 't1' })
      if (channel === 'storage:export') return pending
      return ok(undefined)
    })
    render(DialogHost)
    await fireEvent.click(await exportButton())
    const disabled = (name: string) =>
      (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
    await waitFor(() => expect(disabled('Delete')).toBe(true))
    expect(disabled('Cancel')).toBe(true)
    expect(disabled('Export knowledge first')).toBe(true)
    release(ok({ count: 1, path: '/out/Alpha-knowledge' }))
    await waitFor(() => expect(disabled('Delete')).toBe(false))
    expect(disabled('Cancel')).toBe(false)
  })

  it('a linked group has no export button and says the folder is kept', async () => {
    host(LINKED, () => undefined)
    render(DialogHost)
    expect(await screen.findByText(/linked knowledge folder will not be deleted/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Export knowledge first' })).toBeNull()
  })
})
