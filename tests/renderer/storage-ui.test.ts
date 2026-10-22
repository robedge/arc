import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { err, ok } from '@shared/errors'
import type { StoragePickResult, StorageState } from '@shared/types/storage'
import DialogHost from '../../src/renderer/src/lib/components/dialogs/DialogHost.svelte'
import KnowledgeStorageSettings from '../../src/renderer/src/lib/components/settings/KnowledgeStorageSettings.svelte'
import { groupDetail } from '../../src/renderer/src/lib/stores/group-detail.svelte'
import { storage } from '../../src/renderer/src/lib/stores/storage.svelte'
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

function picked(
  over: Partial<Extract<StoragePickResult, { picked: true }>> = {}
): StoragePickResult {
  return {
    picked: true,
    path: '/Users/me/kb',
    blocked: null,
    token: 'tok',
    hasKnowledge: true,
    targetHasContent: false,
    insideProjectRepo: null,
    ...over
  }
}

function host(over: { pick?: StoragePickResult; link?: () => unknown; state?: StorageState } = {}) {
  return mockHarness((channel) => {
    if (channel === 'storage:get') return ok(over.state ?? APP)
    if (channel === 'storage:pickFolder') return ok(over.pick ?? picked())
    if (channel === 'storage:link') return (over.link?.() as never) ?? ok(LINKED)
    if (channel === 'sections:list' || channel === 'projects:list') return ok([])
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
  storage.repoNote = null
  storage.pending = null
})
afterEach(cleanup)

describe('KnowledgeStorageSettings', () => {
  it('shows "Stored in app" with Link folder and Show in Finder for an app group', async () => {
    host()
    await mountSettings(APP)
    expect(await screen.findByText('Stored in app')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Link folder…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show in Finder' })).toBeTruthy()
  })

  it('shows the linked path and hides Link folder when linked', async () => {
    host({ state: LINKED })
    await mountSettings(LINKED)
    expect(await screen.findByText('/Users/me/kb')).toBeTruthy()
    expect(screen.queryByText('Stored in app')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Link folder…' })).toBeNull()
  })

  it('reveals the group knowledge root', async () => {
    const invoke = host()
    await mountSettings(APP)
    await fireEvent.click(await screen.findByRole('button', { name: 'Show in Finder' }))
    expect(invoke).toHaveBeenCalledWith('shell:reveal', { groupId: 'g' })
  })

  it('links immediately with "move" and no dialog when the group has no knowledge', async () => {
    const invoke = host({ pick: picked({ hasKnowledge: false }) })
    await mountSettings({ ...APP, hasKnowledge: false })
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:link', {
        groupId: 'g',
        token: 'tok',
        choice: 'move'
      })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('/Users/me/kb')).toBeTruthy()
  })

  it('does nothing when the picker is cancelled', async () => {
    const invoke = host({ pick: { picked: false } })
    await mountSettings(APP)
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('storage:pickFolder', { groupId: 'g' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('maps a blocked folder to a message and never links', async () => {
    const invoke = host({ pick: picked({ blocked: 'inside-app-storage', token: null }) })
    await mountSettings(APP)
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    expect((await screen.findByRole('alert')).textContent).toContain("Arc's own storage")
    expect(invoke).not.toHaveBeenCalledWith('storage:link', expect.anything())
  })

  it('maps a link failure through messageFor when no dialog is open', async () => {
    host({ pick: picked({ hasKnowledge: false }), link: () => err('STORAGE_TARGET_NOT_WRITABLE') })
    await mountSettings({ ...APP, hasKnowledge: false })
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Arc can't write to that folder. Choose a different folder."
    )
  })

  it('shows progress and disables the buttons while an operation runs', async () => {
    let release: (v: unknown) => void = () => {}
    const gate = new Promise((r) => (release = r))
    host({ pick: picked({ hasKnowledge: false }), link: () => gate })
    await mountSettings({ ...APP, hasKnowledge: false })
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    await waitFor(() => expect(storage.busy).toBe(true))
    storage.handleProgress({ groupId: 'g', phase: 'copying', done: 3, total: 10 })
    expect(await screen.findByText(/Copying files/)).toBeTruthy()
    expect(screen.getByText('(3 of 10)')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Link folder…' }) as HTMLButtonElement).disabled
    ).toBe(true)
    storage.handleProgress({ groupId: 'other', phase: 'verifying', done: 0, total: 0 })
    expect(screen.queryByText(/Verifying/)).toBeNull()
    storage.handleProgress({ groupId: 'g', phase: 'rolling-back', done: 0, total: 10 })
    expect(await screen.findByText(/Rolling back/)).toBeTruthy()
    release(ok(LINKED))
    await waitFor(() => expect(storage.busy).toBe(false))
  })

  it('names the project in a repo note after linking without a dialog', async () => {
    host({
      pick: picked({
        hasKnowledge: false,
        insideProjectRepo: { projectId: 'p', projectName: 'orders-api' }
      })
    })
    await mountSettings({ ...APP, hasKnowledge: false })
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    expect((await screen.findByText(/orders-api/)).textContent).toContain(
      'changes in that repository'
    )
  })
})

describe('LinkFolderDialog', () => {
  async function openDialog(pick: StoragePickResult, link?: () => unknown) {
    const invoke = host({ pick, link })
    await mountSettings(APP)
    await fireEvent.click(await screen.findByRole('button', { name: 'Link folder…' }))
    await screen.findByRole('dialog')
    return invoke
  }

  it('is shown when the group has knowledge, with a consequence per option', async () => {
    await openDialog(picked())
    expect(screen.getByLabelText(/Move existing knowledge here/)).toBeTruthy()
    expect(screen.getByLabelText(/Use the folder's contents only/)).toBeTruthy()
    expect(screen.getByText(/nothing is overwritten/)).toBeTruthy()
    expect(screen.getByText(/kept aside/)).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('warns, naming the project, when the folder is inside a project repo', async () => {
    await openDialog(picked({ insideProjectRepo: { projectId: 'p', projectName: 'orders-api' } }))
    expect(screen.getByRole('note').textContent).toContain("'orders-api'")
  })

  it('sends the chosen option and closes on success', async () => {
    const invoke = await openDialog(picked())
    await fireEvent.click(screen.getByLabelText(/Use the folder's contents only/))
    await fireEvent.click(screen.getByRole('button', { name: 'Link folder' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('storage:link', {
        groupId: 'g',
        token: 'tok',
        choice: 'folder-only'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('defaults to move', async () => {
    const invoke = await openDialog(picked())
    await fireEvent.click(screen.getByRole('button', { name: 'Link folder' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'storage:link',
        expect.objectContaining({ choice: 'move' })
      )
    )
  })

  it('disables controls and shows progress while running, then the mapped error', async () => {
    let fail: (v: unknown) => void = () => {}
    const gate = new Promise((r) => (fail = r))
    await openDialog(picked(), () => gate)
    await fireEvent.click(screen.getByRole('button', { name: 'Link folder' }))
    await waitFor(() => expect(storage.busy).toBe(true))
    storage.handleProgress({ groupId: 'g', phase: 'copying', done: 1, total: 4 })
    expect(await screen.findByText('(1 of 4)')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(
      (screen.getByRole('button', { name: 'Link folder' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fail(err('STORAGE_KEPT_ASIDE_EXISTS'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('already kept aside')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('Cancel closes without linking', async () => {
    const invoke = await openDialog(picked())
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('storage:link', expect.anything())
  })
})

vi.useRealTimers()
