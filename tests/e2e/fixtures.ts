import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

interface HarnessFixtures {
  userDataDir: string
  app: ElectronApplication
  window: Page
}

/** The main window, picked by URL so a second window (the Design Preview) never confuses tests. */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow()
  const find = (): Page | undefined => app.windows().find((w) => w.url().endsWith('/index.html'))
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = find()
    if (page) return page
    if (Date.now() > deadline) throw new Error('Main window (index.html) did not appear')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Launch env for e2e: off-screen/inactive windows by default (set HARNESS_E2E_OFFSCREEN=0 to opt out).
 * Cursor points at a binary that does not exist, so an e2e never starts the user's real Cursor (its
 * model probe opens an ACP session); a spec that needs Cursor sets `HARNESS_CURSOR_BIN` to the fake.
 */
export function e2eEnv(userDataDir: string): Record<string, string> {
  return {
    HARNESS_CURSOR_BIN: join(tmpdir(), 'arc-e2e-no-cursor'),
    ...(process.env as Record<string, string>),
    HARNESS_USER_DATA: userDataDir,
    HARNESS_E2E: '1',
    HARNESS_E2E_OFFSCREEN: process.env['HARNESS_E2E_OFFSCREEN'] ?? '1'
  }
}

export const test = base.extend<HarnessFixtures>({
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-e2e-'))
    try {
      await use(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  app: async ({ userDataDir }, use) => {
    const app = await electron.launch({
      args: ['out/main/index.js'],
      env: e2eEnv(userDataDir)
    })
    const child = app.process()
    try {
      await use(app)
    } finally {
      // Never let a stuck quit hang teardown: bound the graceful close, then kill.
      let timer: ReturnType<typeof setTimeout> | undefined
      const closed = await Promise.race([
        app.close().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 10_000)
        })
      ]).catch(() => false)
      clearTimeout(timer)
      if (!closed) child.kill('SIGKILL')
    }
  },
  window: async ({ app }, use) => {
    await use(await mainWindow(app))
  }
})

export { expect } from '@playwright/test'
