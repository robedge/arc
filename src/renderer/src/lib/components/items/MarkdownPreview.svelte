<script lang="ts">
  import DOMPurify from 'dompurify'
  import MarkdownIt from 'markdown-it'

  import { openUrl } from '../../ipc/open-link'

  interface Props {
    source: string
    /** Wraps each fenced code block with a Copy button. Off by default. */
    copyCode?: boolean
  }

  let { source, copyCode = false }: Props = $props()

  const plain = new MarkdownIt({ html: false, linkify: true })
  const withCopy = new MarkdownIt({ html: false, linkify: true })
  const baseFence = withCopy.renderer.rules.fence
  withCopy.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const block = baseFence ? baseFence(tokens, idx, options, env, self) : ''
    return `<div class="code-block">${block}<button type="button" data-copy class="code-copy">Copy</button></div>`
  }

  const html = $derived(
    copyCode
      ? DOMPurify.sanitize(withCopy.render(source), { ADD_ATTR: ['data-copy', 'type'] })
      : DOMPurify.sanitize(plain.render(source))
  )

  const COPY_FEEDBACK_MS = 1500

  function copy(button: HTMLElement): void {
    const code = button.parentElement?.querySelector('code')?.textContent ?? ''
    const show = (label: string): void => {
      button.textContent = label
      setTimeout(() => {
        if (button.isConnected) button.textContent = 'Copy'
      }, COPY_FEEDBACK_MS)
    }
    navigator.clipboard.writeText(code).then(
      () => show('Copied'),
      () => show('Copy failed')
    )
  }

  function onclick(event: MouseEvent): void {
    const copyButton = (event.target as Element | null)?.closest<HTMLElement>('button[data-copy]')
    if (copyButton) {
      event.preventDefault()
      copy(copyButton)
      return
    }
    const anchor = (event.target as Element | null)?.closest('a')
    if (!anchor) return
    // Never navigate the app window. In-page anchors do nothing; http(s) addresses open in
    // the default browser through main, which revalidates them. Other schemes are ignored.
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) return
    try {
      const { protocol } = new URL(href)
      if (protocol === 'http:' || protocol === 'https:') void openUrl(href)
    } catch {
      // not an absolute address
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown-preview" {onclick}>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify above -->
  {@html html}
</div>
