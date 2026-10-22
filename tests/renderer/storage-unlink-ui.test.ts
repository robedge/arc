import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { err, ok } from '@shared/errors'
import type { StorageState } from '@shared/types/storage'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import GroupView from '../../src/renderer/src/lib/components/shell/GroupView.svelte'
import KnowledgeStorageSettings from '../../src/renderer/src/lib/components/settings/KnowledgeStorageSettings.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
import { storage } from '../../src/renderer/src/lib/stores/storage.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

const LINKED: StorageState = {
  mode: 'linked',
  linkedPath: '/Users/me/kb',
  keptAside: false,
  available: true,
  hasKnowledge: true
}
const APP: StorageState = { ...LINKED, mode: 'app', linkedPath: null }
const MISSING: StorageState = { ...LINKED, available: false, hasKnowledge: false }

const SECTIONS = [
  {
    id: 's1',
    groupId: 'g',
    kind: 'projects',
    name: 'Projects',
    builtIn: true,
    itemCount: 0,
    sortOrder: 0
  },
  {
    id: 's2',
    groupId: 'g',
    kind: 'notes',
    name: 'Notes',
    builtIn: true,
    itemCount: 0,
    sortOrder: 1
  }
]

function host(state: StorageState, extra: (channel: string) => unknown = () => undefined) {
  return mockHarness((channel) => {
    const custom = extra(channel)
    if (custom !== undefined) return custom as never
    if (channel === 'storage:get') return ok(state)
    if (channel === 'sections:list') return ok(SECTIONS)
    if (channel === 'projects:list' || channel === 'items:list') return ok([])
    return ok(undefined)
  })
}

async function mountSettings(state: StorageState): Promise<void> {
  groupDetail.groupId = 'g'
  render(KnowledgeStorageSettings, { groupId: 'g' })
  render(DialogHost)
  await storage.load('g')
  storage.state = state
}

beforeEach(() => {
  ui.closeDialog()
  storage.groupId = null
  storage.state = null
  storage.opGroupId = null
  storage.progress = null
  storage.error = null
  storage.pending = null
  toasts.list = []
})
afterEach(cleanup)

describe('UnlinkDialog', () => {
  it('without kept-aside knowledge shows a simple confirm and sends keep-current', async () => {
    const invoke = host(LINKED, (c) => (c === 'storage:unlink' ? ok(APP) : undefined))
    await mountSettings(LINKED)
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink folder' }))
    const dialog = screen.getByRole('dialog', { name: 'Unlink folder' })
    expect(dialog.querySelector('input[type="radio"]')).toBeNull()
    expect(dialog.textContent).toContain('The folder itself and its files are not changed.')
    await fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.type === 'submit') as HTMLElement
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:unlink', {
        groupId: 'g',
        choice: 'keep-current'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(storage.state?.mode).toBe('app')
  })

  it('with kept-aside knowledge offers both choices and warns Keep current discards', async () => {
    const kept = { ...LINKED, keptAside: true }
    const invoke = host(kept, (c) => (c === 'storage:unlink' ? ok(APP) : undefined))
    await mountSettings(kept)
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink folder' }))
    const keep = screen.getByLabelText(/Keep current knowledge/) as HTMLInputElement
    const restore = screen.getByLabelText(/Restore earlier in-app knowledge/) as HTMLInputElement
    expect(keep.checked).toBe(true)
    expect(
      screen.getByText(/earlier in-app knowledge that was kept aside is discarded/)
    ).toBeTruthy()
    await fireEvent.click(restore)
    const dialog = screen.getByRole('dialog')
    await fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.type === 'submit') as HTMLElement
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:unlink', {
        groupId: 'g',
        choice: 'restore-kept'
      })
    )
  })

  it('Cancel closes without invoking and a failure stays in the dialog', async () => {
    const invoke = host(LINKED, (c) =>
      c === 'storage:unlink' ? err('KNOWLEDGE_ROOT_MISSING') : undefined
    )
    await mountSettings(LINKED)
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink folder' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('storage:unlink', expect.anything())
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink folder' }))
    const dialog = screen.getByRole('dialog')
    await fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.type === 'submit') as HTMLElement
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('settings has no Unlink button when stored in the app or the folder is missing', async () => {
    host(APP)
    await mountSettings(APP)
    expect(screen.queryByRole('button', { name: 'Unlink folder' })).toBeNull()
    storage.state = MISSING
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlink folder' })).toBeNull())
  })
})

