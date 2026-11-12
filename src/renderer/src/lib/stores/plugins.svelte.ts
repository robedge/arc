import type { Result } from '@shared/errors'
import type { PluginKind, PluginProgress, PluginRow } from '@shared/types/plugins'
import { messageFor } from '../ipc/messages'
import { toasts } from './toasts.svelte'

export type PluginsStatus = 'loading' | 'ready' | 'error'

/** The installed plugins; main (the Claude Code CLI) stays the source of truth. */
class PluginsStore {
  status = $state<PluginsStatus>('loading')
  rows = $state<PluginRow[]>([])
  /** The CLI's own message when the list failed, shown verbatim. */
  reason = $state<string | null>(null)
  /** The change in progress (one at a time, as in main); `target` is the plugin id, or the typed name for an install. */
  op = $state<{ kind: PluginKind; target: string } | null>(null)
  /** The CLI's own message when the last change failed; cleared when the next one starts. */
  failure = $state<string | null>(null)
  /** Counts finished changes so a form can clear itself when its install succeeds. */
  done = $state<{ seq: number; kind: PluginKind | null }>({ seq: 0, kind: null })
  private generation = 0

  /** Starts a change and returns once main accepted it; progress then arrives as `plugins:progress`. */
  async run(
    kind: PluginKind,
    target: string,
    start: () => Promise<Result<{ opId: string }>>
  ): Promise<void> {
    if (this.op) return
    this.failure = null
    this.op = { kind, target }
    const result = await start()
    if (result.ok) return
    this.op = null
    if (result.error.code === 'PLUGIN_BUSY') toasts.show(messageFor(result.error), 'warning')
    else this.failure = result.error.details?.reason ?? messageFor(result.error)
  }

  install(name: string, marketplace?: string): Promise<void> {
    const request = marketplace ? { name, marketplace } : { name }
    return this.run('install', name, () => window.arc.invoke('plugins:install', request))
  }

  update(id: string): Promise<void> {
    return this.run('update', id, () => window.arc.invoke('plugins:update', { id }))
  }

  uninstall(id: string): Promise<void> {
    return this.run('uninstall', id, () => window.arc.invoke('plugins:uninstall', { id }))
  }

  checkUpdates(): Promise<void> {
    return this.run('check-updates', '', () => window.arc.invoke('plugins:check-updates', {}))
  }

  /** `plugins:progress`. A change started elsewhere (another window) is adopted too, so actions stay disabled. */
  handleProgress(event: PluginProgress): void {
    if (event.state === 'running') {
      if (!this.op) this.op = { kind: event.kind, target: event.target }
      return
    }
    this.op = null
    if (event.state === 'done') {
      this.done = { seq: this.done.seq + 1, kind: event.kind }
    } else {
      this.failure = event.message || 'The plugin change failed.'
    }
  }

  /** `silent` keeps the current list on screen while it refreshes (after a change). */
  async load(silent = false): Promise<void> {
    const generation = ++this.generation
    if (!silent || this.status !== 'ready') this.status = 'loading'
    const result = await window.arc.invoke('plugins:list', {})
    if (generation !== this.generation) return
    this.rows = result.ok ? result.data : []
    this.reason = result.ok ? null : (result.error.details?.reason ?? null)
    this.status = result.ok ? 'ready' : 'error'
  }

  reset(): void {
    this.generation++
    this.status = 'loading'
    this.rows = []
    this.reason = null
    this.op = null
    this.failure = null
  }
}

export const plugins = new PluginsStore()
