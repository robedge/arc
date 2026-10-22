export type Schedule = (callback: () => void) => number
export type Cancel = (handle: number) => void

export interface StreamBuffer {
  /** Queues text for a message; delivered once per frame as one concatenated chunk. */
  push(messageId: number, text: string): void
  /** Delivers everything queued right now. */
  flush(): void
  /** Drops anything queued without delivering it. */
  dispose(): void
}

/**
 * Coalesces streamed deltas so the UI updates at most once per animation frame.
 * The scheduler is injectable so the module stays pure and testable.
 */
export function createStreamBuffer(
  onFlush: (messageId: number, text: string) => void,
  schedule: Schedule = (cb) => requestAnimationFrame(() => cb()),
  cancel: Cancel = (handle) => cancelAnimationFrame(handle)
): StreamBuffer {
  const pending = new Map<number, string>()
  let handle: number | null = null

  function flush(): void {
    if (handle !== null) {
      cancel(handle)
      handle = null
    }
    if (pending.size === 0) return
    const batch = [...pending]
    pending.clear()
    for (const [messageId, text] of batch) onFlush(messageId, text)
  }

  return {
    push(messageId, text) {
      pending.set(messageId, (pending.get(messageId) ?? '') + text)
      if (handle === null) {
        handle = schedule(() => {
          handle = null
          flush()
        })
      }
    },
    flush,
    dispose() {
      if (handle !== null) cancel(handle)
      handle = null
      pending.clear()
    }
  }
}
