import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import type { AgentEvent } from '../agents/agent-events'
import { DELTA_FLUSH_BYTES, DELTA_FLUSH_MS, DeltaBatcher } from './batcher'

/**
 * A worker's terminal: a readable plain-text transcript built from its agent events (tech spec
 * 2.2 and 2.9). It is watch-only; nothing here writes to the process.
 *
 * Line format:
 *   assistant text as is
 *   ▸ Bash  pnpm test              a tool call
 *     <first 20 lines of the result>
 *     … 14 more lines
 *     ✗ error                      first line of a failed tool result
 *   • <note>                       report_progress
 *   ✓ Done: <summary>              report_done
 *   ? <question>                   ask_brain
 *   stderr │ <line>                a line the process wrote to stderr
 *   ── Working ──                  a status change
 *   > <line>                       what the user typed while in control
 *   ── You stepped in ──           step in, interrupt and hand back markers
 *     ↳ helper (<description>): ▸ Bash  ls   what a background helper agent does (indented)
 *     ↳ helper (<description>): started | finished (<status>)
 */

export const TAIL_MAX_CHARS = 1_000_000
export const FILE_MAX_BYTES = 20 * 1024 * 1024
/** After a head trim the file keeps this share of the cap, so trims are not repeated every flush. */
const FILE_KEEP_RATIO = 0.9
export const RESULT_MAX_LINES = 20
const LINE_MAX_CHARS = 1000
export const TRIM_MARKER = '── earlier output trimmed ──'
export const STDERR_PREFIX = 'stderr │ '
const HELPER_ARROW = '  ↳ '
/** What a helper's tool result shows: its first lines. */
const HELPER_RESULT_LINES = 3

// CSI sequences, OSC sequences (BEL or ST terminated), and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
// Control characters other than tab and newline (a lone carriage return is dropped too).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Removes ANSI escape sequences and control characters; keeps tabs and newlines. */
export function stripAnsi(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI, '').replace(CONTROL, '')
}

function clip(line: string): string {
  return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line
}

export function statusHeader(label: string): string {
  return `── ${label} ──\n`
}

const ARC_PREFIX = 'mcp__arc__'

function helperName(description: string): string {
  return stripAnsi(description).replace(/\s+/g, ' ').trim() || 'agent'
}

/** `Bash: pnpm test` (the parser's summary) as the tool name and its argument. */
function splitSummary(name: string, summary: string): string {
  const arg = summary.startsWith(`${name}: `) ? summary.slice(name.length + 2) : ''
  return arg === '' ? name : `${name}  ${arg}`
}

/**
 * Turns events into transcript text. It keeps small state: which tool calls were hidden (so their
 * results are too), tool names, and an unfinished stderr line.
 */
export class TranscriptFormatter {
  private readonly hidden = new Set<string>()
  private stderrRest = ''
  private streamsText = false
  private streaming: { id: string; started: boolean } | undefined
  /** Helper descriptions by the `Agent` tool call that started them, and by task id. */
  private readonly helperByToolUse = new Map<string, string>()
  private readonly helperByTask = new Map<string, string>()

  /**
   * Text of a streamed message (a provider that sends its message late) is written as it arrives; the
   * message's own `assistant-message` then only ends the line.
   */
  format(event: AgentEvent): string {
    if (event.type === 'session')
      this.streamsText = PROVIDER_TRAITS[event.provider].streamsTextDeltas
    if (this.streamsText && event.type === 'text-delta' && event.parentToolUseId === undefined) {
      return this.streamDelta(event)
    }
    if (
      event.type === 'assistant-message' &&
      event.parentToolUseId === undefined &&
      this.streaming?.id === event.messageId
    ) {
      return this.endStream()
    }
    const out = this.formatEvent(event)
    return out === '' ? out : this.endStream() + out
  }

