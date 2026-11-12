import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openKnowledgeItem } from '../../src/renderer/src/lib/navigate-knowledge'
import { knowledgeSuggestions } from '../../src/renderer/src/lib/stores/knowledge-suggestions.svelte'
import { leaveGuard } from '../../src/renderer/src/lib/stores/leave-guard.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockArc } from './helpers'

const target = { groupId: 'g2', sectionId: 'sec2', itemId: 'i2' }

beforeEach(() => {
  mockArc(() => ({ ok: true, data: [] }))
  ui.selectGroup('g1')
  ui.view = 'settings'
  knowledgeSuggestions.setSnapshot('s1', [])
  knowledgeSuggestions.open()
})
afterEach(() => {
  vi.restoreAllMocks()
  knowledgeSuggestions.reset()
  ui.view = 'main'
})

it('selects group, section and item, shows the main view and closes the dialog', async () => {
  await openKnowledgeItem(target)
  expect(ui.selectedGroupId).toBe('g2')
  expect(ui.selectedSectionId).toBe('sec2')
  expect(ui.selectedItemId).toBe('i2')
  expect(ui.view).toBe('main')
  expect(knowledgeSuggestions.dialogOpen).toBe(false)
})

it('does not reselect the group already shown', async () => {
  await openKnowledgeItem({ ...target, groupId: 'g1' })
  expect(ui.selectedGroupId).toBe('g1')
  expect(ui.selectedSectionId).toBe('sec2')
  expect(ui.selectedItemId).toBe('i2')
})

it('respects a leave-guard refusal: nothing moves and a toast says why', async () => {
  vi.spyOn(leaveGuard, 'proceed').mockResolvedValue(false)
  const show = vi.spyOn(toasts, 'show')
  await openKnowledgeItem(target)
  expect(ui.selectedGroupId).toBe('g1')
  expect(ui.selectedItemId).toBeNull()
  expect(ui.view).toBe('settings')
  expect(show).toHaveBeenCalledWith(expect.stringContaining('unsaved'), 'warning')
})
