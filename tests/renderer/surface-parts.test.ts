// The generic parts of the surface renderer: code, key/value, pickers, requires and Enter-to-submit.
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SurfaceView from '../../src/renderer/src/lib/components/surface/SurfaceView.svelte'
import { surfaceSchema, type SurfaceAction } from '../../src/shared/surface'

afterEach(cleanup)

const ok = async (a: SurfaceAction): Promise<string | null> => (a ? null : null)

function draw(
  components: Record<string, unknown>[],
  dataModel: Record<string, unknown> = {},
  onAction = vi.fn(ok)
) {
  const surface = surfaceSchema.parse({ surfaceId: 's', components, dataModel })
  return { onAction, ...render(SurfaceView, { surface, idPrefix: 'p', onAction }) }
}

const button = (id: string, label: string, extra: Record<string, unknown> = {}) => [
  {
    id,
    component: 'Button',
    child: `${id}_t`,
    action: { event: { name: id, context: {} } },
    ...extra
  },
  { id: `${id}_t`, component: 'Text', text: label }
]

it('cuts a 30-line code block and expands it', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  draw([{ id: 'root', component: 'CodeBlock', text, maxLines: 10, maxChars: 400 }])
  const pre = document.querySelector('pre')!
  expect(pre.textContent).toContain('line 9')
  expect(pre.textContent).not.toContain('line 10')
  expect(pre.textContent!.endsWith('…')).toBe(true)
  const more = screen.getByRole('button', { name: 'Show more' })
  expect(more.getAttribute('aria-expanded')).toBeNull()
  await fireEvent.click(more)
  expect(document.querySelector('pre')!.textContent).toBe(text)
  await fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(document.querySelector('pre')!.textContent).not.toContain('line 10')
})

it('cuts a 1000-character single line at 400 characters', () => {
  draw([
    { id: 'root', component: 'CodeBlock', text: 'x'.repeat(1000), maxLines: 10, maxChars: 400 }
  ])
  expect(document.querySelector('pre')!.textContent).toBe('x'.repeat(400) + '\n…')
})

it('shows short code without a button', () => {
  draw([{ id: 'root', component: 'CodeBlock', text: 'pnpm test', maxLines: 10, maxChars: 400 }])
  expect(document.querySelector('pre')!.textContent).toBe('pnpm test')
  expect(screen.queryByRole('button')).toBeNull()
})

it('reads a code block from a binding', () => {
  draw([{ id: 'root', component: 'CodeBlock', text: { '@path': '/cmd' } }], { cmd: 'ls -la' })
  expect(document.querySelector('pre')!.textContent).toBe('ls -la')
})

it('draws key/value pairs with a list value one per line', () => {
  draw(
    [
      {
        id: 'root',
        component: 'KeyValue',
        items: [
          { label: 'Command', value: 'pnpm test' },
          { label: 'Files', value: ['a.ts', 'b.ts'] },
          { label: 'Bound', value: { '@path': '/b' } }
        ]
      }
    ],
    { b: ['x', 'y'] }
  )
  const dts = [...document.querySelectorAll('dt')].map((d) => d.textContent)
  expect(dts).toEqual(['Command', 'Files', 'Bound'])
  const dds = document.querySelectorAll('dd')
  expect(dds[0]!.textContent!.trim()).toBe('pnpm test')
  expect([...dds[1]!.querySelectorAll('div')].map((d) => d.textContent)).toEqual(['a.ts', 'b.ts'])
  expect([...dds[2]!.querySelectorAll('div')].map((d) => d.textContent)).toEqual(['x', 'y'])
})

const options = [
  { label: 'Carry', value: 'carry', description: 'Bring the changes along' },
  { label: 'Leave', value: 'leave', description: 'Keep them here' }
]

it('draws a radio picker with descriptions and no default pick', async () => {
  const { onAction } = draw([
    {
      id: 'root',
      component: 'Column',
      children: ['pick', 'go']
    },
    {
      id: 'pick',
      component: 'ChoicePicker',
      label: 'What now',
      display: 'radio',
      options,
      value: { '@path': '/choice' }
    },
    ...button('go', 'Continue', {
      requires: [{ '@path': '/choice' }],
      action: { event: { name: 'go', context: { choice: { '@path': '/choice' } } } }
    })
  ])
  const radios = screen.getAllByRole('radio') as HTMLInputElement[]
  expect(radios).toHaveLength(2)
  expect(radios.every((r) => !r.checked)).toBe(true)
  expect(screen.getByText('Bring the changes along')).toBeTruthy()
  const go = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
  expect(go.disabled).toBe(true)
  await fireEvent.click(radios[1]!)
  expect((screen.getAllByRole('radio') as HTMLInputElement[])[1]!.checked).toBe(true)
  expect(go.disabled).toBe(false)
  await fireEvent.click(go)
  await waitFor(() => expect(onAction).toHaveBeenCalled())
  expect(onAction.mock.calls[0]![0].context).toEqual({ choice: ['leave'] })
})

it('draws a buttons picker for single selection', async () => {
  draw([
    { id: 'root', component: 'ChoicePicker', label: 'Pick', options, value: { '@path': '/c' } }
  ])
  const a = screen.getByRole('button', { name: /Carry/ })
  const b = screen.getByRole('button', { name: /Leave/ })
  expect(a.getAttribute('aria-pressed')).toBe('false')
  await fireEvent.click(a)
  expect(a.getAttribute('aria-pressed')).toBe('true')
  await fireEvent.click(b)
  expect(a.getAttribute('aria-pressed')).toBe('false')
  expect(b.getAttribute('aria-pressed')).toBe('true')
})

