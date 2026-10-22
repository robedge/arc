/** Progress keepalives on a long-blocking call (tech spec 2.3, spike S7): one every 15 s. */
export const PROGRESS_INTERVAL_MS = 15_000

export interface KeepaliveOptions {
  /** The client's `_meta.progressToken`; without one there is nothing to send. */
  progressToken: string | number | undefined
  intervalMs: number
  /** Sends one `notifications/progress`; a failure is ignored. */
  send: (progressToken: string | number, progress: number) => Promise<void>
}

/** Starts the timer; call the returned function when the call ends. Does nothing without a token. */
export function startKeepalive(options: KeepaliveOptions): () => void {
  const { progressToken, intervalMs, send } = options
  if (progressToken === undefined) return () => undefined
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
    void send(progressToken, ticks).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
