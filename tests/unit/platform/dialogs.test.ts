import { describe, expect, it, vi } from 'vitest'
import { createDialogs } from '../../../src/main/platform/dialogs'
import type { E2eHook } from '../../../src/main/platform/dialogs'

const native = vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['/native'] }))

describe('dialogs E2E stub', () => {
  it('returns queued responses in order, null when empty, and records calls', async () => {
    const target: { __e2e?: E2eHook } = {}
    const d = createDialogs({ HARNESS_E2E: '1' }, native, target)
    target.__e2e?.queueOpenDialog(['/a', '/b'])
    target.__e2e?.queueOpenDialog(null)
    target.__e2e?.queueOpenDialog(['/c'])
    expect(await d.pickFolders({ multi: true })).toEqual(['/a', '/b'])
    expect(await d.pickFiles({ multi: false })).toBeNull()
    expect(await d.pickSaveFolder()).toBe('/c')
    expect(await d.pickFolders({ multi: false })).toBeNull()
    expect(target.__e2e?.getDialogCalls().map((c) => c.kind)).toEqual([
      'pickFolders',
      'pickFiles',
      'pickSaveFolder',
      'pickFolders'
    ])
    expect(native).not.toHaveBeenCalled()
  })

  it('installs no hook and uses native dialogs without HARNESS_E2E', async () => {
    const target: { __e2e?: E2eHook } = {}
    const d = createDialogs({}, native, target)
    expect(target.__e2e).toBeUndefined()
    expect(await d.pickFolders({ multi: false })).toEqual(['/native'])
  })
})
