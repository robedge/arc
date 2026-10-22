import type { Result } from '@shared/errors'
import type { ConflictResolution, ImportReport } from '@shared/types/item'
import { messageFor } from '../ipc/messages'
import { groupDetail } from './group-detail.svelte'
import { knowledge } from './knowledge.svelte'
import { toasts } from './toasts.svelte'

export interface ConflictAnswer {
  /** 'skip' is the dialog's Cancel. */
  choice: ConflictResolution
  applyToAll: boolean
}

export interface ConflictPrompt {
  sectionName: string
  name: string
  answer: (answer: ConflictAnswer) => void
}

class ImportFlow {
  /** The conflict currently being asked about, rendered by ImportConflictDialog. */
  prompt = $state<ConflictPrompt | null>(null)

  async pick(sectionId: string): Promise<void> {
    await this.finish(sectionId, await window.harness.invoke('items:pickImport', { sectionId }))
  }

  async drop(sectionId: string, paths: string[]): Promise<void> {
    await this.finish(sectionId, await window.harness.invoke('items:import', { sectionId, paths }))
  }

  private ask(sectionName: string, name: string): Promise<ConflictAnswer> {
    return new Promise((resolve) => {
      this.prompt = {
        sectionName,
        name,
        answer: (answer) => {
          this.prompt = null
          resolve(answer)
        }
      }
    })
  }

  private async finish(sectionId: string, first: Result<ImportReport>): Promise<void> {
    if (!first.ok) {
      toasts.show(messageFor(first.error), 'error')
      return
    }
    const failed = [...first.data.failed]
    const added = [...first.data.added]
    const sectionName = groupDetail.sections.find((s) => s.id === sectionId)?.name ?? 'this section'

    const onConflict: Record<string, ConflictResolution> = {}
    const retryPaths: string[] = []
    let rememberedChoice: ConflictResolution | null = null
    for (const conflict of first.data.conflicts) {
      let choice: ConflictResolution | null = rememberedChoice
      if (choice === null) {
        const answer = await this.ask(sectionName, conflict.name)
        choice = answer.choice
        if (answer.applyToAll) rememberedChoice = choice
      }
      if (choice === 'skip') continue
      onConflict[conflict.name] = choice
      retryPaths.push(conflict.path)
    }

    if (retryPaths.length > 0) {
      const second = await window.harness.invoke('items:import', {
        sectionId,
        paths: retryPaths,
        onConflict
      })
      if (second.ok) {
        added.push(...second.data.added)
        failed.push(...second.data.failed)
      } else {
        toasts.show(messageFor(second.error), 'error')
      }
    }

    if (failed.length > 0) {
      toasts.show(
        failed.map((f) => messageFor({ code: f.code, details: { name: f.name } })).join('\n'),
        'error'
      )
    }
    if (added.length > 0 || knowledge.sectionId === sectionId) {
      await knowledge.afterCountChange()
    }
  }
}

export const importFlow = new ImportFlow()