  private streamDelta(event: Extract<AgentEvent, { type: 'text-delta' }>): string {
    let text = stripAnsi(event.text)
    let prefix = ''
    if (this.streaming?.id !== event.messageId) {
      prefix = this.endStream()
      this.streaming = { id: event.messageId, started: false }
    }
    if (!this.streaming.started) text = text.trimStart()
    if (text === '') return prefix
    this.streaming.started = true
    return prefix + text
  }

  /** Closes the streamed line, if one is open. */
  private endStream(): string {
    const open = this.streaming
    this.streaming = undefined
    return open?.started ? '\n' : ''
  }

  private formatEvent(event: AgentEvent): string {
    switch (event.type) {
      case 'assistant-message': {
        const text = stripAnsi(event.text).trim()
        if (text === '') return ''
        if (event.parentToolUseId !== undefined) {
          return text
            .split('\n')
            .map((line) => `${this.helperPrefix(event.parentToolUseId)}${clip(line)}\n`)
            .join('')
        }
        return `${text}\n`
      }
      case 'task-started':
        this.helperByToolUse.set(event.toolUseId, event.description)
        this.helperByTask.set(event.taskId, event.description)
        return `${HELPER_ARROW}helper (${helperName(event.description)}): started\n`
      case 'task-ended':
        return `${HELPER_ARROW}helper (${helperName(this.helperByTask.get(event.taskId) ?? '')}): finished (${stripAnsi(event.status)})\n`
      case 'tool-use':
        return this.toolUse(event)
      case 'tool-result':
        return this.toolResult(event)
      case 'stderr':
        return this.stderr(event.text)
      case 'error':
        return `! ${clip(stripAnsi(event.message).replace(/\s+/g, ' ').trim())}\n`
      case 'session':
      case 'text-delta':
      case 'thinking-delta':
      case 'turn-result':
      case 'usage':
      case 'usage-progress':
      case 'rate-limit':
      case 'control-ack':
      case 'tasks-changed':
      case 'exit':
      case 'turn-started':
      case 'approval':
      case 'plan-updated':
      case 'model-rerouted':
      case 'mcp-status':
      case 'user-input-request':
      case 'unknown':
        return ''
      default: {
        const exhaustive: never = event
        void exhaustive
        return ''
      }
    }
  }

  /** What the user typed to a worker they are in control of: `> text` (further lines indented). */
  userInput(text: string): string {
    const lines = stripAnsi(text).replace(/\s+$/, '').split('\n')
    return lines.map((line, i) => `${i === 0 ? '> ' : '  '}${clip(line)}\n`).join('')
  }

  /** The unfinished stderr line, if any; call when the process ends. */
  finish(): string {
    const rest = this.stderrRest
    this.stderrRest = ''
    return this.endStream() + (rest === '' ? '' : `${STDERR_PREFIX}${clip(rest)}\n`)
  }

  private helperPrefix(parentToolUseId: string | undefined): string {
    const description =
      parentToolUseId === undefined ? '' : this.helperByToolUse.get(parentToolUseId)
    return `${HELPER_ARROW}helper (${helperName(description ?? '')}): `
  }

  private toolUse(event: Extract<AgentEvent, { type: 'tool-use' }>): string {
    const detail = event.summary.startsWith(`${event.name}: `)
      ? stripAnsi(event.summary.slice(event.name.length + 2)).trim()
      : ''
    if (event.name.startsWith(ARC_PREFIX)) {
      const tool = event.name.slice(ARC_PREFIX.length)
      const line =
        tool === 'report_progress'
          ? `• ${detail}`
          : tool === 'report_done'
            ? `✓ Done: ${detail}`
            : tool === 'ask_brain'
              ? `? ${detail}`
              : ''
      if (line === '' || detail === '') {
        this.hidden.add(event.toolUseId)
        return ''
      }
      this.hidden.add(event.toolUseId)
      return `${line}\n`
    }
    if (event.name === 'ToolSearch') {
      this.hidden.add(event.toolUseId)
      return ''
    }
    const call = `▸ ${stripAnsi(splitSummary(event.name, event.summary))}`
    return event.parentToolUseId === undefined
      ? `${call}\n`
      : `${this.helperPrefix(event.parentToolUseId)}${call}\n`
  }

