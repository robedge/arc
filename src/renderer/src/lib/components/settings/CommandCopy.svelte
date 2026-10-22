<script lang="ts">
  import Button from '../ui/Button.svelte'

  interface Props {
    command: string
    /** The data attribute that marks the command text, e.g. `data-provider-command`. */
    marker: string
  }

  let { command, marker }: Props = $props()

  let copied = $state(false)
  let copyFailed = $state(false)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command)
      copied = true
      copyFailed = false
      setTimeout(() => (copied = false), 1500)
    } catch {
      copyFailed = true
    }
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  <code
    class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm text-text"
    {...{ [marker]: '' }}>{command}</code
  >
  <Button ariaLabel="Copy {command}" onclick={() => void copy()}>
    {copied ? 'Copied' : 'Copy'}
  </Button>
  {#if copyFailed}<span class="text-sm text-text-muted">Select the command and copy it.</span>{/if}
</div>
