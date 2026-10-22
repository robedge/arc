import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShellService } from '../../../src/main/platform/shell-service'
import type { ShellE2eHook } from '../../../src/main/platform/shell-service'
import { createRevealResolver } from '../../../src/main/knowledge/reveal-path'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf, createEnv } from '../knowledge/knowledge-test-env'
import type { KnowledgeEnv } from '../knowledge/knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv
let linksId: string

beforeEach(async () => {
  env = await createEnv(dir())
  const links = (await env.sections.list(env.groupId)).find((s) => s.kind === 'links')
  if (!links) throw new Error('no links section')
  linksId = links.id
})
afterEach(() => env.opened.sqlite.close())

function makeShell(
  environment: NodeJS.ProcessEnv,
  target?: { __e2e?: Partial<ShellE2eHook> }
): {
  openExternal: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
  openPath: ReturnType<typeof vi.fn>
  shell: ReturnType<typeof createShellService>
} {
  const openExternal = vi.fn(() => Promise.resolve())
  const showItemInFolder = vi.fn()
  const openPath = vi.fn(() => Promise.resolve(''))
  const shell = createShellService({
    env: environment,
    openExternal,
    readLinkUrl: (id) => env.service.readLinkUrl(id),
    resolveRevealPath: createRevealResolver({
      sectionsRepo: env.sectionsRepo,
      itemsRepo: env.itemsRepo,
      getKnowledgeRoot: () => env.root
    }),
    showItemInFolder,
    openPath,
    ...(target ? { target } : {})
  })
  return { openExternal, showItemInFolder, openPath, shell }
}

describe('openLink', () => {
  it('opens a valid url', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://wiki.example.com/orders',
      title: 'Orders'
    })
    const { openExternal, shell } = makeShell({})
    await shell.openLink(item.id)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://wiki.example.com/orders')
  })

  it('revalidates the file on disk and refuses a file: url', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://wiki.example.com/orders',
      title: 'Orders'
    })
    // Prime the cache with the valid url, then edit the file behind the app's back.
    await env.service.list(linksId)
    await writeFile(
      join(env.root, 'Links', 'Orders.md'),
      '---\nurl: "file:///etc/passwd"\ntitle: "Orders"\n---\n'
    )
    const { openExternal, shell } = makeShell({})
    expect(await codeOf(shell.openLink(item.id))).toBe('LINK_TARGET_INVALID')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('records instead of opening in E2E mode, keeping other hooks', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://wiki.example.com/orders'
    })
    const target: { __e2e?: Partial<ShellE2eHook> & { other?: number } } = { __e2e: { other: 1 } }
    const { openExternal, shell } = makeShell({ HARNESS_E2E: '1' }, target)
    await shell.openLink(item.id)
    expect(openExternal).not.toHaveBeenCalled()
    expect(target.__e2e?.getShellCalls?.()).toEqual([
      { kind: 'openLink', url: 'https://wiki.example.com/orders' }
    ])
    expect(target.__e2e?.other).toBe(1)
  })
})

describe('openUrl', () => {
  it.each(['https://example.com/a', 'http://example.com'])('opens %s', async (url) => {
    const { openExternal, shell } = makeShell({})
    await shell.openUrl(url)
    expect(openExternal).toHaveBeenCalledWith(url)
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com'])(
    'rejects scheme %s',
    async (url) => {
      const { openExternal, shell } = makeShell({})
      expect(await codeOf(shell.openUrl(url))).toBe('LINK_TARGET_INVALID')
      expect(openExternal).not.toHaveBeenCalled()
    }
  )

  it('rejects a malformed address', async () => {
    const { openExternal, shell } = makeShell({})
    expect(await codeOf(shell.openUrl('not a url'))).toBe('LINK_TARGET_INVALID')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('records instead of opening in E2E mode', async () => {
    const target: { __e2e?: Partial<ShellE2eHook> } = {}
    const { openExternal, shell } = makeShell({ HARNESS_E2E: '1' }, target)
    await shell.openUrl('https://example.com/x')
    expect(openExternal).not.toHaveBeenCalled()
    expect(target.__e2e?.getShellCalls?.()).toEqual([
      { kind: 'openUrl', url: 'https://example.com/x' }
    ])
  })
})

describe('reveal', () => {
  it('reveals an item file in Finder by id', async () => {
    const item = await env.service.create(env.notesId, 'Runbook')
    const { shell, showItemInFolder, openPath } = makeShell({})
    await shell.reveal({ groupId: env.groupId, itemId: item.id })
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(env.root, 'Notes', 'Runbook.md'))
    expect(openPath).not.toHaveBeenCalled()
  })

  it('opens a section folder, and the knowledge root when no ids are given', async () => {
    const { shell, openPath } = makeShell({})
    await shell.reveal({ groupId: env.groupId, sectionId: env.notesId })
    await shell.reveal({ groupId: env.groupId })
    expect(openPath.mock.calls).toEqual([[join(env.root, 'Notes')], [env.root]])
  })

  it('rejects ids from another group', async () => {
    const item = await env.service.create(env.notesId, 'Runbook')
    const { shell, showItemInFolder } = makeShell({})
    expect(await codeOf(shell.reveal({ groupId: 'other', itemId: item.id }))).toBe(
      'VALIDATION_FAILED'
    )
    expect(await codeOf(shell.reveal({ groupId: 'other', sectionId: env.notesId }))).toBe(
      'VALIDATION_FAILED'
    )
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('reports a missing file instead of revealing', async () => {
    const item = await env.service.create(env.notesId, 'Runbook')
    await rm(join(env.root, 'Notes', 'Runbook.md'))
    const { shell } = makeShell({})
    expect(await codeOf(shell.reveal({ groupId: env.groupId, itemId: item.id }))).toBe(
      'FOLDER_MISSING'
    )
  })

  it('records the resolved path under HARNESS_E2E instead of calling Finder', async () => {
    const item = await env.service.create(env.notesId, 'Runbook')
    const target: { __e2e?: Partial<ShellE2eHook> } = {}
    const { shell, showItemInFolder, openPath } = makeShell({ HARNESS_E2E: '1' }, target)
    await shell.reveal({ groupId: env.groupId, itemId: item.id })
    await shell.reveal({ groupId: env.groupId })
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
    expect(target.__e2e?.getShellCalls?.()).toEqual([
      { kind: 'reveal', path: join(env.root, 'Notes', 'Runbook.md') },
      { kind: 'reveal', path: env.root }
    ])
  })
})
