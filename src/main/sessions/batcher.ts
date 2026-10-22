/** Coalesces streamed text before it is pushed to the renderer (tech spec 2.9). */

export const DELTA_FLUSH_MS = 50
export const DELTA_FLUSH_BYTES = 4096
export const EVENT_FLUSH_MS = 100

export interface DeltaBatch {
  messageId: number
  seq: number
  text: string
}

export interface DeltaBatcherOptions {
  /** Called with one coalesced chunk. Chunks of one message arrive in order. */
  onFlush: (batch: DeltaBatch) => void
  /** Hands out the next push sequence number; called once per flushed chunk. */
  nextSeq: () => number
  flushMs?: number
  maxBytes?: number
}

/**
 * Collects text per message and flushes it after `flushMs`, or at once when `maxBytes` is reached.
 * A delta for a different message flushes the pending one first, so order is kept.
 */
export class DeltaBatcher {
  private pendingId: number | undefined
  private pendingText = ''
  private timer: NodeJS.Timeout | undefined
  private readonly flushMs: number
  private readonly maxBytes: number

  constructor(private readonly options: DeltaBatcherOptions) {
    this.flushMs = options.flushMs ?? DELTA_FLUSH_MS
    this.maxBytes = options.maxBytes ?? DELTA_FLUSH_BYTES
  }

  push(messageId: number, text: string): void {
    if (text === '') return
    if (this.pendingId !== undefined && this.pendingId !== messageId) this.flush()
    this.pendingId = messageId
    this.pendingText += text
    if (Buffer.byteLength(this.pendingText) >= this.maxBytes) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushMs)
  }

  /** Pushes whatever is pending now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pendingId === undefined || this.pendingText === '') return
    const batch: DeltaBatch = {
      messageId: this.pendingId,
      seq: this.options.nextSeq(),
      text: this.pendingText
    }
    this.pendingId = undefined
    this.pendingText = ''
    this.options.onFlush(batch)
  }

  dispose(): void {
    this.flush()
  }
}

/** Collects items and hands them over as one array every `flushMs`. */
export class IntervalBatcher<T> {
  private items: T[] = []
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly onFlush: (items: T[]) => void,
    private readonly flushMs: number = EVENT_FLUSH_MS
  ) {}

  add(item: T): void {
    this.items.push(item)
    this.timer ??= setTimeout(() => this.flush(), this.flushMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.items.length === 0) return
    const items = this.items
    this.items = []
    this.onFlush(items)
  }
}
