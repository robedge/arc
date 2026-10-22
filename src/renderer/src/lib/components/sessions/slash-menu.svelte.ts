import type { CommandInfo } from '@shared/types/commands'
import { commands } from '../../stores/commands.svelte'
import { filterCommands } from './command-filter'

/** The `/` list opens while the whole box is one slash word. */
const COMMAND_WORD = /^\/[^\s]*$/

interface SlashMenuOptions {
  sessionId: () => string
  /** The box's current text. */
  text: () => string
  /** Replaces the box's text (and whatever draft is kept for it). */
  setText: (text: string) => void
}

/**
 * The slash-command menu of a message box: open until Escape (reset by the next input), filtered
 * by the catalogue of the session, with the argument hint of the command just inserted.
 * Shared by the brain composer and a worker's input line.
 */
export class SlashMenu {
  private readonly options: SlashMenuOptions
  dismissed = $state(false)
  activeIndex = $state(0)
  /** The command just inserted: its argument hint shows until the user types an argument. */
  inserted = $state<{ text: string; hint: string } | null>(null)

  catalogue = $derived.by(() => commands.for(this.options.sessionId()))
  open = $derived.by(() => !this.dismissed && COMMAND_WORD.test(this.options.text()))
  matches = $derived.by(() =>
    this.open ? filterCommands(this.catalogue.commands, this.options.text().slice(1)) : []
  )
  hasOptions = $derived.by(() => this.matches.length > 0)
  argumentHint = $derived.by(() =>
    this.inserted && this.options.text() === this.inserted.text ? this.inserted.hint : ''
  )

  constructor(options: SlashMenuOptions) {
    this.options = options
  }

  /** Call from the box's input handler. */
  oninput(): void {
    this.dismissed = false
    this.activeIndex = 0
  }

  pick(command: CommandInfo): void {
    // A name both providers have is inserted as its id, so the brain does not have to ask which.
    const ambiguous = this.catalogue.commands.some(
      (other) => other.name === command.name && other.provider !== command.provider
    )
    const text = `/${ambiguous ? command.id : command.name} `
    this.options.setText(text)
    this.inserted = command.argumentHint ? { text, hint: command.argumentHint } : null
    this.activeIndex = 0
  }

  /** Handles a key while the menu is open; true when it consumed the event. */
  onKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.dismissed = true
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (!this.hasOptions) return false
    const last = this.matches.length - 1
    if (event.key === 'ArrowDown')
      this.activeIndex = this.activeIndex >= last ? 0 : this.activeIndex + 1
    else if (event.key === 'ArrowUp')
      this.activeIndex = this.activeIndex <= 0 ? last : this.activeIndex - 1
    else if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.isComposing || event.keyCode === 229) return false
      const chosen = this.matches[this.activeIndex] ?? this.matches[0]
      if (!chosen) return false
      this.pick(chosen)
    } else return false
    event.preventDefault()
    return true
  }
}
