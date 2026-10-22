import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { createClaudeParser } from '../../../src/main/agents/claude-parser'
import { createCursorParser } from '../../../src/main/agents/cursor/cursor-parser'
import {
  RESULT_MAX_LINES,
  TRIM_MARKER,
  TerminalLog,
  TranscriptFormatter,
  readTerminalFile,
  stripAnsi
} from '../../../src/main/sessions/terminal-log'
import type { TerminalChunk } from '../../../src/main/sessions/terminal-log'

const fixtures = resolve('tests/fixtures/claude/2.1.302')

function parseFixture(name: string): AgentEvent[] {
  const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
  return readFileSync(resolve(fixtures, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => parser.parse(line))
}

function transcript(events: readonly AgentEvent[]): string {
  const f = new TranscriptFormatter()
  return events.map((e) => f.format(e)).join('') + f.finish()
}

const base = { agentId: 'w', ts: 1 }
const toolUse = (id: string, name: string, summary: string): AgentEvent => ({
  ...base,
  type: 'tool-use',
  toolUseId: id,
  name,
  summary
})
const toolResult = (id: string, content: string, isError = false): AgentEvent => ({
  ...base,
  type: 'tool-result',
  toolUseId: id,
  isError,
  content
})

describe('transcript formatting', () => {
  it('shows a Cursor text chunk as it arrives and does not repeat it when the message flushes', () => {
    const parser = createCursorParser({ agentId: 'w', now: () => 1 })
    const chunk = (text: string): AgentEvent[] =>
      parser.parse('session/update', {
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
      })
    const f = new TranscriptFormatter()
    const session: AgentEvent = {
      ...base,
      type: 'session',
      provider: 'cursor',
      providerSessionId: 's',
      model: 'auto',
      mcpServers: []
    }
    f.format(session)
    // Chunks only: no tool call, no turn end yet. The text is already in the transcript.
    expect([...chunk('Looking '), ...chunk('at the repo.')].map((e) => f.format(e)).join('')).toBe(
      'Looking at the repo.'
    )
    // The turn ends: the flushed message only ends the line, and the next item starts on a fresh one.
    const rest = parser.endTurn({ stopReason: 'end_turn' }).map((e) => f.format(e))
    expect(rest.join('')).toBe('\n')
  })

  it('starts a tool line on a new line after streamed Cursor text', () => {
    const f = new TranscriptFormatter()
    f.format({
      ...base,
      type: 'session',
      provider: 'cursor',
      providerSessionId: 's',
      model: 'auto',
      mcpServers: []
    })
    const delta = (text: string): AgentEvent => ({
      ...base,
      type: 'text-delta',
      messageId: 'm1',
      text
    })
    const out = [delta('Hi'), toolUse('t1', 'Bash', 'Bash: ls')].map((e) => f.format(e)).join('')
    expect(out).toBe('Hi\n▸ Bash  ls\n')
  })

  it('renders a text turn as the assistant text', () => {
    expect(transcript(parseFixture('text-turn.jsonl'))).toBe('pong\n')
  })

  it('hides ToolSearch and unlisted Arc tools, with their results', () => {
    const out = transcript(parseFixture('tool-turn.jsonl'))
    expect(out).not.toContain('ToolSearch')
    expect(out).not.toMatch(/^▸/m)
    expect(out).not.toContain('tool_reference')
    expect(out).toContain('pong-ro')
  })

  it('renders a Bash call and its result from a real stream', () => {
    const out = transcript(parseFixture('permission-prompt.jsonl'))
    expect(out).toMatch(/^▸ Bash {2}echo hi > out\.txt$/m)
  })

  it('renders Arc bridge calls readably and hides the other ones', () => {
    const out = transcript([
      toolUse('a', 'mcp__arc__report_progress', 'mcp__arc__report_progress: Parsing the config'),
      toolResult('a', '{"ok":true}'),
      toolUse('b', 'mcp__arc__report_done', 'mcp__arc__report_done: Added the flag'),
      toolUse('c', 'mcp__arc__ask_brain', 'mcp__arc__ask_brain: Which port?'),
      toolUse('d', 'mcp__arc__get_status', 'mcp__arc__get_status'),
      toolResult('d', 'noise')
    ])
    expect(out).toBe('• Parsing the config\n✓ Done: Added the flag\n? Which port?\n')
  })

  it('trims a long tool result to 20 lines and counts the rest', () => {
    const lines = Array.from({ length: 34 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = transcript([toolUse('t', 'Bash', 'Bash: pnpm test'), toolResult('t', lines)])
    const rows = out.trimEnd().split('\n')
    expect(rows[0]).toBe('▸ Bash  pnpm test')
    expect(rows).toHaveLength(1 + RESULT_MAX_LINES + 1)
    expect(rows[RESULT_MAX_LINES]).toBe('  line 20')
    expect(rows.at(-1)).toBe('  … 14 more lines')
  })

  it('marks a failed tool result', () => {
    const out = transcript([toolUse('t', 'Read', 'Read: /a'), toolResult('t', 'ENOENT', true)])
    expect(out).toBe('▸ Read  /a\n  ✗ error\n  ENOENT\n')
  })

  it('prefixes stderr lines and holds back a partial line', () => {
    const f = new TranscriptFormatter()
    const a = f.format({ ...base, type: 'stderr', text: 'warn: one\nwar' })
    const b = f.format({ ...base, type: 'stderr', text: 'n: two\n\n' })
    expect(a).toBe('stderr │ warn: one\n')
    expect(b).toBe('stderr │ warn: two\n')
    f.format({ ...base, type: 'stderr', text: 'tail' })
    expect(f.finish()).toBe('stderr │ tail\n')
  })
})

describe('stripAnsi', () => {
  it('removes colors, cursor moves, OSC titles and stray control characters', () => {
    const raw =
      '\u001b[31mred\u001b[0m \u001b[2K\u001b[1Gdone\u001b]0;title\u0007 ok\r\nnext\u0000\u0007'
    expect(stripAnsi(raw)).toBe('red done ok\nnext')
  })

  it('is applied to results and stderr', () => {
    const out = transcript([
      toolUse('t', 'Bash', 'Bash: ls'),
      toolResult('t', '\u001b[32mgreen\u001b[0m'),
      { ...base, type: 'stderr', text: '\u001b[33mwarn\u001b[0m\n' }
    ])
    expect(out).toBe('▸ Bash  ls\n  green\nstderr │ warn\n')
  })
})

describe('TerminalLog', () => {
  let dir: string
  let path: string
  let chunks: TerminalChunk[]
  let logs: TerminalLog[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arc-term-'))
    path = join(dir, 'workers', 'w1.log')
    chunks = []
    logs = []
  })
  afterEach(async () => {
    vi.useRealTimers()
    // A log that was only disposed still has an append (and its mkdir) in flight; deleting the folder under it
    // is what made this file fail now and then with ENOTEMPTY. Let every write finish first.
    for (const log of logs) log.dispose()
    await Promise.all(logs.map((log) => log.settled()))
    rmSync(dir, { recursive: true, force: true })
  })

  const make = (extra: Partial<ConstructorParameters<typeof TerminalLog>[0]> = {}): TerminalLog => {
    const log = new TerminalLog({
      workerId: 'w1',
      path,
      onChunk: (_id, c) => chunks.push(c),
      ...extra
    })
    logs.push(log)
    return log
  }

  it('batches writes every 50 ms and numbers chunks monotonically', async () => {
    vi.useFakeTimers()
    const log = make()
    log.write('a\n')
    log.write('b\n')
    expect(chunks).toEqual([])
    vi.advanceTimersByTime(50)
    expect(chunks).toEqual([{ seq: 1, text: 'a\nb\n' }])
    log.write('c\n')
    vi.advanceTimersByTime(50)
    expect(chunks.map((c) => c.seq)).toEqual([1, 2])
    log.write('x'.repeat(5000))
    expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3])
    log.dispose()
  })

  it('writes the transcript to the .log file', async () => {
    const log = make({ flushMs: 1 })
    log.status('Working')
    log.write('hello\n')
    log.finish('Done')
    await log.settled()
    expect(readFileSync(path, 'utf8')).toBe('── Working ──\nhello\n── Done ──\n')
  })

  it('caps the file by trimming the head and leaving a marker line', async () => {
    const log = make({ fileMaxBytes: 1000, flushMs: 1 })
    for (let i = 0; i < 40; i++) log.write(`line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}\n`)
    log.finish()
    await log.settled()
    const text = readFileSync(path, 'utf8')
    expect(statSync(path).size).toBeLessThanOrEqual(1000)
    expect(text.startsWith(`${TRIM_MARKER}\n`)).toBe(true)
    expect(text).not.toContain('line 000 ')
    expect(text.trimEnd().endsWith(`line 039 ${'x'.repeat(40)}`)).toBe(true)
    // The kept part starts on a line boundary.
    expect(text.split('\n')[1]).toMatch(/^line \d{3} x+$/)
    expect((await log.openBacklog(false)).truncated).toBe(true)
  })

  it('gives a live worker the in-memory tail and a finished one the whole file', async () => {
    const log = make({ tailChars: 30, flushMs: 1 })
    log.write('first line here\n')
    log.write('second line here\n')
    log.write('third line here\n')
    log.finish()
    const live = await log.openBacklog(true)
    expect(live.backlog.length).toBe(30)
    expect(live.backlog.endsWith('third line here\n')).toBe(true)
    expect(live.truncated).toBe(true)
    expect(live.seq).toBe(chunks.at(-1)?.seq)
    const done = await log.openBacklog(false)
    expect(done.backlog).toBe('first line here\nsecond line here\nthird line here\n')
    expect(done.truncated).toBe(false)
  })

  it('keeps unflushed text out of the backlog so its chunk is not a duplicate', async () => {
    vi.useFakeTimers()
    const log = make()
    log.write('old\n')
    vi.advanceTimersByTime(50)
    log.write('pending\n')
    const open = await log.openBacklog(true)
    expect(open).toEqual({ backlog: 'old\n', seq: 1, truncated: false })
    vi.advanceTimersByTime(50)
    expect(chunks.at(-1)).toEqual({ seq: 2, text: 'pending\n' })
    log.dispose()
  })

  it('reloads the file after a restart and keeps appending', async () => {
    mkdtempSync(dir)
    const first = make({ flushMs: 1 })
    first.write('before\n')
    first.finish()
    await first.settled()
    const second = make({ flushMs: 1 })
    second.write('after\n')
    second.finish()
    const live = await second.openBacklog(true)
    expect(live.backlog).toBe('before\nafter\n')
    expect(readFileSync(path, 'utf8')).toBe('before\nafter\n')
  })

  it('reads a finished worker with no live log straight from the file', async () => {
    expect(await readTerminalFile(join(dir, 'missing.log'))).toEqual({
      backlog: '',
      seq: 0,
      truncated: false
    })
    writeFileSync(join(dir, 'x.log'), `${TRIM_MARKER}\nrest\n`)
    expect(await readTerminalFile(join(dir, 'x.log'))).toEqual({
      backlog: `${TRIM_MARKER}\nrest\n`,
      seq: 0,
      truncated: true
    })
  })

  it('builds the transcript from events and pushes it', async () => {
    const log = make({ flushMs: 1 })
    log.status('Working')
    for (const e of parseFixture('permission-prompt.jsonl')) log.event(e)
    log.event({ ...base, type: 'stderr', text: 'oops\n' })
    log.finish('Done')
    await log.settled()
    const file = readFileSync(path, 'utf8')
    expect(file).toContain('▸ Bash  echo hi > out.txt')
    expect(file).toContain('stderr │ oops')
    expect(chunks.map((c) => c.text).join('')).toBe(file)
  })
})
