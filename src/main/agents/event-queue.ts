/** A push queue that consumers read as an async iterable. One consumer per queue. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiter: ((result: IteratorResult<T>) => void) | undefined
  private closed = false

  push(item: T): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  /** Ends the stream after the queued items have been read. */
  close(): void {
    this.closed = true
    if (this.waiter && this.items.length === 0) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      }
    }
  }
}
