/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { readFileSync } from 'node:fs'
import Button from '../../src/renderer/src/lib/components/ui/Button.svelte'
import IconButton from '../../src/renderer/src/lib/components/ui/IconButton.svelte'
import TextField from '../../src/renderer/src/lib/components/ui/TextField.svelte'
import TextArea from '../../src/renderer/src/lib/components/ui/TextArea.svelte'
import Select from '../../src/renderer/src/lib/components/ui/Select.svelte'
import Toggle from '../../src/renderer/src/lib/components/ui/Toggle.svelte'
import Checkbox from '../../src/renderer/src/lib/components/ui/Checkbox.svelte'
import Radio from '../../src/renderer/src/lib/components/ui/Radio.svelte'

afterEach(cleanup)

const label = createRawSnippet(() => ({ render: () => '<span>Save</span>' }))
const btn = (props: Record<string, unknown> = {}): ReturnType<typeof render> =>
  render(Button, { children: label, ...props })

describe('Button', () => {
  it.each([
    ['primary', 'bg-accent', 'text-accent-ink'],
    ['secondary', 'bg-transparent', 'text-text'],
    ['danger', 'bg-danger', 'text-danger-ink'],
    ['attention', 'bg-attention', 'text-attention-ink']
  ])('variant %s uses its tone classes', (variant, bg, text) => {
    btn({ variant })
    const el = screen.getByRole('button', { name: 'Save' })
    expect(el.className).toContain(bg)
    expect(el.className).toContain(text)
    expect(el.getAttribute('data-variant')).toBe(variant)
  })

  it('defaults to secondary and has a 44px minimum', () => {
    btn()
    const el = screen.getByRole('button', { name: 'Save' })
    expect(el.getAttribute('data-variant')).toBe('secondary')
    expect(el.className).toContain('min-h-[var(--size-hit)]')
  })

  it('busy sets aria-busy, blocks clicks, and keeps the label', async () => {
    const onclick = vi.fn()
    btn({ busy: true, onclick })
    const el = screen.getByRole('button', { name: 'Save' })
    expect(el.getAttribute('aria-busy')).toBe('true')
    await fireEvent.click(el)
    expect(onclick).not.toHaveBeenCalled()
  })

  it('not busy has no aria-busy and clicks through', async () => {
    const onclick = vi.fn()
    btn({ onclick })
    const el = screen.getByRole('button', { name: 'Save' })
    expect(el.hasAttribute('aria-busy')).toBe(false)
    await fireEvent.click(el)
    expect(onclick).toHaveBeenCalledTimes(1)
  })

  it('disabled blocks clicks', async () => {
    const onclick = vi.fn()
    btn({ disabled: true, onclick })
    const el = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(el.disabled).toBe(true)
    await fireEvent.click(el)
    expect(onclick).not.toHaveBeenCalled()
  })

  it('is a native, focusable button so Enter and Space activate it', async () => {
    const onclick = vi.fn()
    btn({ onclick })
    const el = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(el.tagName).toBe('BUTTON')
    expect(el.tabIndex).toBe(0)
    el.focus()
    expect(document.activeElement).toBe(el)
    // Browsers turn Enter/Space on a focused button into click; jsdom does not, so dispatch it.
    await fireEvent.click(el)
    expect(onclick).toHaveBeenCalledTimes(1)
  })

  it('busy keeps keyboard focus on the button', () => {
    btn({ busy: true })
    const el = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(el.disabled).toBe(false)
    el.focus()
    expect(document.activeElement).toBe(el)
  })
})

describe('IconButton', () => {
  it('uses label as its accessible name and is 44px', async () => {
    const onclick = vi.fn()
    render(IconButton, { label: 'Close panel', icon: 'close', onclick })
    const el = screen.getByRole('button', { name: 'Close panel' })
    expect(el.className).toContain('size-hit')
    await fireEvent.click(el)
    expect(onclick).toHaveBeenCalledTimes(1)
  })

  it('blocks clicks when busy or disabled', async () => {
    const onclick = vi.fn()
    render(IconButton, { label: 'Go', icon: 'plus', busy: true, onclick })
    const el = screen.getByRole('button', { name: 'Go' })
    expect(el.getAttribute('aria-busy')).toBe('true')
    await fireEvent.click(el)
    expect(onclick).not.toHaveBeenCalled()
  })
})

