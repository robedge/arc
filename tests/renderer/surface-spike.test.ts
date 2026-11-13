// SPIKE (A2UI), throwaway: the surface a real Claude turn produced, drawn and clicked.
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import { surfaceSchema } from '../../src/shared/surface'
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
    dataModel: { days: [{ label: '11-11', value: 27 }, { label: '11-12', value: 13 }] },
    components: [{ id: 'root', component: 'BarChart', data: { '@path': '/days' }, orientation: 'horizontal', unit: 'commits' }]
  })
  const message: SessionMessage = {
    id: 3, sessionId: 's1', role: 'system', content: 'Panel: c', state: 'complete', planId: null,
    prompt: { kind: 'surface', surface }, createdAt: 1, updatedAt: 1
  }
  render(MessageBubble, { message })
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('11-11: 27 commits, 11-12: 13 commits')
  expect(screen.getByText('13 commits')).toBeTruthy()
})

it('shows a panel click as what was clicked, not as JSON', () => {
  const message: SessionMessage = {
    id: 5, sessionId: 's1', role: 'user', state: 'complete', planId: null, createdAt: 1, updatedAt: 1,
    content: '[Surface action] {"surfaceId":"c","name":"commit_details","label":"Show details","sourceComponentId":"b","context":{"query":"a6f1ce2","empty":""}}'
  }
  render(MessageBubble, { message })
  expect(screen.getByText('Show details')).toBeTruthy()
  expect(screen.getByText('a6f1ce2')).toBeTruthy()
  expect(screen.queryByText(/surfaceId/)).toBeNull()
  expect(screen.queryByText(/empty/)).toBeNull()
})
