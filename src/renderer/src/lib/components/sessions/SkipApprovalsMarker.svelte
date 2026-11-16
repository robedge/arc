<script lang="ts">
  import { messageKinds } from '../ui/kinds'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Icon from '../ui/Icon.svelte'

  interface Props {
    onturnoff: () => void
  }

  let { onturnoff }: Props = $props()

  let confirming = $state(false)
  const kind = messageKinds.error
</script>

<button
  type="button"
  data-skip-approvals-on
  onclick={() => (confirming = true)}
  class="inline-flex min-h-[var(--size-hit)] items-center gap-1.5 rounded-pill border px-3 text-xs font-semibold tracking-label uppercase hover:shadow-glow-danger focus:outline-none focus-visible:shadow-focus {kind.text} {kind.border} {kind.bg}"
>
  <Icon name={kind.icon} size={14} />Skipping approvals
</button>
{#if confirming}
  <ConfirmDialog
    title="Turn Skip all approvals off?"
    body="Workers and the brain will ask for permission again from their next request."
    confirmLabel="Turn off"
    confirmVariant="secondary"
    onconfirm={() => {
      confirming = false
      onturnoff()
    }}
    oncancel={() => (confirming = false)}
  />
{/if}
