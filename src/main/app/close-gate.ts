export interface CloseEventLike {
  preventDefault: () => void
}

export interface CloseGateOptions {
  /** Tells the renderer to flush pending work (the `app:before-close` push event). */
  emit: () => void
  /** Upper bound on waiting for the renderer, so a hung renderer never blocks closing. */
  timeoutMs: number
  /**
   * Whether the renderer can currently answer the handshake. False while it is still
   * loading or after it crashed: the push event would be lost, so closing passes straight
   * through (there is nothing unsaved to flush). Defaults to true.
   */
  canFlush?: () => boolean
  /** Called when the timeout, not the renderer's reply, released the close. */
  onTimeout?: () => void
}

export interface CloseGate {
  /** Handles a window `close` event; `proceed` performs the real close once it is safe. */
  handleClose: (event: CloseEventLike, proceed: () => void) => void
  /** The renderer finished flushing (`app:close-ready`). */
  ready: () => void
  /** True once the handshake finished and closes pass through. */
  readonly isOpen: boolean
}

export function createCloseGate(options: CloseGateOptions): CloseGate {
  let open = false
  let pending: { proceed: () => void; timer: ReturnType<typeof setTimeout> } | null = null

  const release = (): void => {
    if (!pending) return
    const { proceed, timer } = pending
    pending = null
    clearTimeout(timer)
    open = true
    proceed()
  }

  return {
    handleClose(event, proceed) {
      if (open) return
      if (!pending && options.canFlush && !options.canFlush()) {
        open = true
        return
      }
      event.preventDefault()
      if (pending) return
      pending = {
        proceed,
        timer: setTimeout(() => {
          options.onTimeout?.()
          release()
        }, options.timeoutMs)
      }
      options.emit()
    },
    ready: release,
    get isOpen() {
      return open
    }
  }
}
