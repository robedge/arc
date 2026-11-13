import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle, AttachmentRef } from '../../../../src/main/agents/agent-adapter'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import { ClaudeAdapter } from '../../../../src/main/agents/claude/claude-adapter'
import { INLINE_IMAGE_MAX_BYTES } from '../../../../src/main/attachments/inline-image'
import { createClaudeParser } from '../../../../src/main/agents/claude/claude-parser'
import { ProcessSupervisor } from '../../../../src/main/agents/process-supervisor'
import { TranscriptFormatter } from '../../../../src/main/sessions/terminal-log'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }
const recording = resolve('tests/fixtures/claude/attachments/stdout.jsonl')

let dir: string
const handles: AgentHandle[] = []
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-claude-img-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
})

const initEvent = {
  type: 'system',
  subtype: 'init',
  session_id: '{{SESSION_ID}}',
  model: 'fake',
  permissionMode: 'default',
  mcp_servers: []
}

// A real PNG signature plus filler: the stored file's bytes, not valid image data.
const png = (n: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)])

let counter = 0
function stored(
  name: string,
  kind: AttachmentRef['kind'],
  bytes: Buffer,
  mime?: string
): AttachmentRef {
  counter += 1
  const id = `01HIMG${String(counter).padStart(20, '0')}`
  const folder = join(dir, 'attachments', id)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(path, bytes)
  return {
    id,
    name,
    kind,
    mime:
      mime ?? (kind === 'image' ? 'image/png' : kind === 'pdf' ? 'application/pdf' : 'text/plain'),
    size: bytes.length,
    path
  }
}

interface Rig {
  handle: AgentHandle
  events: AgentEvent[]
  warnings: string[]
  userLines: () => { message: { content: Record<string, unknown>[] } }[]
  rawLog: () => string
  waitUserLines: (n: number) => Promise<void>
}

async function rig(steps: unknown[] = [{ emit: initEvent }, { waitForStdin: '*' }]): Promise<Rig> {
  const id = Math.random().toString(36).slice(2)
  const log = join(dir, `${id}.log`)
  const script = join(dir, `${id}.jsonl`)
  writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  const warnings: string[] = []
  const adapter = new ClaudeAdapter({
    supervisor: new ProcessSupervisor(),
    binary: process.execPath,
    binaryArgs: [fake],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    warn: (m) => warnings.push(m)
  })
  const handle = await adapter.start({
    provider: 'claude',
    agentId: 'brain',
    role: 'brain',
    cwd: process.cwd(),
    model: 'haiku',
    access: 'brain-readonly',
    claude: {},
    extraEnv: { ...nodeEnv, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_LOG: log }
  })
  handles.push(handle)
  const events: AgentEvent[] = []
  void (async () => {
    for await (const e of handle.events) events.push(e)
  })()
  const rawLog = (): string => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }
  const userLines = (): ReturnType<Rig['userLines']> =>
    rawLog()
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { stdin?: { type?: string } }).stdin)
      .filter((x): x is NonNullable<typeof x> => x?.type === 'user') as ReturnType<Rig['userLines']>
  const waitUserLines = async (n: number): Promise<void> => {
    const deadline = Date.now() + 15_000
    while (userLines().length < n && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25))
  }
  const deadline = Date.now() + 5000
  while (!events.some((e) => e.type === 'session') && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10))
  return { handle, events, warnings, userLines, rawLog, waitUserLines }
}

const imageBlock = (data: Buffer, mime = 'image/png'): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: mime, data: data.toString('base64') }
})

