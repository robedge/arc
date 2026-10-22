import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import type { Result } from '../../src/shared/errors'
import { mockHarness } from './helpers'

let reply: Result<unknown>
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  reply = { ok: true, data: { messageId: 1 } }
  invoke = mockHarness(() => reply)
  providers.reset()
  activeSession.close()
  activeSession.sessionId = 's1'
  activeSession.setDraft('s1', '')
})
afterEach(cleanup)

const sent = () => invoke.mock.calls.filter(([channel]) => channel === 'sessions:send-message')
const box = () => screen.getByLabelText('Message to the brain') as HTMLTextAreaElement

it('Enter sends and clears; Shift+Enter does not send', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'hello' } })
  await fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
  expect(sent()).toHaveLength(0)
  await fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:send-message', { sessionId: 's1', text: 'hello' })
  )
  await waitFor(() => expect(box().value).toBe(''))
})

it('does not send during IME composition', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'konnichiwa' } })
  await fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
  expect(sent()).toHaveLength(0)
})

it('disables Send for whitespace', async () => {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.input(box(), { target: { value: '   ' } })
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
})

it('shows Stop instead of Send while thinking and calls stop-reply', async () => {
  render(Composer, { sessionId: 's1', brainState: 'thinking' })
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(invoke).toHaveBeenCalledWith('sessions:stop-reply', { sessionId: 's1' })
})

it('keeps Send enabled and hides Stop while the brain waits on the user', async () => {
  render(Composer, { sessionId: 's1', brainState: 'waiting' })
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  await fireEvent.input(box(), { target: { value: 'use two workers instead' } })
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  await fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:send-message', {
      sessionId: 's1',
      text: 'use two workers instead'
    })
  )
})

it('keeps the draft and shows the CLI banner on CLI_UNAVAILABLE', async () => {
  reply = { ok: false, error: { code: 'CLI_UNAVAILABLE' } }
  providers.set({
    claude: {
      provider: 'claude',
      checkedAt: 1,
      state: 'missing',
      message: 'Claude Code is missing.'
    }
  })
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: 'keep me' } })
  await fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('Claude Code is missing.')).toBeTruthy())
  expect(box().value).toBe('keep me')
  expect(activeSession.draftFor('s1')).toBe('keep me')
})
