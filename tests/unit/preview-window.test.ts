import { beforeEach, expect, it, vi } from 'vitest'

interface FakeWin {
  opts: Record<string, unknown>
  destroyed: boolean
  minimized: boolean
  events: Map<string, (...a: never[]) => void>
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
}
const created: FakeWin[] = []

vi.mock('electron', () => {
  class BrowserWindow {
    opts: Record<string, unknown>
    destroyed = false
    minimized = false
    events = new Map<string, (...a: never[]) => void>()
    focus = vi.fn()
    restore = vi.fn()
    show = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      created.push(this as unknown as FakeWin)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    once(n: string, h: (...a: never[]) => void): void {
      this.events.set(n, h)
    }
    on(n: string, h: (...a: never[]) => void): void {
      this.events.set(n, h)
    }
  }
  return { BrowserWindow, app: { isPackaged: true } }
})

beforeEach(() => {
  created.length = 0
  vi.resetModules()
})

async function load(): Promise<typeof import('../../src/main/app/preview-window')> {
  return import('../../src/main/app/preview-window')
}

it('creates a hardened, preload-less, parentless window at the specified size', async () => {
  const { openDesignPreview } = await load()
  openDesignPreview()
  const o = created[0]!.opts
  expect([o['width'], o['height'], o['minWidth'], o['minHeight']]).toEqual([1000, 760, 720, 520])
  expect(o['parent']).toBeUndefined()
  expect(o['webPreferences']).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true
  })
  expect(created[0]!.loadFile.mock.calls[0]![0]).toMatch(/renderer\/preview\.html$/)
})

it('keeps a single instance and refocuses (restoring if minimized)', async () => {
  const { openDesignPreview } = await load()
  const first = openDesignPreview()
  created[0]!.minimized = true
  expect(openDesignPreview()).toBe(first)
  expect(created).toHaveLength(1)
  expect(created[0]!.restore).toHaveBeenCalled()
  expect(created[0]!.focus).toHaveBeenCalled()
})

it('has no close handler, and a new window opens after the old one closes', async () => {
  const { openDesignPreview } = await load()
  openDesignPreview()
  expect(created[0]!.events.has('close')).toBe(false)
  created[0]!.destroyed = true
  created[0]!.events.get('closed')!()
  openDesignPreview()
  expect(created).toHaveLength(2)
})
