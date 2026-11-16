<script lang="ts">
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  interface Props {
    scope: 'session' | 'default'
    onconfirm: () => void
    oncancel: () => void
  }

  let { scope, onconfirm, oncancel }: Props = $props()

  const EXPLANATION =
    "The brain and every worker in this session will run commands, change files anywhere on your Mac, install software and use the network without asking you. Codex's and Cursor's safety limits are turned off too. Arc will still ask before pushing a branch or opening or merging a pull or merge request, and questions still come to you."

  const body = $derived(
    scope === 'default'
      ? `Every new session will start with Skip all approvals on. ${EXPLANATION}`
      : EXPLANATION
  )
</script>

<ConfirmDialog
  title="Skip all approvals?"
  {body}
  confirmLabel="Skip all approvals"
  {onconfirm}
  {oncancel}
/>