  private toolResult(event: Extract<AgentEvent, { type: 'tool-result' }>): string {
    if (this.hidden.delete(event.toolUseId)) return ''
    const text = stripAnsi(event.content ?? '').replace(/\s+$/, '')
    const lines = text === '' ? [] : text.split('\n')
    if (event.parentToolUseId !== undefined) return this.helperResult(event, lines)
    const out: string[] = []
    if (event.isError) out.push('  ✗ error')
    for (const line of lines.slice(0, RESULT_MAX_LINES)) out.push(`  ${clip(line)}`)
    if (lines.length > RESULT_MAX_LINES) {
      out.push(`  … ${lines.length - RESULT_MAX_LINES} more lines`)
    }
    return out.length === 0 ? '' : `${out.join('\n')}\n`
  }

  /** A helper's result: the first few lines, each on a helper line. */
  private helperResult(
    event: Extract<AgentEvent, { type: 'tool-result' }>,
    lines: string[]
  ): string {
    const prefix = this.helperPrefix(event.parentToolUseId)
    const out: string[] = []
    if (event.isError) out.push('✗ error')
    for (const line of lines.slice(0, HELPER_RESULT_LINES)) out.push(clip(line))
    if (lines.length > HELPER_RESULT_LINES) {
      out.push(`… ${lines.length - HELPER_RESULT_LINES} more lines`)
    }
    return out.map((line) => `${prefix}${line}\n`).join('')
  }

  private stderr(raw: string): string {
    const pieces = (this.stderrRest + stripAnsi(raw)).split('\n')
    this.stderrRest = pieces.pop() ?? ''
    return pieces
      .filter((line) => line.trim() !== '')
      .map((line) => `${STDERR_PREFIX}${clip(line)}\n`)
      .join('')
  }
}

export interface TerminalChunk {
  seq: number
  text: string
}

export interface TerminalBacklog {
  backlog: string
  seq: number
  truncated: boolean
}

export interface TerminalLogOptions {
  /** `userData/sessions/<sid>/workers/<wid>.log`; without it the log lives in memory only. */
  path?: string | undefined
  /** Called with each batched chunk (every 50 ms or 4 KB). */
  onChunk: (workerId: string, chunk: TerminalChunk) => void
  workerId: string
  flushMs?: number
  flushBytes?: number
  tailChars?: number
  fileMaxBytes?: number
  onError?: (message: string, error: unknown) => void
}

/**
 * One worker's transcript. Text is batched; each flush gets the next `seq`, is appended to the
 * file and the in-memory tail, and pushed. The tail and the backlog hold only flushed text, so a
 * chunk pushed after `openBacklog` always has a higher `seq` than the backlog and is never part of it.
 */
export class TerminalLog {
  private readonly formatter = new TranscriptFormatter()
  private readonly batcher: DeltaBatcher
  private readonly tailChars: number
  private readonly fileMaxBytes: number
  private tail = ''
  private seq = 0
  /** Part of the output is no longer in the tail (or the file's head was trimmed). */
  private tailTruncated = false
  private fileBytes = 0
  private fileTrimmed = false
  private chain: Promise<void>
  private disposed = false

  constructor(private readonly options: TerminalLogOptions) {
    this.tailChars = options.tailChars ?? TAIL_MAX_CHARS
    this.fileMaxBytes = options.fileMaxBytes ?? FILE_MAX_BYTES
    this.batcher = new DeltaBatcher({
      flushMs: options.flushMs ?? DELTA_FLUSH_MS,
      maxBytes: options.flushBytes ?? DELTA_FLUSH_BYTES,
      nextSeq: () => ++this.seq,
      onFlush: (batch) => this.onFlush(batch.seq, batch.text)
    })
    this.chain = this.load()
  }

