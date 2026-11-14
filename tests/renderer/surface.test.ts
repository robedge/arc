// The generic surface renderer, and the brain-message adapter that sends its actions.
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import SurfaceView from '../../src/renderer/src/lib/components/surface/SurfaceView.svelte'
import { resolveContext, surfaceSchema, type SurfaceAction } from '../../src/shared/surface'
import type { SessionMessage } from '../../src/shared/types/session'
import triage from '../fixtures/surface/claude-triage.json'
import { mockArc } from './helpers'

afterEach(cleanup)

it('draws the surface and sends the action with the edited values', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { messageId: 9 } }))
  const message: SessionMessage = {
    id: 8,
    sessionId: 's1',
    role: 'system',
    content: 'Panel: triage',
    state: 'complete',
    planId: null,
    prompt: { kind: 'surface', surface: surfaceSchema.parse(triage) },
    createdAt: 1,
    updatedAt: 1
  }
  render(MessageBubble, { message })

  expect(screen.getByText('Triage: login timeout')).toBeTruthy()
  expect(screen.queryByText('Panel: triage')).toBeNull()
  const assignee = screen.getByLabelText<HTMLInputElement>('Assignee')
  expect(assignee.value).toBe('dana')
  await fireEvent.input(assignee, { target: { value: 'lee' } })
  await fireEvent.click(screen.getByLabelText('Mark as urgent'))
  await fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))

  await waitFor(() => expect(invoke).toHaveBeenCalled())
  const [channel, request] = invoke.mock.calls[0] as [string, { sessionId: string; text: string }]
  expect(channel).toBe('sessions:send-message')
  expect(request.sessionId).toBe('s1')
  expect(JSON.parse(request.text.replace('[Surface action] ', ''))).toEqual({
    surfaceId: 'triage',
    name: 'create_issue',
    label: 'Create issue',
    sourceComponentId: 'create',
    context: { assignee: 'lee', urgent: true }
  })
  await waitFor(() => expect(screen.getByText('Last sent: Create issue')).toBeTruthy())
  // The panel stays usable: a second click sends again.
  await fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
})

it('draws a bar chart from the data model', () => {
  mockArc(() => ({ ok: true, data: {} }))
  const surface = surfaceSchema.parse({
    surfaceId: 'c',
    dataModel: {
      days: [
        { label: '11-11', value: 27 },
        { label: '11-12', value: 13 }
      ]
    },
    components: [
      {
        id: 'root',
        component: 'BarChart',
        data: { '@path': '/days' },
        orientation: 'horizontal',
        unit: 'commits'
      }
    ]
  })
  const message: SessionMessage = {
    id: 3,
    sessionId: 's1',
    role: 'system',
    content: 'Panel: c',
    state: 'complete',
    planId: null,
    prompt: { kind: 'surface', surface },
    createdAt: 1,
    updatedAt: 1
  }
  render(MessageBubble, { message })
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
    '11-11: 27 commits, 11-12: 13 commits'
  )
  expect(screen.getByText('13 commits')).toBeTruthy()
})

it('shows a panel click as what was clicked, not as JSON', () => {
  const message: SessionMessage = {
    id: 5,
    sessionId: 's1',
    role: 'user',
    state: 'complete',
    planId: null,
    createdAt: 1,
    updatedAt: 1,
    content:
      '[Surface action] {"surfaceId":"c","name":"commit_details","label":"Show details","sourceComponentId":"b","context":{"query":"a6f1ce2","empty":""}}'
  }
  render(MessageBubble, { message })
  expect(screen.getByText('Show details')).toBeTruthy()
  expect(screen.getByText('a6f1ce2')).toBeTruthy()
  expect(screen.queryByText(/surfaceId/)).toBeNull()
  expect(screen.queryByText(/empty/)).toBeNull()
})

const form = surfaceSchema.parse({
  surfaceId: 'f',
  dataModel: { name: 'dana', tags: ['a'] },
  components: [
    { id: 'root', component: 'Column', children: ['name', 'go'] },
    { id: 'name', component: 'TextField', label: 'Name', value: { '@path': '/name' } },
    { id: 'goText', component: 'Text', text: 'Go' },
    {
      id: 'go',
      component: 'Button',
      child: 'goText',
      action: {
        event: {
          name: 'go',
          context: {
            who: { '@path': '/name' },
            tags: { '@path': '/tags' },
            gone: { '@path': '/nope' },
            lit: 3
          }
        }
      }
    }
  ]
})

it('hands onAction plain resolved values and shows nothing on success', async () => {
  const onAction = vi.fn(async (a: SurfaceAction): Promise<string | null> => (a ? null : null))
  render(SurfaceView, { surface: form, idPrefix: 'p', onAction })
  await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'lee' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Go' }))
  await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
  const action = onAction.mock.calls[0]![0]
  expect(action).toEqual({
    surfaceId: 'f',
    name: 'go',
    label: 'Go',
    sourceComponentId: 'go',
    context: { who: 'lee', tags: ['a'], gone: null, lit: 3 }
  })
  expect(JSON.stringify(action)).toBe(structuredClone(JSON.stringify(action)))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('disables the button while busy and ignores a second click', async () => {
  let release: (v: string | null) => void = () => {}
  const onAction = vi.fn(() => new Promise<string | null>((r) => (release = r)))
  render(SurfaceView, { surface: form, idPrefix: 'p', onAction })
  const button = screen.getByRole('button', { name: 'Go' })
  await fireEvent.click(button)
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
  await fireEvent.click(button)
  expect(onAction).toHaveBeenCalledTimes(1)
  release(null)
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull())
})

it('shows a returned error text', async () => {
  render(SurfaceView, { surface: form, idPrefix: 'p', onAction: async () => 'No longer waiting.' })
  await fireEvent.click(screen.getByRole('button', { name: 'Go' }))
  await waitFor(() => expect(screen.getByText('No longer waiting.')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Go' }).getAttribute('aria-busy')).toBeNull()
})

it('shows the generic message when onAction throws', async () => {
  render(SurfaceView, {
    surface: form,
    idPrefix: 'p',
    onAction: async () => {
      throw new Error('boom')
    }
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Go' }))
  await waitFor(() =>
    expect(screen.getByText('Could not send the answer. Try again.')).toBeTruthy()
  )
})

it('resets the model only when the surface JSON changes', async () => {
  const onAction = async (): Promise<string | null> => null
  const view = render(SurfaceView, { surface: form, idPrefix: 'p', onAction })
  const input = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Name')
  await fireEvent.input(input(), { target: { value: 'lee' } })
  // Same JSON in a new object: the typed value stays.
  await view.rerender({ surface: JSON.parse(JSON.stringify(form)) })
  expect(input().value).toBe('lee')
  // Different JSON: back to the surface's own value.
  const changed = JSON.parse(JSON.stringify(form))
  changed.dataModel.name = 'sam'
  await view.rerender({ surface: changed })
  await waitFor(() => expect(input().value).toBe('sam'))
})

it('warns about an unknown component in development', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const surface = surfaceSchema.parse({
    surfaceId: 'u',
    components: [{ id: 'root', component: 'Mystery' }]
  })
  render(SurfaceView, { surface, idPrefix: 'p', onAction: async () => null })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mystery'))
  warn.mockRestore()
})

it('resolveContext copies values and maps absent paths to null', () => {
  const model = { a: { b: [1] } }
  const out = resolveContext(model, { x: { '@path': '/a/b' }, y: { '@path': '/z' }, z: 'lit' })
  expect(out).toEqual({ x: [1], y: null, z: 'lit' })
  expect(out['x']).not.toBe(model.a.b)
})
