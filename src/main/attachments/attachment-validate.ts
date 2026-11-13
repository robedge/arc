import { open, realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { IMPORT_MAX_BYTES, TEXT_EXTENSIONS } from '@shared/limits'
import type { AttachmentKind, AttachmentRefusalReason } from '@shared/attachments'
import { looksLikeText, sniffBinary } from '../knowledge/import-types'

export const NAME_MAX = 120
const PDF_SNIFF_BYTES = 1024
const TEXT_SNIFF_BYTES = 8 * 1024

const IMAGE_MIME = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
])
const TEXT_EXTS: ReadonlySet<string> = new Set(TEXT_EXTENSIONS.map((e) => `.${e}`))

export type Validation =
  | { ok: true; realPath: string; kind: AttachmentKind; mime: string; size: number }
  | { ok: false; reason: AttachmentRefusalReason }

/** The base name of a path (either separator style), the form shown to the user. */
export function displayName(path: string): string {
  return basename(path.replace(/\\/g, '/'))
}

/**
 * The name a staged file is stored under: base name only, no control characters, separators or NUL,
 * at most 120 characters with the extension kept, `attachment` when nothing is left.
 */
export function sanitizeName(name: string): string {
  let clean = [...displayName(name)]
    .filter((c) => {
      const code = c.charCodeAt(0)
      return code > 0x1f && code !== 0x7f && c !== '/' && c !== '\\'
    })
    .join('')
    .trim()
  if (clean === '.' || clean === '..') clean = ''
  if (clean.length > NAME_MAX) {
    const ext = extname(clean)
    const keep = ext.length < NAME_MAX ? ext : ''
    clean = clean.slice(0, NAME_MAX - keep.length) + keep
  }
  return clean === '' ? 'attachment' : clean
}

async function readHead(path: string, size: number): Promise<Uint8Array | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(Math.min(size, TEXT_SNIFF_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

const IMAGE_BY_EXT: ReadonlyArray<readonly [string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp']
]

export type BytesVerdict =
  | { ok: true; ext: string; mime: string; size: number }
  | { ok: false; reason: AttachmentRefusalReason }

/**
 * Decides whether pasted bytes are an image (tech spec 2.4): 1 byte to `IMPORT_MAX_BYTES`, and the
 * magic bytes say PNG, JPEG, GIF or WebP. The type the sender claimed is never consulted.
 */
export function validateImageBytes(bytes: Uint8Array): BytesVerdict {
  if (bytes.byteLength === 0) return { ok: false, reason: 'unsupported' }
  if (bytes.byteLength > IMPORT_MAX_BYTES) return { ok: false, reason: 'too_large' }
  const head = bytes.subarray(0, 16)
  for (const [ext, mime] of IMAGE_BY_EXT) {
    if (sniffBinary(`x.${ext}`, head, false)) return { ok: true, ext, mime, size: bytes.byteLength }
  }
  return { ok: false, reason: 'unsupported' }
}

/** Decides whether `path` can be attached (tech spec 2.4) and what kind of attachment it is. */
export async function validateAttachment(path: string): Promise<Validation> {
  let realPath: string
  let size: number
  try {
    realPath = await realpath(path)
    const info = await stat(realPath)
    if (info.isDirectory()) return { ok: false, reason: 'folder' }
    if (!info.isFile()) return { ok: false, reason: 'unsupported' }
    size = info.size
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const head = await readHead(realPath, size)
  if (!head) return { ok: false, reason: 'unreadable' }
  if (size === 0) return { ok: false, reason: 'unsupported' }
  if (size > IMPORT_MAX_BYTES) return { ok: false, reason: 'too_large' }

  const name = displayName(path)
  const ext = extname(name).toLowerCase()
  const whole = size <= TEXT_SNIFF_BYTES
  const imageMime = IMAGE_MIME.get(ext)
  if (imageMime) {
    return sniffBinary(name, head, whole)
      ? { ok: true, realPath, kind: 'image', mime: imageMime, size }
      : { ok: false, reason: 'unsupported' }
  }
  if (ext === '.pdf') {
    return Buffer.from(head.subarray(0, PDF_SNIFF_BYTES)).includes('%PDF-')
      ? { ok: true, realPath, kind: 'pdf', mime: 'application/pdf', size }
      : { ok: false, reason: 'unsupported' }
  }
  if (ext === '.svg' || TEXT_EXTS.has(ext) || looksLikeText(head, whole)) {
    return { ok: true, realPath, kind: 'text', mime: 'text/plain', size }
  }
  return { ok: false, reason: 'unsupported' }
}
