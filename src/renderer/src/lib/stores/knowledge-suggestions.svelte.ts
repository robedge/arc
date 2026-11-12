import { SvelteSet } from 'svelte/reactivity'
import type {
  AcceptOutcome,
  KnowledgeSuggestionEdits,
  KnowledgeSuggestionView
} from '@shared/types/knowledge-suggestion'
import type { AppError } from '@shared/errors'
import type { KnowledgeSuggestionProblem } from '../knowledge-suggestions/problem'
import { canAcceptNow } from '../knowledge-suggestions/guards'
import { messageFor } from '../ipc/messages'
import { itemDraft } from './item-draft.svelte'
import { toasts } from './toasts.svelte'

/** Refusals the user can fix by changing the text, name or section; shown inline while editing. */
const FIXABLE_IN_EDITOR: ReadonlySet<string> = new Set([
  'VALIDATION_FAILED',
  'FILE_TOO_LARGE',
  'SECTION_NOT_FOUND'
])

/** The open session's waiting knowledge suggestions, with the main process as the source of truth. */
class KnowledgeSuggestionsStore {
  /** The session the list belongs to; null when none is open. */
  sessionId = $state<string | null>(null)

  /** Waiting suggestions, newest first. */
  list = $state.raw<KnowledgeSuggestionView[]>([])

  dialogOpen = $state(false)

  count = $derived(this.list.length)

  /** Why a card could not be applied, by suggestion id. */
  problems = $state.raw<Record<string, KnowledgeSuggestionProblem>>({})

  /** The note's current text after Show current, by suggestion id. Cleared with the problem. */
  currentTexts = $state.raw<Record<string, string>>({})

  /** Cards with an accept in flight. */
  busyIds = new SvelteSet<string>()

  /** What the user accepted since the dialog opened, newest first, for the confirmation rows. */
  confirmations = $state.raw<{ id: string; outcome: AcceptOutcome }[]>([])

  /** True while an Accept all or Discard all call is running. */
  batchBusy = $state(false)

  /** The card in edit mode; only one at a time. */
  editingId = $state<string | null>(null)

  /** True when the editor offers Name and Section: a new note, or an update whose note is gone. */
  editsAsNew = $state(false)

  /** The text the editor starts from for an update (fetched); null while it loads. New notes use the view's text. */
  editSeedText = $state<string | null>(null)

  /** A refusal shown inline in the editor (not name-taken, which marks the Name field). */
  editError = $state<string | null>(null)

  /** Which editor field takes focus; `n` changes on every request so the same field can be refocused. */
  editFocus = $state<{ field: 'text' | 'name'; n: number }>({ field: 'text', n: 0 })

  /** Replaces the list when the session is opened. */
  setSnapshot(sessionId: string, list: KnowledgeSuggestionView[]): void {
    this.sessionId = sessionId
    this.list = list
  }

  /** `session:knowledge-suggestions`: replaces the list; another session's push is ignored. */
  apply(event: { sessionId: string; waiting: KnowledgeSuggestionView[] }): void {
    if (event.sessionId !== this.sessionId) return
    this.list = event.waiting
    const present = new Set(event.waiting.map((s) => s.id))
    const kept = Object.entries(this.problems).filter(([id]) => present.has(id))
    if (kept.length !== Object.keys(this.problems).length) this.problems = Object.fromEntries(kept)
    this.dropCurrent((id) => !present.has(id))
    if (this.editingId !== null && !present.has(this.editingId)) this.endEdit()
  }

  open(): void {
    this.dialogOpen = true
  }

  close(): void {
    this.dialogOpen = false
    this.confirmations = []
  }

  private setProblem(id: string, problem: KnowledgeSuggestionProblem | null): void {
    const rest = Object.entries(this.problems).filter(([key]) => key !== id)
    if (problem !== null) rest.push([id, problem])
    this.problems = Object.fromEntries(rest)
    if (problem?.kind !== 'changed') this.dropCurrent((key) => key === id)
  }

  private dropCurrent(match: (id: string) => boolean): void {
    const kept = Object.entries(this.currentTexts).filter(([id]) => !match(id))
    if (kept.length !== Object.keys(this.currentTexts).length) {
      this.currentTexts = Object.fromEntries(kept)
    }
  }

