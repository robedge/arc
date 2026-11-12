import type { CommandInfo } from '@shared/types/commands'

export type CommandsStatus = 'loading' | 'ready' | 'error'

export interface CommandsEntry {
  status: CommandsStatus
  commands: CommandInfo[]
}

const EMPTY: CommandsEntry = { status: 'loading', commands: [] }

/** The `/` list of each session the composer has been opened for; main stays the source of truth. */
class CommandsStore {
  private entries = $state<Record<string, CommandsEntry>>({})
  /** Guards against an older response landing after a newer request. */
  private generation = new Map<string, number>()

  for(sessionId: string): CommandsEntry {
    return this.entries[sessionId] ?? EMPTY
  }

  /** Fetches once per session; the composer calls this on mount. */
  ensure(sessionId: string): void {
    if (this.entries[sessionId]) return
    void this.load(sessionId)
  }

  /** Sets a session's list without asking main; the Design Preview has no IPC to ask. */
  provide(sessionId: string, list: CommandInfo[]): void {
    this.entries[sessionId] = { status: 'ready', commands: list }
  }

  /** Fetches again, keeping the old list visible while it loads. */
  async load(sessionId: string): Promise<void> {
    const previous = this.entries[sessionId]
    this.entries[sessionId] = { status: 'loading', commands: previous?.commands ?? [] }
    const generation = (this.generation.get(sessionId) ?? 0) + 1
    this.generation.set(sessionId, generation)
    const result = await window.arc.invoke('commands:list', { sessionId })
    const next: CommandsEntry = result.ok
      ? { status: 'ready', commands: result.data }
      : { status: 'error', commands: previous?.commands ?? [] }
    if (this.generation.get(sessionId) === generation) this.entries[sessionId] = next
  }

  /** `commands:changed`: every cached list is stale. */
  handleChanged(): void {
    for (const sessionId of Object.keys(this.entries)) void this.load(sessionId)
  }

  reset(): void {
    this.entries = {}
    this.generation.clear()
  }
}

export const commands = new CommandsStore()
