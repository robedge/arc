import { extname } from 'node:path'
import { BINARY_EXTENSIONS, TEXT_EXTENSIONS } from '@shared/limits'

export type ImportClass = 'text' | 'binary'

/** Extension (lower-case, with dot) -> class, for every type the product knows about. */
const EXTENSION_CLASS = new Map<string, ImportClass>([
  ...TEXT_EXTENSIONS.map((e): [string, ImportClass] => [`.${e}`, 'text']),
  ...BINARY_EXTENSIONS.map((e): [string, ImportClass] => [`.${e}`, 'binary'])
])

/** The classes that can be imported, indexed and listed. */
const ENABLED_CLASSES: ReadonlySet<ImportClass> = new Set<ImportClass>(['text', 'binary'])

const BINARY_MIME = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml']
])

/** MIME type of a servable binary file by extension, else null (text is never servable). */
export function binaryMimeOf(fileName: string): string | null {
  return BINARY_MIME.get(extname(fileName).toLowerCase()) ?? null
}

export const SNIFF_BYTES = 4096

/** The class of `fileName` when its extension is known and enabled, else null. */
export function importClassOf(fileName: string): ImportClass | null {
  const cls = EXTENSION_CLASS.get(extname(fileName).toLowerCase())
  return cls && ENABLED_CLASSES.has(cls) ? cls : null
}

/** Extensions (no dot) for the native open dialog filter. */
export function enabledExtensions(): string[] {
  return [...EXTENSION_CLASS]
    .filter(([, cls]) => ENABLED_CLASSES.has(cls))
    .map(([ext]) => ext.slice(1))
}

/** True when the head of a text file is valid UTF-8 without NUL bytes (a cut final char is fine). */
export function looksLikeText(head: Uint8Array, wholeFile: boolean): boolean {
  if (head.includes(0)) return false
  try {
    // stream:true keeps an incomplete trailing multi-byte sequence pending instead of failing.
    // A fresh decoder per call: a shared one keeps pending bytes after a failed decode.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !wholeFile })
    return true
  } catch {
    return false
  }
}

function startsWith(head: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((b, i) => head[offset + i] === b)
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

/** True when the head of a file carries the magic bytes its binary extension promises. */
export function sniffBinary(fileName: string, head: Uint8Array, wholeFile: boolean): boolean {
  switch (extname(fileName).toLowerCase()) {
    case '.pdf':
      return startsWith(head, ascii('%PDF-'))
    case '.png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case '.jpg':
    case '.jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff])
    case '.gif':
      return startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))
    case '.webp':
      return startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)
    case '.svg':
      return (
        looksLikeText(head, wholeFile) &&
        new TextDecoder('utf-8').decode(head).toLowerCase().includes('<svg')
      )
    default:
      return false
  }
}