  private setBusy(id: string, busy: boolean): void {
    if (busy) this.busyIds.add(id)
    else this.busyIds.delete(id)
  }

  private problemFor(error: AppError): KnowledgeSuggestionProblem | null {
    switch (error.code) {
      case 'SUGGESTION_NOT_FOUND':
        return null
      case 'EXTERNAL_MODIFIED':
        return { kind: 'changed' }
      case 'ITEM_NOT_FOUND':
        return { kind: 'missing' }
      case 'ITEM_NAME_TAKEN':
        return { kind: 'name-taken' }
      case 'IO_FAILED':
      case 'KNOWLEDGE_ROOT_MISSING':
        return { kind: 'save-failed', location: error.details?.location ?? 'the knowledge folder' }
      case 'STORAGE_BUSY':
        return { kind: 'storage-busy' }
      default:
        return { kind: 'failed', message: messageFor(error) }
    }
  }

  private endEdit(): void {
    this.editingId = null
    this.editsAsNew = false
    this.editSeedText = null
    this.editError = null
  }

  private focusEditor(field: 'text' | 'name'): void {
    this.editFocus = { field, n: this.editFocus.n + 1 }
  }

  /** Puts a card in edit mode. An update's full text is fetched; a failed fetch shows the error on the card. */
  async startEdit(id: string, focus: 'text' | 'name' = 'text'): Promise<void> {
    const card = this.list.find((s) => s.id === id)
    if (!card) return
    this.endEdit()
    this.editingId = id
    this.editsAsNew = card.kind === 'new' || this.problems[id]?.kind === 'missing'
    this.focusEditor(focus)
    if (card.kind === 'new') return
    const result = await window.arc.invoke('knowledge-suggestions:result-text', { id })
    if (this.editingId !== id || this.sessionId !== card.sessionId) return
    if (result.ok) {
      this.editSeedText = result.data.text
      return
    }
    this.endEdit()
    this.setProblem(id, { kind: 'failed', message: messageFor(result.error) })
  }

  /** Leaves edit mode; nothing is saved and the card shows the brain's text again. */
  cancelEdit(): void {
    this.endEdit()
  }

  /** Applies a suggestion. The card stays, with its problem, when the main process refuses. */
  async accept(id: string, edits?: KnowledgeSuggestionEdits): Promise<void> {
    const card = this.list.find((s) => s.id === id)
    if (!card || this.busyIds.has(id)) return
    if (!canAcceptNow(card, itemDraft)) {
      this.setProblem(id, { kind: 'unsaved-edits' })
      return
    }
    this.setProblem(id, null)
    this.editError = null
    this.setBusy(id, true)
    const result = await window.arc.invoke(
      'knowledge-suggestions:accept',
      edits ? { id, edits } : { id }
    )
    if (this.sessionId !== card.sessionId) return
    if (result.ok) {
      this.list = this.list.filter((s) => s.id !== id)
      this.confirmations = [{ id, outcome: result.data }, ...this.confirmations]
      if (this.editingId === id) this.endEdit()
    } else {
      this.refuse(id, result.error)
    }
    this.setBusy(id, false)
  }

  /** The card stays. In edit mode a refusal that input can fix stays in the editor; the rest go to the card. */
  private refuse(id: string, error: AppError): void {
    const editing = this.editingId === id
    const problem = this.problemFor(error)
    if (problem === null) {
      this.list = this.list.filter((s) => s.id !== id)
      if (editing) this.endEdit()
      return
    }
    if (problem.kind === 'name-taken') {
      this.setProblem(id, problem)
      // A new note's name field is the fix: open the editor on it (or refocus it).
      if (editing) this.focusEditor('name')
      else void this.startEdit(id, 'name')
      return
    }
    if (editing && FIXABLE_IN_EDITOR.has(error.code)) {
      this.editError = error.details?.reason ?? messageFor(error)
      return
    }
    if (editing && (problem.kind === 'changed' || problem.kind === 'missing')) this.endEdit()
    this.setProblem(id, problem)
  }

