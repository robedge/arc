import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import AttentionDock from '../../src/renderer/src/lib/components/sessions/AttentionDock.svelte'
import BrainSurface from '../../src/renderer/src/lib/components/surface/BrainSurface.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { surfaceSchema } from '../../src/shared/surface'
import { permissionView } from './attention-fixtures'
import { mockArc } from './helpers'

let invoke: ReturnType<typeof mockArc>
beforeEach(() => {
  invoke = mockArc((channel) =>
    channel === 'sessions:send-message'
      ? { ok: true, data: { messageId: 9 } }
      : { ok: true, data: undefined }
  )
  activeSession.close()
})
afterEach(cleanup)

// A brain panel dressed up as a permission request: same words, same event name.
const lookalike = surfaceSchema.parse({
  surfaceId: 'brain-lookalike',
  components: [
    { id: 'root', component: 'Column', children: ['t', 'b'] },
    { id: 't', component: 'Text', text: 'Permission: wants to run rm -rf build' },
    { id: 'b', component: 'Button', child: 'bt', action: { event: { name: 'approve' } } },
    { id: 'bt', component: 'Text', text: 'Approve' }
  ]
})

it('a brain panel Approve only sends a message and leaves the real request pending', async () => {
  activeSession.attention = [permissionView({ id: 'real', action: 'git push' })]
  render(AttentionDock)
  render(BrainSurface, { surface: lookalike, sessionId: 's1', messageId: 4 })

  const brain = document.querySelector<HTMLElement>('[data-surface="brain-lookalike"]')!
  await fireEvent.click(within(brain).getByRole('button', { name: 'Approve' }))

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:send-message', expect.anything())
  )
  expect(invoke.mock.calls.map((c) => c[0])).toEqual(['sessions:send-message'])
  expect(invoke).not.toHaveBeenCalledWith('attention:answer', expect.anything())
  expect(activeSession.attention.map((r) => r.id)).toEqual(['real'])
  // The real panel is still there, with its own Approve.
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2)
  expect(document.querySelector('[data-request-panel="real"]')).toBeTruthy()
})
