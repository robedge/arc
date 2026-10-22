import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { itemDraft, AUTOSAVE_DELAY_MS } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import type { Result } from '../../src/shared/errors'
import { mockHarness } from './helpers'

type Handler = (channel: string, request: unknown) => Result<unknown> | Promise<Result<unknown>>

function setup(save?: Handler): ReturnType<typeof mockHarness> {
  return mockHarness((channel, request) => {
    if (channel === 'items:read') {
      const { itemId } = request as { itemId: string }
      return { ok: true, data: { type: 'text', content: `body-${itemId}`, revision: 'r0' } }
    }
    if (channel === 'items:save' && save) return save(channel, request)
    return { ok: true, data: { revision: 'r1' } }
  })
}

const saves = (invoke: ReturnType<typeof mockHarness>): unknown[][] =>
  invoke.mock.calls.filter((c) => c[0] === 'items:save')

beforeEach(async () => {
  vi.useFakeTimers()
  itemDraft.discard()
})
afterEach(() => {
  vi.useRealTimers()
})

it('edits within 600 ms produce exactly one save after the delay', async () => {
  const invoke = setup()
  await itemDraft.open('a')
  expect(itemDraft.text).toBe('body-a')
  itemDraft.edit('one')
  await vi.advanceTimersByTimeAsync(400)
  itemDraft.edit('one two')
  await vi.advanceTimersByTimeAsync(400)
  expect(saves(invoke)).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
  expect(saves(invoke)).toEqual([
    ['items:save', { itemId: 'a', content: 'one two', baseRevision: 'r0' }]
  ])
  expect(itemDraft.lastSavedRevision).toBe('r1')
})

it('flush saves immediately', async () => {
  const invoke = setup()
  await itemDraft.open('a')
  itemDraft.edit('x')
  await itemDraft.flush()
  expect(saves(invoke)).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(saves(invoke)).toHaveLength(1)
})

it('switching items flushes the previous one first', async () => {
  const invoke = setup()
  await itemDraft.open('a')
  itemDraft.edit('changed')
  await itemDraft.open('b')
  expect(saves(invoke)).toEqual([
    ['items:save', { itemId: 'a', content: 'changed', baseRevision: 'r0' }]
  ])
  expect(itemDraft.itemId).toBe('b')
  expect(itemDraft.text).toBe('body-b')
})

it('status goes saving then saved', async () => {
  let release: (r: Result<unknown>) => void = () => {}
  setup(() => new Promise((resolve) => (release = resolve)))
  await itemDraft.open('a')
  itemDraft.edit('x')
  const pending = itemDraft.flush()
  await vi.advanceTimersByTimeAsync(0)
  expect(itemDraft.status).toBe('saving')
  release({ ok: true, data: { revision: 'r1' } })
  await pending
  expect(itemDraft.status).toBe('saved')
  expect(itemDraft.dirty).toBe(false)
})

it('EXTERNAL_MODIFIED keeps the text and stops autosave', async () => {
  const invoke = setup(() => ({ ok: false, error: { code: 'EXTERNAL_MODIFIED' } }))
  await itemDraft.open('a')
  itemDraft.edit('mine')
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
  expect(itemDraft.status).toBe('conflict')
  expect(itemDraft.text).toBe('mine')
  itemDraft.edit('mine more')
  await vi.advanceTimersByTimeAsync(5000)
  expect(saves(invoke)).toHaveLength(1)
  expect(itemDraft.text).toBe('mine more')
})