describe('StorageMissingBanner in GroupView', () => {
  function mountView(state: StorageState) {
    groups.list = [{ id: 'g', name: 'Shop' } as never]
    ui.selectedGroupId = 'g'
    const invoke = host(state, (c) => {
      if (c === 'storage:locate')
        return ok({ located: true, state: LINKED, looksLikeKnowledge: false })
      if (c === 'storage:useAppStorage') return ok(APP)
      return undefined
    })
    render(GroupView)
    render(DialogHost)
    return invoke
  }

  it('shows the banner, disables section nav, and keeps Projects as the pane', async () => {
    mountView(MISSING)
    expect(await screen.findByText('Knowledge folder not found')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Locate…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use app storage' })).toBeTruthy()
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(3))
    for (const tab of screen.getAllByRole('tab'))
      expect((tab as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Add Section' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Unlink folder' })).toBeNull()
  })

  it('Locate relinks, warns when the folder does not look right, and hides the banner', async () => {
    const invoke = mountView(MISSING)
    await fireEvent.click(await screen.findByRole('button', { name: 'Locate…' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('storage:locate', { groupId: 'g' }))
    await waitFor(() => expect(screen.queryByText('Knowledge folder not found')).toBeNull())
    await waitFor(() =>
      expect(
        toasts.list.some((t) => /doesn't look like this group's knowledge/.test(t.message))
      ).toBe(true)
    )
    expect((screen.getAllByRole('tab')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('a cancelled Locate changes nothing', async () => {
    const invoke = host(MISSING, (c) =>
      c === 'storage:locate' ? ok({ located: false }) : undefined
    )
    groups.list = [{ id: 'g', name: 'Shop' } as never]
    ui.selectedGroupId = 'g'
    render(GroupView)
    await fireEvent.click(await screen.findByRole('button', { name: 'Locate…' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('storage:locate', { groupId: 'g' }))
    expect(screen.getByText('Knowledge folder not found')).toBeTruthy()
    expect(toasts.list).toEqual([])
  })

  it('Use app storage says plainly it starts empty, then switches', async () => {
    const invoke = mountView(MISSING)
    await fireEvent.click(await screen.findByRole('button', { name: 'Use app storage' }))
    const dialog = screen.getByRole('dialog', { name: 'Use app storage' })
    expect(dialog.textContent).toContain('start with empty knowledge')
    await fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.type === 'submit') as HTMLElement
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:useAppStorage', { groupId: 'g' })
    )
    await waitFor(() => expect(screen.queryByText('Knowledge folder not found')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Use app storage with kept-aside knowledge says it restores it', async () => {
    mountView({ ...MISSING, keptAside: true })
    await fireEvent.click(await screen.findByRole('button', { name: 'Use app storage' }))
    expect(screen.getByRole('dialog').textContent).toContain('will be restored')
  })
})

describe('availability:changed for the knowledge root', () => {
  it('shows then hides the banner and ignores other groups and project events', async () => {
    let current = LINKED
    mockHarness((c) => {
      if (c === 'storage:get') return ok(current)
      if (c === 'sections:list') return ok(SECTIONS)
      return ok([])
    })
    groups.list = [{ id: 'g', name: 'Shop' } as never]
    ui.selectedGroupId = 'g'
    render(GroupView)
    await waitFor(() => expect(storage.state).not.toBeNull())
    expect(screen.queryByText('Knowledge folder not found')).toBeNull()

    storage.applyAvailability({ groupId: 'other', knowledgeRoot: true, available: false })
    storage.applyAvailability({ groupId: 'g', projectId: 'p', available: false })
    expect(storage.missing).toBe(false)

    current = MISSING
    storage.applyAvailability({ groupId: 'g', knowledgeRoot: true, available: false })
    expect(await screen.findByText('Knowledge folder not found')).toBeTruthy()

    current = LINKED
    storage.applyAvailability({ groupId: 'g', knowledgeRoot: true, available: true })
    await waitFor(() => expect(screen.queryByText('Knowledge folder not found')).toBeNull())
  })
})
