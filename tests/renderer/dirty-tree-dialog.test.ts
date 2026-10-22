import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import DirtyTreeDialog from '../../src/renderer/src/lib/components/sessions/DirtyTreeDialog.svelte'
import { mockHarness } from './helpers'

afterEach(cleanup)

const repos = [
  { projectId: 'api', name: 'api', files: ['a.ts', 'b.ts'], fileCount: 12 },
  { projectId: 'web', name: 'web', files: ['c.svelte'], fileCount: 1 }
]

function setup() {
  const invoke = mockHarness(() => ({ ok: true, data: { status: 'ready', sessionId: 's1' } }))
  const onresolved = vi.fn()
  render(DirtyTreeDialog, { token: 't1', repos, onresolved })
  return { invoke, onresolved }
}

it('lists each repository with its changed files and the three choices, none selected', () => {
  setup()
  expect(screen.getByText('a.ts')).toBeTruthy()
  expect(screen.getByText('and 10 more')).toBeTruthy()
  expect(screen.getAllByLabelText(/Set aside/)).toHaveLength(2)
  expect(screen.getAllByLabelText(/Commit them first/)).toHaveLength(2)
  expect(screen.getAllByLabelText(/Bring them along/)).toHaveLength(2)
  for (const radio of screen.getAllByRole('radio')) {
    expect((radio as HTMLInputElement).checked).toBe(false)
  }
})

it('requires a choice for every repository before continuing', async () => {
  const { invoke } = setup()
  await fireEvent.click(screen.getAllByLabelText(/Set aside/)[0] as HTMLElement)
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(screen.getAllByText('Choose what to do with these changes.')).toHaveLength(1)
  expect(invoke).not.toHaveBeenCalled()
})

it('sends the choices once every repository has one', async () => {
  const { invoke, onresolved } = setup()
  await fireEvent.click(screen.getAllByLabelText(/Set aside/)[0] as HTMLElement)
  await fireEvent.click(screen.getAllByLabelText(/Bring them along/)[1] as HTMLElement)
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(onresolved).toHaveBeenCalled())
  expect(invoke).toHaveBeenCalledWith('sessions:resolve-dirty', {
    token: 't1',
    choices: { api: 'stash', web: 'carry' }
  })
})

it('Cancel answers cancel for every repository', async () => {
  const invoke = mockHarness(() => ({ ok: true, data: { status: 'cancelled' } }))
  const onresolved = vi.fn()
  render(DirtyTreeDialog, { token: 't1', repos, onresolved })
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(onresolved).toHaveBeenCalledWith({ status: 'cancelled' }))
  expect(invoke).toHaveBeenCalledWith('sessions:resolve-dirty', {
    token: 't1',
    choices: { api: 'cancel', web: 'cancel' }
  })
})
