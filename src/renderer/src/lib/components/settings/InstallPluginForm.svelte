<script lang="ts">
  import { plugins } from '../../stores/plugins.svelte'
  import Button from '../ui/Button.svelte'
  import TextField from '../ui/TextField.svelte'

  interface Props {
    /** Disables the form (Claude Code unavailable, or another change running). */
    disabled?: boolean
    /** Installing right now, for the Design Preview (which must not touch the store). */
    installing?: string | null
  }

  let { disabled = false, installing: previewInstalling }: Props = $props()

  let name = $state('')
  let marketplace = $state('')
  let attempted = $state(false)

  const installing = $derived(
    previewInstalling !== undefined
      ? previewInstalling
      : plugins.op?.kind === 'install'
        ? plugins.op.target
        : null
  )
  const nameError = $derived(attempted && name.trim() === '' ? 'Enter a plugin name.' : null)

  // Clear after a successful install only (the counter moves on every finished change).
  let seenDone = plugins.done.seq
  $effect(() => {
    const { seq, kind } = plugins.done
    if (seq === seenDone) return
    seenDone = seq
    if (kind === 'install') {
      name = ''
      marketplace = ''
      attempted = false
    }
  })

  function onsubmit(event: SubmitEvent): void {
    event.preventDefault()
    if (disabled || installing) return
    attempted = true
    const trimmed = name.trim()
    if (trimmed === '') return
    void plugins.install(trimmed, marketplace.trim() || undefined)
  }
</script>

<form {onsubmit} class="flex flex-col gap-2" novalidate aria-label="Install a plugin">
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
    <TextField
      id="plugin-install-name"
      label="Plugin name"
      bind:value={name}
      error={nameError}
      placeholder="superpowers"
      disabled={disabled || installing !== null}
    />
    <TextField
      id="plugin-install-marketplace"
      label="Marketplace (optional)"
      bind:value={marketplace}
      placeholder="claude-plugins-official"
      disabled={disabled || installing !== null}
    />
  </div>
  <div class="flex items-center gap-3">
    <Button type="submit" variant="primary" busy={installing !== null} {disabled}>Install</Button>
    <p class="text-sm text-text-muted" role="status" aria-live="polite" data-install-status>
      {#if installing !== null}Installing {installing}…{/if}
    </p>
  </div>
</form>
