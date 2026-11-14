import { createRawSnippet, tick } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import AttentionDock from '../../src/renderer/src/lib/components/sessions/AttentionDock.svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import { dockCap } from '../../src/renderer/src/lib/dock-cap'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { AttentionView, SessionHeader, SessionSnapshot } from '../../src/shared/types/session'
import { permissionView, questionSurface } from './attention-fixtures'
import { mockArc } from './helpers'

const header: SessionHeader = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

const question: AttentionView = {
  id: 'q1',
  route: 'queue',
  kind: 'question',
  from: 'W2 docs · via brain',
  workerId: 'w2',
  question: 'Which branch?',
  surface: questionSurface('q1', 'Which branch?')
}

function load(attention: AttentionView[]): void {
  const snapshot: SessionSnapshot = {
    header,
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention,
    knowledgeSuggestions: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  }
  activeSession.setSnapshot(snapshot)
}

beforeEach(() => {
  mockArc(() => ({ ok: true, data: undefined }))
  activeSession.close()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('names the region and counts the requests in its heading', () => {
  load([permissionView({ id: 'p1' }), question])
  render(AttentionDock)
  const region = screen.getByRole('region', { name: 'Needs attention' })
  expect(region.hasAttribute('data-attention-dock')).toBe(true)
  expect(within(region).getByRole('heading', { name: 'Needs attention · 2' })).toBeTruthy()
})

it('lists the panels oldest first, in the order the store gives', () => {
  load([
    permissionView({ id: 'a', from: 'one' }),
    question,
    permissionView({ id: 'c', from: 'three' })
  ])
  render(AttentionDock)
  const order = [...document.querySelectorAll('[data-attention-list] article')].map((el) =>
    el.getAttribute('aria-label')
  )
  expect(order[0]).toBe('Permission request from one')
  expect(order[1]).toContain('W2 docs')
  expect(order[2]).toBe('Permission request from three')
})

it('caps its height and scrolls the list itself', () => {
  load([permissionView({ id: 'p1' })])
  render(AttentionDock)
  expect(document.querySelector('[data-attention-dock]')!.className).toContain('max-h-full')
  expect(document.querySelector('[data-attention-list]')!.className).toContain('overflow-y-auto')
})

it('keeps a value typed into a card when another request is pushed', async () => {
  load([question])
  render(AttentionDock)
  const box = screen.getByRole('textbox') as HTMLInputElement
  await fireEvent.input(box, { target: { value: 'ma' } })
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [question, permissionView({ id: 'p2' })]
  })
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Needs attention · 2' })).toBeTruthy()
  )
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('ma')
  expect(screen.getByRole('textbox')).toBe(box)
})

it('keeps a typed value when a request ahead of it leaves the list', async () => {
  load([permissionView({ id: 'p0' }), question])
  render(AttentionDock)
  const box = screen.getByRole('textbox') as HTMLInputElement
  await fireEvent.input(box, { target: { value: 'ma' } })
  activeSession.applyAttention({ sessionId: 's1', requests: [question] })
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Needs attention · 1' })).toBeTruthy()
  )
  expect(screen.getByRole('textbox')).toBe(box)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('ma')
})

