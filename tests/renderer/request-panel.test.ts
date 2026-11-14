import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte'
import RequestPanel from '../../src/renderer/src/lib/components/sessions/RequestPanel.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { toasts } from '../../src/renderer/src/lib/stores/toasts.svelte'
import type { AttentionView } from '../../src/shared/types/session'
import { branchView, permissionView, questionView, type QuestionSpec } from './attention-fixtures'
import { mockArc } from './helpers'

const tokens = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')

let invoke: ReturnType<typeof mockArc>
beforeEach(() => {
  invoke = mockArc(() => ({ ok: true, data: undefined }))
  activeSession.close()
  toasts.list = []
})
afterEach(cleanup)

const panel = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-request-panel="${id}"]`)!

const command = permissionView({
  id: 'cmd',
  from: 'W1 api-retry · via brain',
  action: 'git push origin arc/fix-order-sync',
  reason: 'Pushes the worker branch.'
})
const mcp = permissionView({
  id: 'mcp',
  from: 'W2 order-sync · via brain',
  action: 'mcp',
  tool: { kind: 'mcp', server: 'sample-tracker', tool: 'create_issue', args: { title: 'x' } }
})
const access = permissionView({
  id: 'acc',
  from: 'W3 web-fix · via brain',
  action: 'permissions',
  tool: {
    kind: 'permissions',
    reason: 'Needs the cache folder.',
    read: ['/sample/cache'],
    write: ['/sample/out'],
    network: true
  }
})

const buttonNames = (el: HTMLElement): string[] =>
  within(el)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')

it('a command request: frame, kind label, from line, code body and three buttons', () => {
  render(RequestPanel, { request: command })
  const el = panel('cmd')
  expect(el.tagName).toBe('ARTICLE')
  expect(el.getAttribute('data-kind')).toBe('permission')
  expect(el.getAttribute('aria-label')).toBe('Permission request from W1 api-retry · via brain')
  expect(el.className).toContain('border-attention/55')
  expect(within(el).getByText('Permission')).toBeTruthy()
  expect(within(el).getByText('W1 api-retry · via brain')).toBeTruthy()
  expect(within(el).getByText('Wants to run')).toBeTruthy()
  expect(within(el).getByText('git push origin arc/fix-order-sync')).toBeTruthy()
  expect(within(el).getByText('Pushes the worker branch.')).toBeTruthy()
  expect(buttonNames(el)).toEqual(['Approve', 'Deny', 'Always allow this in this session'])
  // The primary button looks like the old amber Approve.
  expect(within(el).getByRole('button', { name: 'Approve' }).getAttribute('data-variant')).toBe(
    'attention'
  )
})

it('a tool request: server, tool and arguments, with three buttons', () => {
  render(RequestPanel, { request: mcp })
  const el = panel('mcp')
  expect(within(el).getByText('sample-tracker')).toBeTruthy()
  expect(within(el).getByText('create_issue')).toBeTruthy()
  expect(el.textContent).toContain('"title": "x"')
  expect(buttonNames(el)).toEqual(['Approve', 'Deny', 'Always allow this in this session'])
})

it('a more-access request: read, write and network, and no Always allow', () => {
  render(RequestPanel, { request: access })
  const el = panel('acc')
  expect(within(el).getByText('Wants more access than its sandbox gives')).toBeTruthy()
  expect(within(el).getByText('/sample/cache')).toBeTruthy()
  expect(within(el).getByText('/sample/out')).toBeTruthy()
  expect(within(el).getByText('Wants network access')).toBeTruthy()
  expect(buttonNames(el)).toEqual(['Approve', 'Deny'])
})

it.each([
  ['cmd', 'Approve', command, { requestId: 'cmd', approve: true }],
  ['cmd', 'Deny', command, { requestId: 'cmd', approve: false }],
  [
    'cmd',
    'Always allow this in this session',
    command,
    { requestId: 'cmd', approve: true, always: true }
  ],
  ['mcp', 'Approve', mcp, { requestId: 'mcp', approve: true }],
  ['mcp', 'Deny', mcp, { requestId: 'mcp', approve: false }],
  ['acc', 'Approve', access, { requestId: 'acc', approve: true }],
  ['acc', 'Deny', access, { requestId: 'acc', approve: false }]
] as [string, string, AttentionView, Record<string, unknown>][])(
  '%s: %s sends attention:answer',
  async (id, label, request, payload) => {
    render(RequestPanel, { request })
    await fireEvent.click(within(panel(id)).getByRole('button', { name: label }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('attention:answer', payload))
    expect(invoke).toHaveBeenCalledTimes(1)
  }
)

it('an error result shows in the panel and the buttons work again', async () => {
  invoke = mockArc(() => ({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND' }
  }))
  render(RequestPanel, { request: command })
  const el = panel('cmd')
  await fireEvent.click(within(el).getByRole('button', { name: 'Approve' }))
  const alert = await within(el).findByRole('alert')
  expect(alert.textContent).toContain('That session no longer exists.')
  expect(toasts.list).toHaveLength(1)
  for (const b of within(el).getAllByRole('button')) {
    expect((b as HTMLButtonElement).disabled).toBe(false)
    expect(b.getAttribute('aria-busy')).toBeNull()
  }
  await fireEvent.click(within(el).getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  expect(invoke).toHaveBeenLastCalledWith('attention:answer', { requestId: 'cmd', approve: false })
})

// ---- Ported from the old PermissionCard tests (attention.test.ts, mcp-approval.test.ts) ----

it('shows the action in a mono box', () => {
  render(RequestPanel, { request: permissionView({ id: 'p', action: 'ls -la' }) })
  const box = within(panel('p')).getByText('ls -la')
  expect(box.className).toContain('font-mono')
  expect(box.hasAttribute('data-code')).toBe(true)
})

it('Approve, Deny and Always allow are at least 44px tall', () => {
  render(RequestPanel, { request: command })
  for (const name of ['Approve', 'Deny', 'Always allow this in this session']) {
    expect(within(panel('cmd')).getByRole('button', { name }).className).toContain(
      'min-h-[var(--size-hit)]'
    )
  }
  expect(tokens).toMatch(/--size-hit:\s*44px/)
})

const mcpWith = (args: Record<string, unknown>): AttentionView =>
  permissionView({
    id: 'm',
    action: 'x',
    tool: { kind: 'mcp', server: 'claude_ai_Figma', tool: 'use_figma', args }
  })

it('an MCP call shows the server, the tool and the arguments, not the raw action name', () => {
  render(RequestPanel, { request: mcpWith({ fileKey: 'abc' }) })
  const el = panel('m')
  expect(within(el).getByText('claude_ai_Figma')).toBeTruthy()
  expect(within(el).getByText('use_figma')).toBeTruthy()
  expect(el.querySelector('[data-code]')!.textContent).toContain('"fileKey": "abc"')
  expect(within(el).queryByRole('button', { name: /Show/ })).toBeNull()
})

it('long MCP arguments are cut behind Show more and Show less', async () => {
  render(RequestPanel, { request: mcpWith({ body: 'z'.repeat(1500) }) })
  const el = panel('m')
  const args = (): string => el.querySelector('[data-code]')!.textContent ?? ''
  expect(args().length).toBeLessThan(600)
  await fireEvent.click(within(el).getByRole('button', { name: 'Show more' }))
  expect(args()).toContain('z'.repeat(1500))
  await fireEvent.click(within(el).getByRole('button', { name: 'Show less' }))
  expect(args().length).toBeLessThan(600)
})

it('says so when an MCP call has no arguments', () => {
  render(RequestPanel, { request: mcpWith({}) })
  expect(within(panel('m')).getByText('No arguments.')).toBeTruthy()
})

// ---- Ported from the old QuestionCard tests ----

const plain = questionView({ id: 'q', from: 'W2', question: 'Which?' })

it('a question: frame, label, from line and the question', () => {
  render(RequestPanel, { request: plain })
  const el = panel('q')
  expect(el.getAttribute('data-kind')).toBe('question')
  expect(el.hasAttribute('data-structured')).toBe(false)
  expect(el.getAttribute('aria-label')).toBe('Question from W2')
  expect(el.className).toContain('border-accent/45')
  expect(within(el).getByText('Question')).toBeTruthy()
  expect(within(el).getByText('W2')).toBeTruthy()
  expect(within(el).getByText('Which?')).toBeTruthy()
  expect(within(el).getByRole('button', { name: 'Send' }).getAttribute('data-variant')).toBe(
    'primary'
  )
})

it('Send is unavailable while the answer is empty and sends the text', async () => {
  render(RequestPanel, { request: plain })
  const el = panel('q')
  const send = within(el).getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  const input = within(el).getByLabelText('Your answer')
  await fireEvent.input(input, { target: { value: '   ' } })
  expect(send.disabled).toBe(true)
  await fireEvent.input(input, { target: { value: 'main' } })
  expect(send.disabled).toBe(false)
  await fireEvent.click(send)
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'q', text: 'main' })
  )
})

it('Enter in Your answer sends, and Enter while empty sends nothing', async () => {
  render(RequestPanel, { request: plain })
  const input = within(panel('q')).getByLabelText('Your answer')
  await fireEvent.keyDown(input, { key: 'Enter' })
  expect(invoke).not.toHaveBeenCalled()
  await fireEvent.input(input, { target: { value: ' main ' } })
  await fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'q', text: 'main' })
  )
})

// ---- Ported from the old StructuredQuestionCard tests ----

const single: QuestionSpec[number] = {
  question: 'Where should the review open?',
  header: 'Review',
  multiSelect: false,
  options: [{ label: 'In the app', description: 'Opens in Arc.' }, { label: 'In the editor' }]
}
const multi: QuestionSpec[number] = {
  question: 'Which colors?',
  header: 'Colors',
  multiSelect: true,
  options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
}

function renderStructured(questions: QuestionSpec, from = 'W2 · /awos:spec'): HTMLElement {
  render(RequestPanel, { request: questionView({ id: 'sq1', from, questions }) })
  return panel('sq1')
}

const answered = (): unknown[] => invoke.mock.calls.filter((c) => c[0] === 'attention:answer')

it('structured: frame, label, header, descriptions and the data-structured marker', () => {
  const el = renderStructured([single])
  expect(el.getAttribute('data-kind')).toBe('question')
  expect(el.hasAttribute('data-structured')).toBe(true)
  expect(el.getAttribute('aria-label')).toBe('Question from W2 · /awos:spec')
  expect(within(el).getByText('W2 · /awos:spec')).toBeTruthy()
  expect(within(el).getByText('Review')).toBeTruthy()
  expect(within(el).getByText('Opens in Arc.')).toBeTruthy()
  expect(within(el).getByRole('group', { name: 'Where should the review open?' })).toBeTruthy()
})

it('structured: the question text appears exactly once, as the picker legend', () => {
  const el = renderStructured([single])
  expect(within(el).getAllByText('Where should the review open?')).toHaveLength(1)
  expect(el.querySelectorAll('legend')).toHaveLength(1)
})

it('structured: Submit stays unavailable until every question has an answer', async () => {
  const el = renderStructured([single, multi])
  const submit = within(el).getByRole('button', { name: 'Submit' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  await fireEvent.click(within(el).getByRole('button', { name: /In the app/ }))
  expect(submit.disabled).toBe(true)
  await fireEvent.click(within(el).getByLabelText('Red'))
  expect(submit.disabled).toBe(false)
  await fireEvent.click(within(el).getByLabelText('Red'))
  expect(submit.disabled).toBe(true)
})

it('structured: a single choice sends the last chosen label', async () => {
  const el = renderStructured([single])
  await fireEvent.click(within(el).getByRole('button', { name: /In the editor/ }))
  await fireEvent.click(within(el).getByRole('button', { name: /In the app/ }))
  await fireEvent.click(within(el).getByRole('button', { name: 'Submit' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', {
      requestId: 'sq1',
      answers: { 'Where should the review open?': ['In the app'] }
    })
  )
})

it('structured: multi-select shows checkboxes and sends the chosen labels as an array', async () => {
  const el = renderStructured([multi])
  expect(within(el).getAllByRole('checkbox')).toHaveLength(3)
  await fireEvent.click(within(el).getByLabelText('Red'))
  await fireEvent.click(within(el).getByLabelText('Blue'))
  await fireEvent.click(within(el).getByRole('button', { name: 'Submit' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', {
      requestId: 'sq1',
      answers: { 'Which colors?': ['Red', 'Blue'] }
    })
  )
})

it('structured: typed Other text replaces the pick and clearing it restores the pick', async () => {
  const el = renderStructured([single])
  await fireEvent.click(within(el).getByRole('button', { name: /In the app/ }))
  const other = within(el).getByLabelText('Other')
  await fireEvent.input(other, { target: { value: ' somewhere else ' } })
  expect(
    within(el)
      .getByRole('button', { name: /In the app/ })
      .getAttribute('aria-pressed')
  ).toBe('false')
  await fireEvent.click(within(el).getByRole('button', { name: 'Submit' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith('attention:answer', {
      requestId: 'sq1',
      answers: { 'Where should the review open?': ['somewhere else'] }
    })
  )
  await fireEvent.input(other, { target: { value: '' } })
  expect(
    within(el)
      .getByRole('button', { name: /In the app/ })
      .getAttribute('aria-pressed')
  ).toBe('true')
})

it('structured: Other alone is an answer', async () => {
  const el = renderStructured([single])
  await fireEvent.input(within(el).getByLabelText('Other'), { target: { value: 'elsewhere' } })
  expect((within(el).getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(
    false
  )
})

it('structured: two questions go in one submit', async () => {
  const el = renderStructured([single, multi])
  await fireEvent.click(within(el).getByRole('button', { name: /In the editor/ }))
  await fireEvent.click(within(el).getByLabelText('Green'))
  await fireEvent.click(within(el).getByRole('button', { name: 'Submit' }))
  await waitFor(() => expect(answered()).toHaveLength(1))
  expect(invoke).toHaveBeenCalledWith('attention:answer', {
    requestId: 'sq1',
    answers: { 'Where should the review open?': ['In the editor'], 'Which colors?': ['Green'] }
  })
})

it('structured: Decline sends decline and an error stays in the panel with the choices', async () => {
  invoke = mockArc(() => ({ ok: false, error: { code: 'SESSION_NOT_FOUND' } }))
  const el = renderStructured([single])
  await fireEvent.click(within(el).getByRole('button', { name: 'Decline' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attention:answer', { requestId: 'sq1', decline: true })
  )
  expect((await within(el).findByRole('alert')).textContent).toContain(
    'That session no longer exists.'
  )
  expect(within(el).getByRole('button', { name: 'Submit' })).toBeTruthy()
})

it('structured: the submitted answers can cross the IPC bridge (structured clone)', async () => {
  const el = renderStructured([multi])
  await fireEvent.click(within(el).getByLabelText('Red'))
  await fireEvent.click(within(el).getByRole('button', { name: 'Submit' }))
  await waitFor(() => expect(answered()).toHaveLength(1))
  const payload = invoke.mock.calls[0]![1] as { answers: Record<string, string[]> }
  expect(structuredClone(payload.answers)).toEqual({ 'Which colors?': ['Red'] })
})

// ---- Busy and error handling the old cards had ----

it('the buttons are blocked while an answer is in flight and work again after', async () => {
  let finish: (v: unknown) => void = () => {}
  invoke = mockArc(() => new Promise((r) => (finish = r)) as never)
  render(RequestPanel, { request: command })
  const el = panel('cmd')
  await fireEvent.click(within(el).getByRole('button', { name: 'Approve' }))
  for (const b of within(el).getAllByRole('button'))
    expect(b.getAttribute('aria-busy')).toBe('true')
  await fireEvent.click(within(el).getByRole('button', { name: 'Deny' }))
  expect(invoke).toHaveBeenCalledTimes(1)
  finish({ ok: true, data: undefined })
  await waitFor(() =>
    expect(within(el).getByRole('button', { name: 'Deny' }).getAttribute('aria-busy')).toBeNull()
  )
})

it('a thrown error shows "Could not send the answer. Try again." and keeps the input', async () => {
  invoke = mockArc(() => {
    throw new Error('boom')
  })
  render(RequestPanel, { request: plain })
  const el = panel('q')
  await fireEvent.input(within(el).getByLabelText('Your answer'), { target: { value: 'main' } })
  await fireEvent.click(within(el).getByRole('button', { name: 'Send' }))
  expect((await within(el).findByRole('alert')).textContent).toContain(
    'Could not send the answer. Try again.'
  )
  expect((within(el).getByLabelText('Your answer') as HTMLInputElement).value).toBe('main')
})

// ---- Ported from the old BranchQuestionCard tests, plus the routing to the branch answer ----

const branch = branchView({ id: 'bq1', files: ['src/a.ts', 'src/b.ts'] })

const choiceValues = (el: HTMLElement): string[] =>
  within(el)
    .getAllByRole('radio')
    .map((r) => (r as HTMLInputElement).value)

it('unsaved changes: frame, title, from line, files and waiting workers, no text box, no Decline', () => {
  render(RequestPanel, { request: branch })
  const el = panel('bq1')
  expect(el.getAttribute('data-kind')).toBe('branch')
  expect(el.getAttribute('aria-label')).toBe('Unsaved changes in web')
  expect(el.className).toContain('border-accent/45')
  expect(within(el).getByText('Unsaved changes')).toBeTruthy()
  expect(within(el).getByRole('heading', { name: 'Unsaved changes in web' })).toBeTruthy()
  expect(within(el).getByText('Arc')).toBeTruthy()
  expect(el.querySelector('[data-code]')!.textContent).toBe('src/a.ts\nsrc/b.ts')
  expect(within(el).getByText('Waiting to start: W3 web-fix')).toBeTruthy()
  expect(within(el).queryByRole('textbox')).toBeNull()
  expect(within(el).queryByRole('button', { name: 'Decline' })).toBeNull()
})

it('unsaved changes: says "and N more" when files are left out', () => {
  render(RequestPanel, { request: branchView({ id: 'bq1', moreFiles: 7 }) })
  expect(panel('bq1').querySelector('[data-code]')!.textContent).toContain('and 7 more')
})

it('unsaved changes: four choices with descriptions, no default, Continue unavailable', () => {
  render(RequestPanel, { request: branch })
  const el = panel('bq1')
  expect(choiceValues(el)).toEqual(['stash', 'commit', 'carry', 'skip'])
  expect(
    within(el)
      .getAllByRole('radio')
      .some((r) => (r as HTMLInputElement).checked)
  ).toBe(false)
  expect(
    within(el).getByRole('radiogroup', { name: /what to do with these changes/i })
  ).toBeTruthy()
  expect(within(el).getByText('Takes the changes onto the session branch.')).toBeTruthy()
  expect(within(el).getByText('The worker is not started and web is left as it is.')).toBeTruthy()
  expect((within(el).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it.each([
  ['Commit them first', 'commit'],
  ["Don't start", 'skip']
])(
  'unsaved changes: %s then Continue sends the choice to the branch answer',
  async (name, choice) => {
    render(RequestPanel, { request: branch })
    const el = panel('bq1')
    await fireEvent.click(within(el).getByRole('radio', { name: new RegExp(name) }))
    await fireEvent.click(within(el).getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('sessions:answer-branch-question', {
        questionId: 'bq1',
        choice
      })
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  }
)

it('unsaved changes: Continue is busy while the answer runs and a failure shows in the panel', async () => {
  let finish: (v: unknown) => void = () => {}
  invoke = mockArc(() => new Promise((r) => (finish = r)) as never)
  render(RequestPanel, { request: branch })
  const el = panel('bq1')
  await fireEvent.click(within(el).getByRole('radio', { name: /Bring them along/ }))
  const cont = within(el).getByRole('button', { name: 'Continue' })
  await fireEvent.click(cont)
  expect(cont.getAttribute('aria-busy')).toBe('true')
  finish({ ok: true, data: { status: 'failed', reason: 'Git could not switch branches.' } })
  await waitFor(() => expect(within(el).getByText('Git could not switch branches.')).toBeTruthy())
  expect(cont.getAttribute('aria-busy')).toBeNull()
  // The panel and the pick stay so the user can try again or choose another.
  expect(
    (within(el).getByRole('radio', { name: /Bring them along/ }) as HTMLInputElement).checked
  ).toBe(true)
  expect(toasts.list).toHaveLength(0)
})

it('unsaved changes: a request error result shows its text in the panel', async () => {
  invoke = mockArc(() => ({ ok: false, error: { code: 'SESSION_NOT_FOUND' } }))
  render(RequestPanel, { request: branch })
  const el = panel('bq1')
  await fireEvent.click(within(el).getByRole('radio', { name: /Set aside/ }))
  await fireEvent.click(within(el).getByRole('button', { name: 'Continue' }))
  expect((await within(el).findByRole('alert')).textContent).toContain(
    'That session no longer exists.'
  )
})

it('unsaved changes: a failed carry shows the warning and does not offer Bring them along', async () => {
  const message = 'Could not bring the changes along. Pick another choice.'
  const { rerender } = render(RequestPanel, { request: branch })
  await fireEvent.click(within(panel('bq1')).getByRole('radio', { name: /Bring them along/ }))
  await rerender({ request: branchView({ id: 'bq1', message }) })
  const el = panel('bq1')
  expect(within(el).getByText(message)).toBeTruthy()
  expect(within(el).queryByRole('radio', { name: /Bring them along/ })).toBeNull()
  expect(choiceValues(el)).toEqual(['stash', 'commit', 'skip'])
  // The pick is cleared because the panel starts again from the new surface.
  expect((within(el).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it('answering a question with one kind never reaches the other IPC channel', async () => {
  render(RequestPanel, { request: branch })
  await fireEvent.click(within(panel('bq1')).getByRole('radio', { name: /Set aside/ }))
  await fireEvent.click(within(panel('bq1')).getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(invoke).toHaveBeenCalled())
  expect(invoke.mock.calls.map((c) => c[0])).toEqual(['sessions:answer-branch-question'])
})
