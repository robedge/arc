import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import ItemDetail from '../../src/renderer/src/lib/components/items/ItemDetail.svelte'
import { itemDraft } from '../../src/renderer/src/lib/stores/item-draft.svelte'
import type { ItemSummary } from '../../src/shared/types/item'
import { mockHarness } from './helpers'

const fakePage = {
  getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
  render: () => ({ promise: Promise.resolve() })
}
const fakeDoc = { numPages: 2, getPage: vi.fn(async () => fakePage), destroy: vi.fn() }
const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
getDocument.mockImplementation(() => ({ promise: Promise.resolve(fakeDoc), destroy: vi.fn() }))

vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions: {} }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }))

class FakeObserver {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  static calls = 0
  observe(): void {
    FakeObserver.calls += 1
    this.cb([{ isIntersecting: true }])
  }
  disconnect(): void {}
}

function binaryItem(over: Partial<ItemSummary>): ItemSummary {
  return {
    id: 'b1',
    sectionId: 's',
    title: 'Diagram',
    fileName: 'diagram.png',
    description: '',
    kind: 'doc_binary',
    editable: false,
    revision: 'r',
    ...over
  }
}

beforeEach(() => {
  itemDraft.discard()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockRead(url: string, mime: string): void {
  mockHarness(() => ({ ok: true, data: { type: 'binary', url, mime } }))
}

it('renders a png via <img> with no editor controls', async () => {
  mockRead('harness-knowledge://g/b1?rev=r', 'image/png')
  const { container } = render(ItemDetail, { item: binaryItem({}) })
  await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
  expect(container.querySelector('img')?.getAttribute('src')).toBe('harness-knowledge://g/b1?rev=r')
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  expect(screen.queryByText('Saved')).toBeNull()
  expect(container.querySelector('.cm-editor')).toBeNull()
  expect(screen.getByLabelText('Title')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
})

it('renders an svg through <img>, never inline', async () => {
  mockRead('harness-knowledge://g/b1?rev=r', 'image/svg+xml')
  const { container } = render(ItemDetail, { item: binaryItem({ fileName: 'a.svg' }) })
  await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
  expect(container.querySelector('[data-image-frame] svg')).toBeNull()
})

it('mounts the PDF viewer and shows the page count', async () => {
  mockRead('harness-knowledge://g/b1?rev=r', 'application/pdf')
  const { container } = render(ItemDetail, { item: binaryItem({ fileName: 'a.pdf' }) })
  expect(await screen.findByText('Page 1 of 2')).toBeTruthy()
  expect(getDocument).toHaveBeenCalledWith({ url: 'harness-knowledge://g/b1?rev=r' })
  expect(container.querySelectorAll('canvas')).toHaveLength(2)
  expect(FakeObserver.calls).toBe(4)
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
})

it('the PDF viewer frames white pages on surface-raised, fills its panel and has IconButton zoom', async () => {
  mockRead('harness-knowledge://g/b1?rev=r', 'application/pdf')
  const { container } = render(ItemDetail, { item: binaryItem({ fileName: 'a.pdf' }) })
  await screen.findByText('Page 1 of 2')
  const frame = container.querySelector('[data-pdf-frame]')!
  expect(frame.className).toContain('bg-surface-raised')
  expect(frame.className).toContain('overflow-auto')
  expect(frame.className).not.toMatch(/max-h-/)
  const html = container.innerHTML
  expect(html).not.toContain('720')
  expect(container.querySelector('canvas')!.classList.contains('bg-paper')).toBe(true)
  const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
  expect(zoomIn.getAttribute('data-variant')).toBe('secondary')
  const pages = frame.firstElementChild as HTMLElement
  expect(pages.style.width).toBe('100%')
  zoomIn.click()
  await waitFor(() => expect(pages.style.width).toBe('125%'))
})

it('the image viewer fills its framed panel with object-contain', async () => {
  mockRead('harness-knowledge://g/b1?rev=r', 'image/png')
  const { container } = render(ItemDetail, { item: binaryItem({}) })
  await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
  const img = container.querySelector('img')!
  expect(img.className).toContain('object-contain')
  expect(img.className).not.toMatch(/max-h/)
  const frame = container.querySelector('[data-image-frame]')!
  expect(frame.className).toContain('flex-1')
  expect(frame.className).not.toMatch(/max-h/)
})

it('the PDF error line shows the error icon beside the exact text', async () => {
  getDocument.mockImplementationOnce(() => ({
    promise: Promise.reject(new Error('bad')),
    destroy: vi.fn()
  }))
  mockRead('harness-knowledge://g/b1?rev=r', 'application/pdf')
  render(ItemDetail, { item: binaryItem({ fileName: 'a.pdf' }) })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe("This PDF couldn't be displayed.")
  expect(alert.querySelector('[data-icon="error"]')).not.toBeNull()
})
