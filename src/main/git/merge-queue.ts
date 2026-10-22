/**
 * One promise chain per key (the repository path): merges and syncs of a repository run one at a
 * time, in the order they were asked for. A failing job does not stop the jobs behind it.
 */
export class MergeQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(job, job)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  /** Whether any job of the key is queued or running. */
  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}