describe('ClaudeAdapter native image blocks (spec 012 2.8)', () => {
  it('sends the text block, then one base64 image block with the file bytes', async () => {
    const bytes = png(300)
    const att = stored('shot.png', 'image', bytes)
    const r = await rig()
    await r.handle.send('What is this?', [att])
    await r.waitUserLines(1)
    const [line] = r.userLines()
    const content = line!.message.content
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(String(content[0]!['text'])).toContain(`${att.id} · shot.png · image`)
    expect(content[1]).toEqual(imageBlock(bytes))
  })

  it('adds one block per image in attachment order and uses each stored mime', async () => {
    const a = png(10)
    const b = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20, 1)])
    const imgA = stored('a.png', 'image', a)
    const imgB = stored('b.jpg', 'image', b, 'image/jpeg')
    const r = await rig()
    await r.handle.send('two', [imgA, imgB])
    await r.waitUserLines(1)
    const content = r.userLines()[0]!.message.content
    expect(content.slice(1)).toEqual([imageBlock(a), imageBlock(b, 'image/jpeg')])
    expect(String(content[0]!['text'])).toContain('a.png')
    expect(String(content[0]!['text'])).toContain('b.jpg')
  })

  it('gives an image at exactly the limit a block and one byte over it none (path only)', async () => {
    const atLimit = stored('at.png', 'image', Buffer.alloc(INLINE_IMAGE_MAX_BYTES, 9))
    const over = stored('over.png', 'image', Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1, 9))
    const r = await rig()
    await r.handle.send('limit', [atLimit, over])
    await r.waitUserLines(1)
    const content = r.userLines()[0]!.message.content
    // The whole line (about 7 MB of base64) arrived untruncated: it parsed, with both files listed.
    expect(content).toHaveLength(2)
    expect((content[1] as { source: { data: string } }).source.data).toBe(
      Buffer.alloc(INLINE_IMAGE_MAX_BYTES, 9).toString('base64')
    )
    const text = String(content[0]!['text'])
    expect(text).toContain('at.png')
    expect(text).toContain(over.path)
  })

  it('never adds a native block for a PDF or a text file, and keeps the text block unchanged', async () => {
    const pdf = stored('doc.pdf', 'pdf', Buffer.from('%PDF-1.4 tiny'))
    const txt = stored('notes.txt', 'text', Buffer.from('hello'))
    const r = await rig()
    await r.handle.send('files', [pdf, txt])
    await r.waitUserLines(1)
    const content = r.userLines()[0]!.message.content
    expect(content).toHaveLength(1)
    expect(String(content[0]!['text'])).toContain(pdf.path)
    expect(String(content[0]!['text'])).toContain(txt.path)
  })

  it('sends without the block when the file is gone, keeps the path line, and warns without path or contents', async () => {
    const gone = stored('gone.png', 'image', png(50))
    const kept = stored('kept.png', 'image', png(60))
    rmSync(gone.path)
    const r = await rig()
    expect(await r.handle.send('missing', [gone, kept])).toBe(true)
    await r.waitUserLines(1)
    const content = r.userLines()[0]!.message.content
    expect(content).toHaveLength(2)
    expect(content[1]).toEqual(imageBlock(png(60)))
    expect(String(content[0]!['text'])).toContain(gone.path)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).not.toContain(gone.path)
    expect(r.warnings[0]).not.toContain(gone.name)
    expect(r.warnings[0]).not.toContain(png(50).toString('base64'))
  })

  it('writes a message without attachments exactly as before', async () => {
    const r = await rig()
    await r.handle.send('plain')
    await r.waitUserLines(1)
    expect(r.userLines()[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'plain' }] }
    })
  })

  it('a message sent while a turn runs carries its image blocks, in order with the other sends', async () => {
    const one = png(20)
    const two = png(30)
    const r = await rig()
    await r.handle.send('first', [stored('one.png', 'image', one)])
    await r.handle.send('second', [stored('two.png', 'image', two)])
    await r.handle.send('third')
    await r.waitUserLines(3)
    const lines = r.userLines()
    expect(lines[0]!.message.content[1]).toEqual(imageBlock(one))
    expect(lines[1]!.message.content[1]).toEqual(imageBlock(two))
    expect(lines[2]!.message.content).toHaveLength(1)
  })

  it('does not put base64 in the log or the events it emits for an outgoing image', async () => {
    const bytes = png(2000)
    const r = await rig()
    await r.handle.send('look', [stored('big.png', 'image', bytes)])
    await r.waitUserLines(1)
    const payload = bytes.toString('base64')
    expect(r.warnings.join('\n')).not.toContain(payload)
    expect(JSON.stringify(r.events)).not.toContain(payload)
  })
})

