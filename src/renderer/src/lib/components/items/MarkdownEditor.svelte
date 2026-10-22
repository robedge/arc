<script lang="ts">
  import { Annotation, EditorState } from '@codemirror/state'
  import { EditorView, keymap } from '@codemirror/view'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { markdown } from '@codemirror/lang-markdown'
  import type { Action } from 'svelte/action'
  import { hudEditorExtensions, hudEditorHostClass } from '../../editor/hud-theme'

  interface Props {
    value: string
    label?: string
    onchange: (text: string) => void
    onblur?: () => void
  }

  let { value, label = 'Body', onchange, onblur }: Props = $props()

  const external = Annotation.define<boolean>()

  interface Params {
    value: string
    onchange: (text: string) => void
    onblur?: () => void
  }

  const codemirror: Action<HTMLDivElement, Params> = (node, initial) => {
    let params = initial
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: params.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          ...hudEditorExtensions('markdown'),
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
    return {
      update(next) {
        params = next
        const current = view.state.doc.toString()
        if (next.value !== current) {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: next.value },
            annotations: external.of(true)
          })
        }
      },
      destroy() {
        view.destroy()
      }
    }
  }
</script>

<div use:codemirror={{ value, onchange, onblur }} class={hudEditorHostClass}></div>