  /** Fetches the note's current text for the "changed" card; a deleted note becomes "missing". */
  async showCurrent(id: string): Promise<void> {
    const card = this.list.find((s) => s.id === id)
    if (!card) return
    const result = await window.arc.invoke('knowledge-suggestions:current', { id })
    if (this.sessionId !== card.sessionId) return
    if (result.ok) {
      this.currentTexts = { ...this.currentTexts, [id]: result.data.text }
    } else if (result.error.code === 'ITEM_NOT_FOUND') {
      this.setProblem(id, { kind: 'missing' })
    } else {
      toasts.show(messageFor(result.error), 'error')
    }
  }

  /** "Add as a new note" for an update whose note is gone: opens the editor to pick the name and section. */
  async addAsNew(id: string): Promise<void> {
    await this.startEdit(id)
  }

  /** Removes the card at once and puts it back at its place if the main process refuses. */
  async discard(id: string): Promise<void> {
    const index = this.list.findIndex((s) => s.id === id)
    const gone = this.list[index]
    if (!gone) return
    this.list = this.list.filter((s) => s.id !== id)
    this.setProblem(id, null)
    if (this.editingId === id) this.endEdit()
    const result = await window.arc.invoke('knowledge-suggestions:discard', { id })
    if (result.ok) return
    toasts.show(messageFor(result.error), 'error')
    if (this.sessionId !== gone.sessionId || this.list.some((s) => s.id === id)) return
    const next = [...this.list]
    next.splice(Math.min(index, next.length), 0, gone)
    this.list = next
  }

  /**
   * Applies every waiting suggestion, oldest first. The unsaved-edits guard is checked for every card
   * first: if any is blocked, each blocked card gets its problem and the batch does not run at all.
   * Failed cards stay with their problem (same mapping as a single accept); applied ones leave a confirmation.
   */
  async acceptAll(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === null || this.batchBusy || this.editingId !== null) return
    const waiting = this.list
    const blocked = waiting.filter((s) => !canAcceptNow(s, itemDraft))
    if (blocked.length > 0) {
      for (const card of blocked) this.setProblem(card.id, { kind: 'unsaved-edits' })
      return
    }
    for (const card of waiting) this.setProblem(card.id, null)
    this.batchBusy = true
    try {
      const result = await window.arc.invoke('knowledge-suggestions:accept-all', { sessionId })
      if (this.sessionId !== sessionId) return
      if (!result.ok) {
        toasts.show(messageFor(result.error), 'error')
        return
      }
      const applied: { id: string; outcome: AcceptOutcome }[] = []
      const gone = new SvelteSet<string>()
      let nameTaken: string | null = null
      for (const item of result.data.results) {
        if ('outcome' in item) {
          applied.push({ id: item.id, outcome: item.outcome })
          gone.add(item.id)
          continue
        }
        const problem = this.problemFor(item.error)
        if (problem === null) gone.add(item.id)
        else {
          this.setProblem(item.id, problem)
          if (problem.kind === 'name-taken' && nameTaken === null) nameTaken = item.id
        }
      }
      this.list = this.list.filter((s) => !gone.has(s.id))
      this.confirmations = [...applied.reverse(), ...this.confirmations]
      // As after a single accept, a taken name opens the editor on the Name field.
      if (nameTaken !== null) void this.startEdit(nameTaken, 'name')
    } finally {
      this.batchBusy = false
    }
  }

  /** Removes every card at once and puts them back if the main process refuses. */
  async discardAll(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === null || this.batchBusy || this.editingId !== null) return
    const before = this.list
    this.batchBusy = true
    this.list = []
    this.problems = {}
    this.dropCurrent(() => true)
    try {
      const result = await window.arc.invoke('knowledge-suggestions:discard-all', { sessionId })
      if (result.ok || this.sessionId !== sessionId) return
      toasts.show(messageFor(result.error), 'error')
      if (this.list.length === 0) this.list = before
    } finally {
      this.batchBusy = false
    }
  }

  reset(): void {
    this.batchBusy = false
    this.sessionId = null
    this.list = []
    this.dialogOpen = false
    this.problems = {}
    this.currentTexts = {}
    this.busyIds.clear()
    this.confirmations = []
    this.endEdit()
  }
}

export const knowledgeSuggestions = new KnowledgeSuggestionsStore()