/** The recording's lines with its base64 placeholders replaced by a payload that is easy to find. */
const PAYLOAD = `SYNTHETICPAYLOAD${'QUJDREVGR0g='.repeat(40)}`
function recordedLines(): string[] {
  return readFileSync(recording, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/<base64 omitted, \d+ bytes>/g, PAYLOAD))
}

describe('replayed user events and PDF tool results hold no base64 (spec 012 2.8)', () => {
  const replay = recordedLines().find((l) => l.includes('"isReplay":true'))!
  const pdfResult = recordedLines().find((l) => l.includes('"type":"document"'))!

  it('the fixture lines carry the payload in the three places the real CLI puts it', () => {
    expect(replay).toContain(`"data":"${PAYLOAD}"`)
    expect(pdfResult).toContain(`"data":"${PAYLOAD}"`)
    expect(pdfResult).toContain(`"base64":"${PAYLOAD}"`)
  })

  it('the parser emits no event from either line that holds the payload', () => {
    const parser = createClaudeParser({ agentId: 'brain', now: () => 1 })
    const events = [...parser.parse(replay), ...parser.parse(pdfResult)]
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('SYNTHETICPAYLOAD')
  })

  it('the whole recording through the parser and the terminal formatter holds no payload', () => {
    const parser = createClaudeParser({ agentId: 'brain', now: () => 1 })
    const formatter = new TranscriptFormatter()
    const events = recordedLines().flatMap((l) => parser.parse(l))
    const text = events.map((e) => formatter.format(e)).join('') + formatter.finish()
    expect(text.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain('SYNTHETICPAYLOAD')
    expect(text).not.toContain('SYNTHETICPAYLOAD')
    // The orchestrator writes DB event rows from fixed texts (logEvent) and ignores tool-result,
    // stderr and unknown events, so nothing above reaches the events table.
  })

  it('through the adapter, a replayed image message and a PDF result leave no payload in any event', async () => {
    const r = await rig([
      { emit: initEvent },
      { waitForStdin: '*' },
      { emit: JSON.parse(replay) },
      { emit: JSON.parse(pdfResult) }
    ])
    await r.handle.send('look', [stored('p.png', 'image', png(40))])
    await new Promise((res) => setTimeout(res, 400))
    expect(JSON.stringify(r.events)).not.toContain('SYNTHETICPAYLOAD')
    expect(r.events.some((e) => e.type === 'tool-result')).toBe(true)
    expect(r.warnings.join('')).not.toContain('SYNTHETICPAYLOAD')
  })

  it('an echoed message over the 4 MB line limit is dropped without an error line in the transcript, once per image message', async () => {
    const big = JSON.parse(replay) as { message: { content: { source?: { data: string } }[] } }
    big.message.content[1]!.source!.data = 'A'.repeat(6 * 1024 * 1024)
    const r = await rig([
      { emit: initEvent },
      { waitForStdin: '*' },
      { emit: big },
      { emit: JSON.parse(pdfResult) }
    ])
    await r.handle.send('look', [stored('echo.png', 'image', Buffer.alloc(4_500_000, 3))])
    const deadline = Date.now() + 10_000
    while (!r.events.some((e) => e.type === 'tool-result') && Date.now() < deadline)
      await new Promise((res) => setTimeout(res, 25))
    expect(r.events.some((e) => e.type === 'tool-result')).toBe(true)
    expect(r.events.filter((e) => e.type === 'error')).toEqual([])
  })
})