it('a focus target scrolls its panel into view', async () => {
  load([permissionView({ id: 'p1' }), permissionView({ id: 'p2' })])
  const scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  render(AttentionDock)
  activeSession.focusRequest('p2')
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
  expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-request-panel="p2"]'))
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

it('re-pins the message list to the bottom when the dock changes height and the list was at the bottom', async () => {
  const callbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        callbacks.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  load([permissionView({ id: 'p1' })])
  const dock = createRawSnippet(() => ({ render: () => '<div>sample dock</div>' }))
  render(Conversation, { dock })
  const scroller = document.querySelector('[data-conversation]') as HTMLElement
  let scrollHeight = 500
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
  // Let the mount's own scroll to the bottom run first.
  await tick()
  await tick()
  expect(callbacks.length).toBeGreaterThan(0)

  // At the bottom (the default): the dock grows, the list follows.
  scroller.scrollTop = 0
  scrollHeight = 700
  callbacks.forEach((cb) => cb())
  expect(scroller.scrollTop).toBe(700)

  // Scrolled up: a resize leaves the reader where they are.
  scroller.scrollTop = 100
  await fireEvent.scroll(scroller)
  scrollHeight = 900
  callbacks.forEach((cb) => cb())
  expect(scroller.scrollTop).toBe(100)
})

const foldButton = (): HTMLElement =>
  within(screen.getByRole('heading', { name: /^Needs attention · \d+$/ })).getByRole('button')
const list = (): HTMLElement => document.querySelector('[data-attention-list]') as HTMLElement

it('folds and unfolds through the heading button', async () => {
  load([question])
  render(AttentionDock)
  expect(foldButton().getAttribute('aria-expanded')).toBe('true')
  expect(foldButton().getAttribute('aria-controls')).toBe(list().id)
  await fireEvent.click(foldButton())
  expect(activeSession.attentionFolded).toBe(true)
  expect(foldButton().getAttribute('aria-expanded')).toBe('false')
  expect(list().hasAttribute('hidden')).toBe(true)
  expect(document.querySelector('[data-attention-heading]')).toBeTruthy()
  await fireEvent.click(foldButton())
  expect(list().hasAttribute('hidden')).toBe(false)
  expect(foldButton().getAttribute('aria-expanded')).toBe('true')
})

it('keeps a typed value while folded', async () => {
  load([question])
  render(AttentionDock)
  const box = document.querySelector('[data-request-panel] input') as HTMLInputElement
  await fireEvent.input(box, { target: { value: 'ma' } })
  await fireEvent.click(foldButton())
  expect(document.querySelector('[data-request-panel] input')).toBe(box)
  await fireEvent.click(foldButton())
  expect((document.querySelector('[data-request-panel] input') as HTMLInputElement).value).toBe(
    'ma'
  )
})

it('unfolds on a push with a new request id and stays folded on a push that only removes one', async () => {
  load([question, permissionView({ id: 'p1' })])
  render(AttentionDock)
  await fireEvent.click(foldButton())
  activeSession.applyAttention({ sessionId: 's1', requests: [question] })
  await tick()
  expect(activeSession.attentionFolded).toBe(true)
  expect(list().hasAttribute('hidden')).toBe(true)
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [question, permissionView({ id: 'p9' })]
  })
  await tick()
  expect(activeSession.attentionFolded).toBe(false)
  expect(list().hasAttribute('hidden')).toBe(false)
})

it('a focus request unfolds the dock', async () => {
  load([question])
  render(AttentionDock)
  await fireEvent.click(foldButton())
  activeSession.focusRequest('q1')
  await tick()
  expect(list().hasAttribute('hidden')).toBe(false)
})

const panel = (id: string): HTMLElement =>
  document.querySelector(`[data-request-panel="${id}"]`) as HTMLElement