it('draws checkboxes for multiple selection and sends plain lists', async () => {
  const { onAction } = draw(
    [
      { id: 'root', component: 'Column', children: ['pick', 'go'] },
      {
        id: 'pick',
        component: 'ChoicePicker',
        label: 'Pick',
        variant: 'multipleSelection',
        options,
        value: { '@path': '/c' }
      },
      ...button('go', 'Go', {
        action: { event: { name: 'go', context: { c: { '@path': '/c' } } } }
      })
    ],
    { c: [] }
  )
  await fireEvent.click(screen.getByLabelText('Carry'))
  await fireEvent.click(screen.getByLabelText('Leave'))
  await fireEvent.click(screen.getByLabelText('Carry'))
  expect((screen.getByLabelText('Leave') as HTMLInputElement).checked).toBe(true)
  await fireEvent.click(screen.getByRole('button', { name: 'Go' }))
  await waitFor(() => expect(onAction).toHaveBeenCalled())
  const ctx = onAction.mock.calls[0]![0].context
  expect(ctx).toEqual({ c: ['leave'] })
  expect(JSON.stringify(ctx)).toBe(structuredClone(JSON.stringify(ctx)))
  expect(() => structuredClone(ctx)).not.toThrow()
})

it('shows picks as not selected while overriddenBy holds text, and selected again when cleared', async () => {
  draw(
    [
      { id: 'root', component: 'Column', children: ['pick', 'other'] },
      {
        id: 'pick',
        component: 'ChoicePicker',
        label: 'Pick',
        options,
        value: { '@path': '/q' },
        overriddenBy: { '@path': '/o' }
      },
      { id: 'other', component: 'TextField', label: 'Other', value: { '@path': '/o' } }
    ],
    { q: ['carry'], o: '' }
  )
  const carry = (): HTMLElement => screen.getByRole('button', { name: /Carry/ })
  expect(carry().getAttribute('aria-pressed')).toBe('true')
  await fireEvent.input(screen.getByLabelText('Other'), { target: { value: 'something else' } })
  expect(carry().getAttribute('aria-pressed')).toBe('false')
  await fireEvent.input(screen.getByLabelText('Other'), { target: { value: '' } })
  expect(carry().getAttribute('aria-pressed')).toBe('true')
})

const gated = (requires: unknown, model: Record<string, unknown>) => {
  draw(
    [
      { id: 'root', component: 'Column', children: ['a', 'b', 'go'] },
      { id: 'a', component: 'TextField', label: 'A', value: { '@path': '/a' } },
      { id: 'b', component: 'TextField', label: 'B', value: { '@path': '/b' } },
      ...button('go', 'Go', { requires })
    ],
    model
  )
  return screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement
}

it('enables a button once its single required path is filled', async () => {
  const go = gated([{ '@path': '/a' }], { a: '' })
  expect(go.disabled).toBe(true)
  await fireEvent.input(screen.getByLabelText('A'), { target: { value: 'x' } })
  expect(go.disabled).toBe(false)
})

it('accepts any one path of an alternative', async () => {
  const go = gated([[{ '@path': '/a' }, { '@path': '/b' }]], { a: '', b: '' })
  expect(go.disabled).toBe(true)
  await fireEvent.input(screen.getByLabelText('B'), { target: { value: 'x' } })
  expect(go.disabled).toBe(false)
})

it('does not count whitespace-only text or an empty list as filled', async () => {
  const go = gated([{ '@path': '/a' }, { '@path': '/l' }], { a: '', l: [] })
  await fireEvent.input(screen.getByLabelText('A'), { target: { value: '   ' } })
  expect(go.disabled).toBe(true)
})

it('Enter in a field runs the named button only when it is enabled', async () => {
  const { onAction } = draw(
    [
      { id: 'root', component: 'Column', children: ['a', 'go'] },
      { id: 'a', component: 'TextField', label: 'Answer', value: { '@path': '/a' }, submit: 'go' },
      ...button('go', 'Send', { requires: [{ '@path': '/a' }] })
    ],
    { a: '' }
  )
  const field = screen.getByLabelText('Answer')
  await fireEvent.keyDown(field, { key: 'Enter' })
  expect(onAction).not.toHaveBeenCalled()
  await fireEvent.input(field, { target: { value: 'yes' } })
  await fireEvent.keyDown(field, { key: 'Enter' })
  await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
  expect(onAction.mock.calls[0]![0].name).toBe('go')
})

it('Enter does nothing while the view is busy', async () => {
  let release: (v: string | null) => void = () => {}
  const onAction = vi.fn(() => new Promise<string | null>((r) => (release = r)))
  draw(
    [
      { id: 'root', component: 'Column', children: ['a', 'go'] },
      { id: 'a', component: 'TextField', label: 'Answer', value: 'x', submit: 'go' },
      ...button('go', 'Send')
    ],
    {},
    onAction
  )
  const field = screen.getByLabelText('Answer')
  await fireEvent.keyDown(field, { key: 'Enter' })
  await fireEvent.keyDown(field, { key: 'Enter' })
  expect(onAction).toHaveBeenCalledTimes(1)
  release(null)
})

it('cuts Text at maxLines with Show more and Show less', async () => {
  const text = 'one\ntwo\nthree\nfour\nfive'
  draw([{ id: 'root', component: 'Text', text, maxLines: 3 }])
  expect(screen.queryByText(/four/)).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(document.body.textContent).toContain('five')
  await fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(document.body.textContent).not.toContain('four')
})

it('draws Text without a limit in full and without a button', () => {
  draw([{ id: 'root', component: 'Text', text: 'a\nb\nc\nd\ne' }])
  expect(screen.queryByRole('button')).toBeNull()
})
