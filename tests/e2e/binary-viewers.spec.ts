import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './fixtures'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function minimalPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 28 >>\nstream\n0 0 1 rg 20 20 100 100 re f\nendstream'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function queue(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

test('PNG and PDF open in read-only viewers without CSP violations', async ({
  app,
  window: page
}) => {
  const csp: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) csp.push(m.text())
  })
  const src = await mkdtemp(join(tmpdir(), 'harness-e2e-src-'))
  try {
    const png = join(src, 'pic.png')
    const pdf = join(src, 'doc.pdf')
    await writeFile(png, Buffer.from(PNG_BASE64, 'base64'))
    await writeFile(pdf, minimalPdf())

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('tab', { name: 'Docs' }).click()

    await queue(app, [png, pdf])
    await page.getByRole('button', { name: 'Import…' }).click()
    const list = page.getByRole('list', { name: 'Items' })
    await expect(list.getByText('pic.png', { exact: true })).toBeVisible()
    await expect(list.getByText('doc.pdf', { exact: true })).toBeVisible()

    await list.getByRole('button', { name: /pic\.png/ }).click()
    const img = page.locator('img[src^="harness-knowledge:"]')
    await expect(img).toBeVisible()
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0)

    await list.getByRole('button', { name: /doc\.pdf/ }).click()
    await expect(page.getByText('Page 1 of 1')).toBeVisible()
    const canvas = page.locator('canvas').first()
    await expect
      .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).width))
      .toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0)

    expect(csp).toEqual([])
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
