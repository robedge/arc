import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7)
])

test('an imported png is served by harness-knowledge and foreign ids are refused', async ({
  app,
  window: page
}) => {
  const src = await mkdtemp(join(tmpdir(), 'harness-e2e-src-'))
  try {
    const file = join(src, 'pic.png')
    await writeFile(file, PNG)
    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('tab', { name: 'Docs' }).click()
    await app.evaluate(
      (_, p) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(p)
      },
      [file]
    )
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(
      page.getByRole('list', { name: 'Items' }).getByText('pic.png', { exact: true })
    ).toBeVisible()

    const result = await page.evaluate(async () => {
      const h = (
        window as unknown as {
          harness: { invoke(c: string, a: unknown): Promise<{ ok: boolean; data: unknown }> }
        }
      ).harness
      const groups = (await h.invoke('groups:list', {})).data as { id: string }[]
      const sections = (await h.invoke('sections:list', { groupId: groups[0]?.id })).data as {
        id: string
        kind: string
      }[]
      const docs = sections.find((s) => s.kind === 'docs')
      const items = (await h.invoke('items:list', { sectionId: docs?.id })).data as { id: string }[]
      const read = (await h.invoke('items:read', { itemId: items[0]?.id })).data as { url: string }
      const ok = await fetch(read.url)
      const bytes = (await ok.arrayBuffer()).byteLength
      const other = read.url.replace(/\/[0-9A-Z]{26}\?/, '/01ARZ3NDEKTSV4RRFFQ69G5FAV?')
      const wrongGroup = read.url.replace(/\/\/[0-9a-zA-Z]{26}\//, '//01arz3ndektsv4rrffq69g5fav/')
      return {
        url: read.url,
        status: ok.status,
        type: ok.headers.get('content-type'),
        bytes,
        otherItem: (await fetch(other)).status,
        otherGroup: (await fetch(wrongGroup)).status
      }
    })
    expect(result.url).toMatch(/^harness-knowledge:\/\/[0-9A-Z]{26}\/[0-9A-Z]{26}\?rev=/)
    expect(result.status).toBe(200)
    expect(result.type).toBe('image/png')
    expect(result.bytes).toBe(PNG.length)
    expect(result.otherItem).toBe(404)
    expect(result.otherGroup).toBe(404)
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