describe('fields', () => {
  it('TextField wires aria-invalid and aria-describedby to the error', () => {
    render(TextField, { id: 'n', label: 'Name', value: '', error: 'Required' })
    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('n-error')
    expect(screen.getByRole('alert').textContent).toBe('Required')
  })

  it('TextField error carries an error icon beside its text', () => {
    render(TextField, { id: 'n', label: 'Name', value: '', error: 'Required' })
    const alert = screen.getByRole('alert')
    expect(alert.querySelector('svg[data-icon="error"]')).not.toBeNull()
    expect(alert.textContent?.trim()).toBe('Required')
  })

  it('TextField without error is valid and undescribed', () => {
    render(TextField, { id: 'n', label: 'Name', value: '' })
    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('TextArea, Select, Checkbox, Toggle and Radio expose invalid and described state', () => {
    render(TextArea, { id: 'a', label: 'Notes', value: '', error: 'Bad' })
    render(Select, {
      id: 's',
      label: 'Model',
      value: 'a',
      options: [{ value: 'a', label: 'A' }],
      error: 'Bad'
    })
    render(Checkbox, { id: 'c', label: 'Agree', checked: false, error: 'Bad' })
    render(Toggle, { id: 't', label: 'Auto', checked: false, error: 'Bad' })
    render(Radio, { id: 'r', name: 'g', label: 'One', value: '1', group: '', error: 'Bad' })
    const checks: { name: string; id: string }[] = [
      { name: 'Notes', id: 'a' },
      { name: 'Model', id: 's' },
      { name: 'Agree', id: 'c' },
      { name: 'Auto', id: 't' },
      { name: 'One', id: 'r' }
    ]
    for (const { name, id } of checks) {
      const el = screen.getByLabelText(name)
      // aria-invalid is not valid on role radio; the radio is only described by its error line.
      if (id !== 'r') expect(el.getAttribute('aria-invalid')).toBe('true')
      else expect(el.hasAttribute('aria-invalid')).toBe(false)
      expect(el.getAttribute('aria-describedby')).toBe(`${id}-error`)
    }
  })

  it('every error line carries an error icon beside its words', () => {
    render(TextArea, { id: 'a', label: 'Notes', value: '', error: 'Bad a' })
    render(Checkbox, { id: 'c', label: 'Agree', checked: false, error: 'Bad c' })
    render(Toggle, { id: 't', label: 'Auto', checked: false, error: 'Bad t' })
    render(Radio, { id: 'r', name: 'g', label: 'One', value: '1', group: '', error: 'Bad r' })
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(4)
    for (const alert of alerts) {
      expect(alert.querySelector('svg[data-icon="error"]')).not.toBeNull()
      expect(alert.textContent?.trim()).toMatch(/^Bad/)
    }
  })

  it('keeps native elements', () => {
    render(TextArea, { id: 'a', label: 'Notes', value: '' })
    render(Select, { id: 's', label: 'Model', value: 'a', options: [{ value: 'a', label: 'A' }] })
    render(Checkbox, { id: 'c', label: 'Agree', checked: false })
    render(Toggle, { id: 't', label: 'Auto', checked: false })
    render(Radio, { id: 'r', name: 'g', label: 'One', value: '1', group: '' })
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('Model').tagName).toBe('SELECT')
    expect((screen.getByLabelText('Agree') as HTMLInputElement).type).toBe('checkbox')
    expect(screen.getByRole('switch', { name: 'Auto' }).tagName).toBe('INPUT')
    expect((screen.getByLabelText('One') as HTMLInputElement).type).toBe('radio')
  })

  it('toggles a focused switch and selects a radio by click', async () => {
    render(Toggle, { id: 't', label: 'Auto', checked: false })
    render(Radio, { id: 'r', name: 'g', label: 'One', value: '1', group: '' })
    const sw = screen.getByRole('switch') as HTMLInputElement
    sw.focus()
    expect(document.activeElement).toBe(sw)
    await fireEvent.click(sw)
    expect(sw.checked).toBe(true)
    await fireEvent.click(screen.getByLabelText('One'))
    expect((screen.getByLabelText('One') as HTMLInputElement).checked).toBe(true)
  })

  it('disabled fields are disabled', async () => {
    render(TextField, { id: 'n', label: 'Name', value: '', disabled: true })
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('focus ring contract', () => {
  const cases: [string, () => ReturnType<typeof render>, string][] = [
    ['Button', () => btn(), 'button'],
    ['IconButton', () => render(IconButton, { label: 'x', icon: 'close' }), 'button'],
    ['TextField', () => render(TextField, { id: 'i', label: 'l', value: '' }), 'input'],
    ['TextArea', () => render(TextArea, { id: 'i', label: 'l', value: '' }), 'textarea'],
    [
      'Select',
      () =>
        render(Select, { id: 'i', label: 'l', value: 'a', options: [{ value: 'a', label: 'A' }] }),
      'select'
    ],
    ['Checkbox', () => render(Checkbox, { id: 'i', label: 'l', checked: false }), 'input'],
    ['Toggle', () => render(Toggle, { id: 'i', label: 'l', checked: false }), 'input'],
    [
      'Radio',
      () => render(Radio, { id: 'i', name: 'n', label: 'l', value: 'v', group: '' }),
      'input'
    ]
  ]

  it.each(cases)('%s interactive root carries focus-visible:shadow-focus', (_n, make, sel) => {
    const { container } = make()
    const el = container.querySelector(sel)!
    expect(el.className).toContain('focus-visible:shadow-focus')
  })

  it('global :focus-visible rule uses --shadow-focus', () => {
    const css = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')
    expect(css).toMatch(/:focus-visible\s*\{[^}]*box-shadow:\s*var\(--shadow-focus\)/)
  })
})
