<script lang="ts">
  import { Annotation, Compartment, EditorState } from '@codemirror/state'
  import { EditorView, keymap } from '@codemirror/view'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import type { Action } from 'svelte/action'
  import { hudEditorExtensions, hudEditorHostClass } from '../../editor/hud-theme'
  import { languageFor, loadLanguage, type LanguageName } from '../../editor/languages'

  interface Props {
    value: string
    fileName: string
    label?: string
    onchange: (text: string) => void
    onblur?: () => void
  }

  let { value, fileName, label = 'Body', onchange, onblur }: Props = $props()

  const external = Annotation.define<boolean>()
  const languageName = $derived(languageFor(fileName))
  /** Set once the language extension has been loaded into the editor. */
  let loadedLanguage = $state<string | null>(null)

  interface Params {
    value: string
    language: LanguageName | null
    onchange: (text: string) => void
    onblur?: () => void
  }

  const codemirror: Action<HTMLDivElement, Params> = (node, initial) => {
    let params = initial
    const language = new Compartment()
    let destroyed = false
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: params.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          language.of([]),
          ...hudEditorExtensions('code'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((t) => t.annotation(external))) {
              params.onchange(update.state.doc.toString())
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              params.onblur?.()
            }
          })
        ]
      })
    })

    async function applyLanguage(name: LanguageName | null): Promise<void> {
      if (!name) return
      const extension = await loadLanguage(name)
      if (destroyed) return
      view.dispatch({ effects: language.reconfigure(extension) })
      loadedLanguage = name
    }
    void applyLanguage(params.language)

    return {
      update(next) {
        const languageChanged = next.language !== params.language
        params = next
        if (languageChanged) void applyLanguage(next.language)
        const current = view.state.doc.toString()
        if (next.value !== current) {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: next.value },
            annotations: external.of(true)
          })
        }
      },
      destroy() {
        destroyed = true
        view.destroy()
      }
    }
  }
</script>

<div
  use:codemirror={{ value, language: languageName, onchange, onblur }}
  data-language={loadedLanguage ?? 'plain'}
  class={hudEditorHostClass}
></div>
