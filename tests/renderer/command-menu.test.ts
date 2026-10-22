import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import { filterCommands } from '../../src/renderer/src/lib/components/sessions/command-filter'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { commands } from '../../src/renderer/src/lib/stores/commands.svelte'
import type { CommandInfo } from '../../src/shared/types/commands'
import type { SessionMessage } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const LIST: CommandInfo[] = [
  {
    id: 'claude:' + 'awos:spec',
    provider: 'claude',
    kind: 'command',
    name: 'awos:spec',
    description: 'Write a spec',
    argumentHint: '<feature>',
    source: 'repo:api'
  },
  {
    id: 'claude:' + 'user:agent-browser',
    provider: 'claude',
    kind: 'command',
    name: 'user:agent-browser',
    description: 'Drive a browser',
    source: 'user'
  },
  {
    id: 'claude:' + 'superpowers:brainstorming',
    provider: 'claude',
    kind: 'command',
    name: 'superpowers:brainstorming',
    description: 'Explore ideas',
    source: 'plugin:superpowers'
  },
  {
    id: 'claude:' + 'fix-lint',
    provider: 'claude',
    kind: 'command',
    name: 'fix-lint',
    description: 'Fix awful lint errors',
    source: 'repo:api'
  }
]

let invoke: ReturnType<typeof mockHarness>
let listReply: () => unknown

beforeEach(() => {
  listReply = () => ({ ok: true, data: LIST })
  invoke = mockHarness((channel) =>
    channel === 'commands:list'
      ? (listReply() as never)
      : ({ ok: true, data: { messageId: 1 } } as never)
  )
  commands.reset()
  activeSession.close()
  activeSession.sessionId = 's1'
  activeSession.setDraft('s1', '')
})
afterEach(cleanup)

const box = () => screen.getByLabelText('Message to the brain') as HTMLTextAreaElement
const sent = () => invoke.mock.calls.filter(([channel]) => channel === 'sessions:send-message')
const names = () =>
  screen.queryAllByRole('option').map((o) => o.querySelector('.font-mono')?.textContent)

async function typeSlash(value: string): Promise<void> {
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await waitFor(() => expect(commands.for('s1').status).toBe('ready'))
  await fireEvent.input(box(), { target: { value } })
}

it('filterCommands: prefix matches first, then substring on name or description, alphabetical', () => {
  const list: CommandInfo[] = [
    {
      id: 'claude:' + 'zeta',
      provider: 'claude',
      kind: 'command',
      name: 'zeta',
      description: 'has a spec inside',
      source: 'user'
    },
    {
      id: 'claude:' + 'my-spec',
      provider: 'claude',
      kind: 'command',
      name: 'my-spec',
      description: '',
      source: 'user'
    },
    {
      id: 'claude:' + 'spec-b',
      provider: 'claude',
      kind: 'command',
      name: 'spec-b',
      description: '',
      source: 'user'
    },
    {
      id: 'claude:' + 'Spec-a',
      provider: 'claude',
      kind: 'command',
      name: 'Spec-a',
      description: '',
      source: 'user'
    },
    {
      id: 'claude:' + 'other',
      provider: 'claude',
      kind: 'command',
      name: 'other',
      description: 'nothing',
      source: 'user'
    }
  ]
  expect(filterCommands(list, 'SPEC').map((c) => c.name)).toEqual([
    'Spec-a',
    'spec-b',
    'my-spec',
    'zeta'
  ])
  expect(filterCommands(list, '').map((c) => c.name)).toEqual([
    'my-spec',
    'other',
    'Spec-a',
    'spec-b',
    'zeta'
  ])
})

