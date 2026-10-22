import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(resolve('src/renderer/src', rel), 'utf8')
const sessions = (name: string): string => read(`lib/components/sessions/${name}`)

describe('session screen containment (no child may widen its grid column)', () => {
  it('SessionScreen grid chain is min-w-0 with a zero-min conversation column', () => {
    const src = sessions('SessionScreen.svelte')
    expect(src).toContain('grid-cols-[minmax(0,1fr)_minmax(300px,380px)]')
    expect(src).toContain('<div class="min-h-0 min-w-0">')
    expect(src).toMatch(/grid h-full min-h-0 min-w-0 grid-cols-\[minmax\(0,1fr\)\]/)
    expect(src).toMatch(/grid min-h-0 min-w-0 grid-rows-\[minmax\(0,1fr\)_minmax\(120px,32%\)\]/)
  })

  it('ConversationTabs uses a single minmax(0,1fr) column and min-w-0 tabpanels', () => {
    const src = sessions('ConversationTabs.svelte')
    expect(src).toContain('min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]')
    expect(src.match(/class="min-h-0 min-w-0"/g)).toHaveLength(2)
  })

  it('Conversation, bubbles, plan card and terminal can shrink; text wraps anywhere', () => {
    expect(sessions('Conversation.svelte')).toContain(
      'flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto'
    )
    expect(sessions('PlanCard.svelte')).toContain('max-w-[85%] min-w-0')
    expect(sessions('TerminalPanel.svelte')).toContain('min-h-0 min-w-0 flex-1 flex-col')
    expect(sessions('MessageBubble.svelte')).toContain('[overflow-wrap:anywhere]')
  })

  it('code blocks scroll inside the bubble instead of widening it', () => {
    const css = read('styles/markdown-preview.css')
    expect(css).toMatch(/\.markdown-preview pre \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/)
    expect(css).toMatch(/\.markdown-preview \.code-block \{[^}]*min-width: 0;/)
  })
})