it('highlights the focused panel for two seconds and clears it', async () => {
  vi.useFakeTimers()
  try {
    load([permissionView({ id: 'p1' }), permissionView({ id: 'p2' })])
    render(AttentionDock)
    activeSession.focusRequest('p2')
    await vi.advanceTimersByTimeAsync(0)
    expect(panel('p2').hasAttribute('data-highlight')).toBe(true)
    expect(panel('p1').hasAttribute('data-highlight')).toBe(false)
    await vi.advanceTimersByTimeAsync(1900)
    expect(panel('p2').hasAttribute('data-highlight')).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(panel('p2').hasAttribute('data-highlight')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('a repeated focus request for the same panel restarts the two seconds', async () => {
  vi.useFakeTimers()
  try {
    load([permissionView({ id: 'p1' })])
    render(AttentionDock)
    activeSession.focusRequest('p1')
    await vi.advanceTimersByTimeAsync(1500)
    activeSession.focusRequest('p1')
    await vi.advanceTimersByTimeAsync(1500)
    expect(panel('p1').hasAttribute('data-highlight')).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(panel('p1').hasAttribute('data-highlight')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('a focus request without an id only unfolds and highlights nothing', async () => {
  load([permissionView({ id: 'p1' })])
  render(AttentionDock)
  await fireEvent.click(foldButton())
  activeSession.focusRequest()
  await tick()
  expect(list().hasAttribute('hidden')).toBe(false)
  expect(document.querySelector('[data-highlight]')).toBeNull()
})

function withMessageBox(): HTMLTextAreaElement {
  const box = document.createElement('textarea')
  box.id = 'composer-input'
  document.body.append(box)
  return box
}

it('moves focus to the next panel when the answered panel leaves', async () => {
  load([permissionView({ id: 'p1' }), permissionView({ id: 'p2' }), permissionView({ id: 'p3' })])
  render(AttentionDock)
  const first = within(panel('p2')).getAllByRole('button')[0]!
  first.focus()
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p1' }), permissionView({ id: 'p3' })]
  })
  await waitFor(() =>
    expect(document.activeElement).toBe(within(panel('p3')).getAllByRole('button')[0])
  )
})

it('moves focus to the previous panel when the last one leaves', async () => {
  load([permissionView({ id: 'p1' }), permissionView({ id: 'p2' })])
  render(AttentionDock)
  within(panel('p2')).getAllByRole('button')[0]!.focus()
  activeSession.applyAttention({ sessionId: 's1', requests: [permissionView({ id: 'p1' })] })
  await waitFor(() =>
    expect(document.activeElement).toBe(within(panel('p1')).getAllByRole('button')[0])
  )
})

it('moves focus to the message box when the dock empties', async () => {
  const box = withMessageBox()
  try {
    load([permissionView({ id: 'p1' })])
    render(AttentionDock)
    within(panel('p1')).getAllByRole('button')[0]!.focus()
    activeSession.applyAttention({ sessionId: 's1', requests: [] })
    await waitFor(() => expect(document.activeElement).toBe(box))
  } finally {
    box.remove()
  }
})

it('does not steal focus when the panel that left did not hold it', async () => {
  const box = withMessageBox()
  try {
    load([permissionView({ id: 'p1' }), permissionView({ id: 'p2' })])
    render(AttentionDock)
    box.focus()
    activeSession.applyAttention({ sessionId: 's1', requests: [permissionView({ id: 'p2' })] })
    await tick()
    await tick()
    expect(document.activeElement).toBe(box)
  } finally {
    box.remove()
  }
})

// Spec 014, dock height: the first panel is always shown in full.
it('dockCap: a small panel keeps the dock at half the conversation', () => {
  expect(dockCap(800, 44, 200, 17)).toBe(400)
})

it('dockCap: a panel taller than half grows the dock to heading, panel and paddings', () => {
  expect(dockCap(800, 44, 400, 17)).toBe(461)
})

it('dockCap: a panel taller than 80% limits the dock to 80%', () => {
  expect(dockCap(800, 44, 700, 17)).toBe(640)
})

it('dockCap: unknown or zero sizes give no cap, so the base share applies', () => {
  expect(dockCap(0, 44, 200)).toBeNull()
  expect(dockCap(800, 0, 200)).toBeNull()
  expect(dockCap(800, 44, 0)).toBeNull()
  expect(dockCap(Number.NaN, 44, 200)).toBeNull()
})

it('the dock wrapper gets the computed cap from the measured sizes and leaves it alone without sizes', async () => {
  const callbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        callbacks.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  const sizes: Record<string, number> = { heading: 44, panel: 400 }
  const proto = HTMLElement.prototype
  const offset = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-attention-heading')) return sizes['heading']
      if (this.hasAttribute('data-request-panel')) return sizes['panel']
      return 0
    }
  })
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return this.hasAttribute('data-dock-region') ? 0 : 800
    }
  })
  try {
    load([permissionView({ id: 'p1' })])
    const dock = createRawSnippet(() => ({
      render: () =>
        '<section><h3 data-attention-heading>h</h3><div data-attention-list><div data-request-panel="p1"></div></div></section>'
    }))
    render(Conversation, { dock })
    await tick()
    const wrapper = document.querySelector('[data-dock-region]') as HTMLElement
    // Paddings are 0 in jsdom (no stylesheet), plus the one pixel of border: 44 + 400 + 1.
    expect(wrapper.style.maxHeight).toBe('445px')

    sizes['panel'] = 700
    callbacks.forEach((cb) => cb())
    expect(wrapper.style.maxHeight).toBe('640px')

    sizes['panel'] = 0
    callbacks.forEach((cb) => cb())
    expect(wrapper.style.maxHeight).toBe('')
  } finally {
    if (offset) Object.defineProperty(proto, 'offsetHeight', offset)
    else delete (proto as { offsetHeight?: unknown }).offsetHeight
    if (client) Object.defineProperty(Element.prototype, 'clientHeight', client)
    else delete (Element.prototype as { clientHeight?: unknown }).clientHeight
  }
})
