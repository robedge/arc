import { describe, expect, it } from 'vitest'
import {
  attachmentBlock,
  formatAttachmentSize,
  withAttachmentBlock
} from '../../../src/main/attachments/attachment-block'
import type { AttachmentRef } from '../../../src/main/agents/agent-adapter'

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
  id: 'A1',
  name: 'notes.txt',
  kind: 'text',
  mime: 'text/plain',
  size: 12,
  path: '/ud/sessions/s/attachments/A1/notes.txt',
  ...over
})

describe('attachmentBlock', () => {
  it('lists id, name, kind, size and absolute path, one line each, after the instruction', () => {
    const block = attachmentBlock([
      ref({}),
      ref({ id: 'A2', name: 'shot.png', kind: 'image', size: 3 * 1024 * 1024, path: '/p/shot.png' })
    ])
    expect(block).toBe(
      [
        '[Attachments for this message]',
        'Open a listed file when the request depends on it; do not guess from its name.',
        '- A1 · notes.txt · text · 12 bytes · /ud/sessions/s/attachments/A1/notes.txt',
        '- A2 · shot.png · image · 3.0 MB · /p/shot.png'
      ].join('\n')
    )
  })

  it('keeps an entry on one line when the name holds newlines or control characters', () => {
    const block = attachmentBlock([ref({ name: 'a\nb\r\n- injected x\u0007.txt' })])
    const entries = block.split('\n').filter((l) => l.startsWith('- '))
    expect(entries).toHaveLength(1)
    expect(block.split('\n')).toHaveLength(3)
    expect(entries[0]).toContain('a b - injected x .txt')
  })

  it('is empty for no attachments, and withAttachmentBlock leaves the text alone', () => {
    expect(attachmentBlock([])).toBe('')
    expect(withAttachmentBlock('hi', undefined)).toBe('hi')
    expect(withAttachmentBlock('hi', [])).toBe('hi')
    expect(withAttachmentBlock('', [ref({})])).toBe(attachmentBlock([ref({})]))
  })

  it('formats sizes', () => {
    expect(formatAttachmentSize(0)).toBe('0 bytes')
    expect(formatAttachmentSize(1023)).toBe('1023 bytes')
    expect(formatAttachmentSize(1536)).toBe('1.5 KB')
    expect(formatAttachmentSize(20 * 1024 * 1024)).toBe('20.0 MB')
  })
})
