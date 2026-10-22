import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { ok } from '@shared/errors'
import type { StorageState } from '@shared/types/storage'
import GroupView from '../../src/renderer/src/lib/components/shell/GroupView.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { groups } from '../../src/renderer/src/lib/stores/groups.svelte'
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
const MISSING: StorageState = {
  ...APP,
  mode: 'linked',
  linkedPath: '/kb',
  available: false,
  hasKnowledge: false
}

function mount(state: StorageState): void {
  mockHarness((channel) => {
    if (channel === 'storage:get') return ok(state)
    if (channel === 'sessions:list' || channel === 'sections:list' || channel === 'projects:list')
      return ok([])
    return ok(undefined)
  })
  groups.list = [{ id: 'g', name: 'Shop' } as never]
  ui.selectedGroupId = 'g'
  render(GroupView)
}

beforeEach(() => {
  activeSession.close()
  storage.groupId = null
  storage.state = null
})
afterEach(() => {
  cleanup()
  activeSession.close()
})

it('shows the full group header on the Sessions list', async () => {
  mount(APP)
  expect(await screen.findByRole('heading', { name: 'Shop', level: 2 })).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Link folder…' })).toBeTruthy())
})

it('collapses the group heading and storage row while a session is open', async () => {
  activeSession.sessionId = 's1'
  mount(APP)
  await waitFor(() => expect(storage.state).not.toBeNull())
  expect(screen.queryByRole('heading', { name: 'Shop', level: 2 })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Link folder…' })).toBeNull()
  expect(screen.getAllByRole('tab').length).toBeGreaterThan(0)
})

it('keeps the storage-missing banner (and the full header) when storage is missing', async () => {
  activeSession.sessionId = 's1'
  mount(MISSING)
  expect(await screen.findByText('Knowledge folder not found')).toBeTruthy()
})