it('prefetches on mount and lists matches with badges', async () => {
  await typeSlash('/aw')
  expect(invoke).toHaveBeenCalledWith('commands:list', { sessionId: 's1' })
  // prefix match first, then the description match
  expect(names()).toEqual(['/awos:spec', '/fix-lint'])
  const first = screen.getAllByRole('option')[0]
  expect(first?.textContent).toContain('api')
  await fireEvent.input(box(), { target: { value: '/super' } })
  const option = screen.getByRole('option')
  expect(option.textContent).toContain('Yours')
  expect(option.textContent).toContain('superpowers')
})

it('Enter inserts the command without sending; the argument hint trails it until typing', async () => {
  await typeSlash('/aw')
  await fireEvent.keyDown(box(), { key: 'Enter' })
  expect(box().value).toBe('/awos:spec ')
  expect(sent()).toHaveLength(0)
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.querySelector('[data-argument-hint]')?.textContent).toContain('<feature>')
  await fireEvent.input(box(), { target: { value: '/awos:spec retry' } })
  expect(document.querySelector('[data-argument-hint]')).toBeNull()
})

it('Tab inserts too, and Up/Down wrap while aria-activedescendant follows', async () => {
  await typeSlash('/')
  const options = () => screen.getAllByRole('option') as HTMLElement[]
  const idAt = (i: number) => options()[i]!.id
  expect(options()).toHaveLength(4)
  expect(box().getAttribute('role')).toBe('combobox')
  expect(box().getAttribute('aria-expanded')).toBe('true')
  expect(box().getAttribute('aria-autocomplete')).toBe('list')
  expect(box().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
  expect(box().getAttribute('aria-activedescendant')).toBe(idAt(0))
  await fireEvent.keyDown(box(), { key: 'ArrowUp' })
  expect(box().getAttribute('aria-activedescendant')).toBe(idAt(3))
  expect(options()[3]!.getAttribute('aria-selected')).toBe('true')
  await fireEvent.keyDown(box(), { key: 'ArrowDown' })
  expect(box().getAttribute('aria-activedescendant')).toBe(idAt(0))
  await fireEvent.keyDown(box(), { key: 'ArrowDown' })
  await fireEvent.keyDown(box(), { key: 'Tab' })
  expect(box().value).toBe('/fix-lint ')
})

it('announces the count', async () => {
  await typeSlash('/')
  expect(screen.getByRole('status').textContent).toBe('4 commands')
})

it('Escape closes the list keeping the text until the next input', async () => {
  await typeSlash('/aw')
  await fireEvent.keyDown(box(), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(box().value).toBe('/aw')
  expect(box().getAttribute('aria-expanded')).toBe('false')
  await fireEvent.input(box(), { target: { value: '/awo' } })
  expect(screen.getByRole('listbox')).toBeTruthy()
})

it('with no matches Enter sends normally and the empty state explains', async () => {
  await typeSlash('/zzz')
  expect(screen.getByText('No matching commands', { selector: 'p' })).toBeTruthy()
  expect(screen.getByText('Sent to the brain as a message')).toBeTruthy()
  await fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() =>
    expect(sent()).toEqual([['sessions:send-message', { sessionId: 's1', text: '/zzz' }]])
  )
})

it('shows loading, then an error with Retry that does not block sending', async () => {
  let resolve: (v: unknown) => void = () => {}
  listReply = () => new Promise((r) => (resolve = r)) as never
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await fireEvent.input(box(), { target: { value: '/' } })
  expect(screen.getByText('Loading commands…')).toBeTruthy()
  resolve({ ok: false, error: { code: 'INTERNAL' } })
  await screen.findByRole('button', { name: 'Retry' })
  listReply = () => ({ ok: true, data: LIST })
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4))
})

it('refetches every cached session on commands:changed', async () => {
  await typeSlash('/')
  invoke.mockClear()
  listReply = () => ({ ok: true, data: [LIST[0]] })
  commands.handleChanged()
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  expect(invoke).toHaveBeenCalledWith('commands:list', { sessionId: 's1' })
})

