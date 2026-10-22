import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export type EditorFlavor = 'markdown' | 'code'

/** Every color and font reads a design token, so tokens.css stays the single source. */
export function hudThemeSpec(flavor: EditorFlavor): Record<string, Record<string, string>> {
  const font = flavor === 'code' ? 'var(--font-mono)' : 'var(--font-sans)'
  return {
    '&': {
      flex: '1 1 auto',
      minHeight: '0',
      backgroundColor: 'transparent',
      color: 'var(--color-text)',
      fontFamily: font,
      fontSize: flavor === 'code' ? '0.875rem' : '1rem'
    },
    '&.cm-focused': { outline: 'none' },
    // The container carries the focus ring (:focus-within); suppress the global per-element ring.
    '.cm-content:focus-visible': { boxShadow: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: font,
      lineHeight: flavor === 'code' ? '1.55' : '1.6'
    },
    '.cm-content': { caretColor: 'var(--color-accent)', padding: '0.5rem 0' },
    '.cm-line': { padding: '0 0.75rem' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'var(--color-surface-selected)' },
    '.cm-activeLine': { backgroundColor: 'var(--color-surface-hover)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--color-text-faint)',
      border: 'none'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-text-muted)' }
  }
}

export const hudHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--color-accent)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--color-success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-attention)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.meta],
    color: 'var(--color-text-muted)',
    fontStyle: 'italic'
  },
  { tag: t.invalid, color: 'var(--color-danger)' },
  {
    tag: [t.heading, t.strong],
    color: 'var(--color-text-bright)',
    fontWeight: '700'
  },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--color-accent)', textDecoration: 'underline' },
  { tag: [t.propertyName, t.definition(t.variableName)], color: 'var(--color-text-bright)' },
  { tag: [t.typeName, t.className], color: 'var(--color-attention-text)' },
  { tag: [t.punctuation, t.processingInstruction, t.quote], color: 'var(--color-text-muted)' }
])

/** The one extension set both editors use: dark HUD theme plus token-colored highlighting. */
export function hudEditorExtensions(flavor: EditorFlavor): Extension[] {
  return [EditorView.theme(hudThemeSpec(flavor), { dark: true }), syntaxHighlighting(hudHighlight)]
}

/** Classes for the editor's host element: fills its panel, carries the :focus-within ring. */
export const hudEditorHostClass =
  'hud-editor flex min-h-32 min-w-0 flex-1 flex-col overflow-hidden rounded-control border border-border bg-surface-code focus-within:border-border-strong focus-within:shadow-focus'
