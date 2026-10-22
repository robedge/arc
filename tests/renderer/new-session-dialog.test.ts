import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import NewSessionDialog from '../../src/renderer/src/lib/components/sessions/NewSessionDialog.svelte'
import { mockHarness } from './helpers'

afterEach(cleanup)

it('shows the required message and creates nothing when the request is empty', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: { sessionId: 's1' } }))
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated: vi.fn() })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  expect(screen.getByText('Enter a request for the brain.')).toBeTruthy()
  expect(invoke).not.toHaveBeenCalled()
})

it('defaults to Plan-first and a limit of 3, and sends the payload', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: { sessionId: 's1' } }))
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  expect((screen.getByLabelText(/Plan-first/) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Worker limit') as HTMLSelectElement).value).toBe('3')
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Fix the bug' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(oncreated).toHaveBeenCalledWith('s1'))
  expect(invoke).toHaveBeenCalledWith('sessions:create', {
    groupId: 'g1',
    request: 'Fix the bug',
    mode: 'plan_first',
    workerLimit: 3
  })
})

it('asks about unsaved changes before creating, and Cancel returns to the form with nothing started', async () => {
  const invoke = mockHarness((channel) =>
    channel === 'sessions:create'
      ? {
          ok: true,
          data: {
            needsDirtyChoice: {
              token: 't1',
              repos: [{ projectId: 'api', name: 'api', files: ['a.ts'], fileCount: 1 }]
            }
          }
        }
      : { ok: true, data: { status: 'cancelled' } }
  )
  const oncreated = vi.fn()
  render(NewSessionDialog, { groupId: 'g1', onclose: vi.fn(), oncreated })
  await fireEvent.input(screen.getByLabelText('Request'), { target: { value: 'Fix it' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeTruthy())
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.getByLabelText('Request')).toBeTruthy())
  expect((screen.getByLabelText('Request') as HTMLTextAreaElement).value).toBe('Fix it')
  expect(invoke).toHaveBeenCalledWith('sessions:resolve-dirty', {
    token: 't1',
    choices: { api: 'cancel' }
  })
  expect(oncreated).not.toHaveBeenCalled()
})