it('MessageBubble highlights a leading /command in user messages only', () => {
  const message = (role: SessionMessage['role'], content: string): SessionMessage =>
    ({
      id: 1,
      sessionId: 's1',
      role,
      content,
      state: 'complete',
      updatedAt: 0
    }) as unknown as SessionMessage
  const { unmount } = render(MessageBubble, { message: message('user', '/awos:spec retry it') })
  const span = document.querySelector('[data-command]')
  expect(span?.textContent).toBe('/awos:spec')
  expect(document.querySelector('p')?.textContent).toBe('/awos:spec retry it')
  unmount()
  render(MessageBubble, { message: message('user', 'see /tmp/x') })
  expect(document.querySelector('[data-command]')).toBeNull()
  vi.restoreAllMocks()
})

const CODEX: CommandInfo[] = [
  {
    id: 'codex:publish-release',
    provider: 'codex',
    kind: 'skill',
    name: 'publish-release',
    description: 'Publish the notes',
    source: 'codex'
  },
  {
    id: 'codex:review',
    provider: 'codex',
    kind: 'prompt',
    name: 'review',
    description: 'Review the diff',
    source: 'codex'
  },
  {
    id: 'claude:review',
    provider: 'claude',
    kind: 'command',
    name: 'review',
    description: 'Review the diff',
    source: 'user'
  }
]

it('marks Codex skills and prompts with a Codex badge and their kind', async () => {
  listReply = () => ({ ok: true, data: [...LIST, ...CODEX] })
  await typeSlash('/pub')
  const option = screen.getByRole('option')
  expect(option.textContent).toContain('/publish-release')
  const badges = [...option.querySelectorAll('[data-badge]')].map((b) => b.textContent)
  expect(badges).toEqual(['Codex', 'skill'])
  expect(screen.getByRole('option', { name: /Codex/ })).toBe(option)
})

it('marks a Cursor command with a Cursor badge and leaves Codex badges unchanged', async () => {
  const cursor: CommandInfo = {
    id: 'cursor:shout',
    provider: 'cursor',
    kind: 'command',
    name: 'shout',
    description: 'Say it loud',
    source: 'cursor'
  }
  listReply = () => ({ ok: true, data: [...LIST, ...CODEX, cursor] })
  await typeSlash('/sh')
  const option = screen.getByRole('option', { name: /\/shout/ })
  const badges = [...option.querySelectorAll('[data-badge]')].map((b) => b.textContent)
  expect(badges).toEqual(['Cursor', 'command'])
  await fireEvent.input(box(), { target: { value: '/pub' } })
  const codex = screen.getByRole('option')
  expect([...codex.querySelectorAll('[data-badge]')].map((b) => b.textContent)).toEqual([
    'Codex',
    'skill'
  ])
})

it('lists a name both providers have twice, each with its own badge', async () => {
  listReply = () => ({ ok: true, data: [...LIST, ...CODEX] })
  await typeSlash('/rev')
  const options = screen.getAllByRole('option')
  expect(options).toHaveLength(2)
  const label = (o: HTMLElement) =>
    [...o.querySelectorAll('[data-badge]')].map((b) => b.textContent).join(' ')
  expect(options.map(label).sort()).toEqual(['Codex prompt', 'Yours'])
  expect(options.filter((o) => /Codex/.test(o.textContent ?? ''))).toHaveLength(1)
})

it('inserts the id for an ambiguous name and the plain name otherwise', async () => {
  listReply = () => ({ ok: true, data: [...LIST, ...CODEX] })
  await typeSlash('/rev')
  const codexOption = screen
    .getAllByRole('option')
    .find((o) => /Codex/.test(o.textContent ?? '')) as HTMLElement
  await fireEvent.click(codexOption)
  expect(box().value).toBe('/codex:review ')
  await fireEvent.input(box(), { target: { value: '/pub' } })
  await fireEvent.keyDown(box(), { key: 'Enter' })
  expect(box().value).toBe('/publish-release ')
})
