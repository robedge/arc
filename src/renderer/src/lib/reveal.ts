import { messageFor } from './ipc/messages'
import { toasts } from './stores/toasts.svelte'

export interface RevealTarget {
  groupId: string
  sectionId?: string
  itemId?: string
}

/** Opens a knowledge location in Finder; failures surface as a toast. */
export async function revealInFinder(target: RevealTarget): Promise<void> {
  const res = await window.harness.invoke('shell:reveal', target)
  if (!res.ok) toasts.show(messageFor(res.error), 'error')
}
