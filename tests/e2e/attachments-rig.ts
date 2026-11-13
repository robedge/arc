import type { Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import type { Rig } from './sessions-rig'

/** Helpers shared by the spec 012 attachment e2e files: generated files, the picker stub, a synthetic paste. */

/** A one-page PDF of a few hundred bytes (the xref offsets are not needed to be attached). */
export function tinyPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      'trailer<</Root 1 0 R/Size 4>>\n%%EOF\n'
  )
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A valid 24 x 24 opaque PNG of a few hundred bytes (a flat teal square), built in code. */
export function tinyPng(): Buffer {
  const size = 24
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(size).fill([20, 160, 170]).flat())
  ])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Queues the paths the stubbed file picker returns on the next click of Attach. */
export async function queuePicker(r: Rig, paths: string[]): Promise<void> {
  await r.app.evaluate((_e, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

export const messageBox = (page: Page) => page.getByLabel('Message to the brain')
export const composerChips = (page: Page) => page.locator('[data-composer] [data-attachment-chip]')
export const underBox = (page: Page) => page.getByRole('list', { name: 'Attached files' })
export const sentMessages = (page: Page) =>
  page.getByRole('log', { name: 'Conversation' }).locator('[data-message-role="user"]')

/** A paste of one path-less image on the message box: what a screenshot on the clipboard looks like. */
export async function pasteImage(page: Page, png: Buffer): Promise<void> {
  await messageBox(page).focus()
  await page.evaluate((data) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(data)], 'image.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    })
    document.getElementById('composer-input')!.dispatchEvent(event)
  }, Array.from(png))
}
