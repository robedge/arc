import { beforeEach, expect, it, vi } from 'vitest'
import { registerCloseFlush } from '../../src/renderer/src/lib/close-flush'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'

beforeEach(() => itemDraft.discard())

function setup(save: () => Promise<unknown>): {
  invoke: ReturnType<typeof vi.fn>
  fire: () => void
} {
  let listener: (() => void) | undefined
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'items:read') return { ok: true, data: { content: 'x', revision: 'r0' } }
    if (channel === 'items:save') return save()
    return { ok: true, data: undefined }
  })
  Object.defineProperty(window, 'harness', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'app:before-close') listener = cb
        return () => {}
      })
    }
  })
  registerCloseFlush()
  return { invoke, fire: () => listener?.() }
}

it('awaits the save before replying app:close-ready', async () => {
  let finishSave: (v: unknown) => void = () => {}
  const { invoke, fire } = setup(() => new Promise((r) => (finishSave = r)))
  await itemDraft.open('a')
  itemDraft.edit('typed')
  fire()
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('items:save', expect.anything()))
  expect(invoke).not.toHaveBeenCalledWith('app:close-ready', {})
  finishSave({ ok: true, data: { revision: 'r1' } })
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('app:close-ready', {}))
  const channels = invoke.mock.calls.map((c) => c[0])
  expect(channels.indexOf('items:save')).toBeLessThan(channels.indexOf('app:close-ready'))
})

it('still replies when the save throws', async () => {
  const { invoke, fire } = setup(() => Promise.reject(new Error('boom')))
  await itemDraft.open('a')
  itemDraft.edit('typed')
  fire()
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('app:close-ready', {}))
})