  /** Picks up what an earlier run of the app wrote, so a continued worker keeps its history. */
  private async load(): Promise<void> {
    const path = this.options.path
    if (!path) return
    try {
      const info = await stat(path)
      this.fileBytes = info.size
      const text = await readFile(path, 'utf8')
      this.fileTrimmed = text.startsWith(TRIM_MARKER)
      // Text flushed while the file was still loading is already in the tail; the file goes first.
      const merged = text + this.tail
      this.tail = merged.length > this.tailChars ? merged.slice(-this.tailChars) : merged
      this.tailTruncated = this.tailTruncated || merged.length > this.tailChars || this.fileTrimmed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.onError?.('could not read the terminal log', error)
      }
    }
  }

  /** Adds raw transcript text (already formatted). */
  write(text: string): void {
    if (this.disposed || text === '') return
    this.batcher.push(0, text)
  }

  status(label: string): void {
    this.write(statusHeader(label))
  }

  /** A marker line for the user's step-in, interrupt and hand-back. */
  marker(label: string): void {
    this.write(statusHeader(label))
  }

  /** The user's own line to the worker. */
  userInput(text: string): void {
    this.write(this.formatter.userInput(text))
  }

  event(event: AgentEvent): void {
    this.write(this.formatter.format(event))
  }

  /** Writes the unfinished stderr line, then the closing status header if given, and pushes everything pending. */
  finish(label?: string): void {
    this.write(this.formatter.finish())
    if (label !== undefined) this.status(label)
    this.batcher.flush()
  }

  private onFlush(seq: number, text: string): void {
    this.tail += text
    if (this.tail.length > this.tailChars) {
      this.tail = this.tail.slice(-this.tailChars)
      this.tailTruncated = true
    }
    this.options.onChunk(this.options.workerId, { seq, text })
    const path = this.options.path
    if (path) this.chain = this.chain.then(() => this.append(path, text))
  }

  private async append(path: string, text: string): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, text, 'utf8')
      this.fileBytes += Buffer.byteLength(text)
      if (this.fileBytes > this.fileMaxBytes) await this.trimHead(path)
    } catch (error: unknown) {
      this.options.onError?.('could not write the terminal log', error)
    }
  }

  /** Drops the oldest lines so the file is about 90% of the cap, and leaves a marker line first. */
  private async trimHead(path: string): Promise<void> {
    const bytes = await readFile(path)
    const keep = Math.floor(this.fileMaxBytes * FILE_KEEP_RATIO)
    let start = Math.max(0, bytes.length - keep)
    const newline = bytes.indexOf(0x0a, start)
    start = newline === -1 ? start : newline + 1
    const body = bytes.subarray(start)
    const next = Buffer.concat([Buffer.from(`${TRIM_MARKER}\n`), body])
    const temp = `${path}.tmp`
    await writeFile(temp, next)
    await rename(temp, path)
    this.fileBytes = next.length
    this.fileTrimmed = true
    this.tailTruncated = true
  }

  /** Resolves once everything flushed so far is on disk. */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * `workers:open-terminal` for this worker. A live worker gets its in-memory tail (the last
   * 1 MB); a finished one gets the whole file, so its output from the start is there (up to the cap).
   */
  async openBacklog(live: boolean): Promise<TerminalBacklog> {
    await this.chain
    const path = this.options.path
    if (live || !path) {
      return { backlog: this.tail, seq: this.seq, truncated: this.tailTruncated }
    }
    try {
      const text = await readFile(path, 'utf8')
      return { backlog: text, seq: this.seq, truncated: this.fileTrimmed }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.onError?.('could not read the terminal log', error)
      }
      return { backlog: '', seq: this.seq, truncated: false }
    }
  }

  dispose(): void {
    this.finish()
    this.disposed = true
  }
}

/** The transcript of a worker that has no live log (the app restarted): the file, or empty. */
export async function readTerminalFile(path: string): Promise<TerminalBacklog> {
  try {
    const backlog = await readFile(path, 'utf8')
    return { backlog, seq: 0, truncated: backlog.startsWith(TRIM_MARKER) }
  } catch {
    return { backlog: '', seq: 0, truncated: false }
  }
}
