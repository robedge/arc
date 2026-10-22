import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('items:pickImport copies queued files into Docs', async ({ app, window: page }) => {
  const src = await mkdtemp(join(tmpdir(), 'harness-e2e-src-'))
  try {
    const a = join(src, 'orders_schema.sql')
    const b = join(src, 'notes.md')
    await writeFile(a, 'CREATE TABLE orders (id int);\n')
    await writeFile(b, '# hi\n')

    const group = await page.evaluate(() =>
      window.harness.invoke('groups:create', { name: 'Shop' })
    )
    if (!group.ok) throw new Error('group create failed')
    const sections = await page.evaluate(
      (id) => window.harness.invoke('sections:list', { groupId: id }),
      group.data.id
    )
    const docs = sections.ok ? sections.data.find((s) => s.kind === 'docs') : undefined
    if (!docs) throw new Error('no docs section')

    await app.evaluate(
      (_, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [a, b]
    )

    const report = await page.evaluate(
      (id) => window.harness.invoke('items:pickImport', { sectionId: id }),
      docs.id
    )
    expect(report.ok && report.data.added.map((i) => i.title).sort()).toEqual([
      'notes',
      'orders_schema.sql'
    ])

    const listed = await page.evaluate(
      (id) => window.harness.invoke('items:list', { sectionId: id }),
      docs.id
    )
    expect(listed.ok && listed.data.map((i) => i.title).sort()).toEqual([
      'notes',
      'orders_schema.sql'
    ])

    const canceled = await page.evaluate(
      (id) => window.harness.invoke('items:pickImport', { sectionId: id }),
      docs.id
    )
    expect(canceled).toEqual({ ok: true, data: { added: [], failed: [], conflicts: [] } })
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
