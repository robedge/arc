<script lang="ts">
  import Button from '../ui/Button.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    name: string
    onconfirm: () => void
    oncancel: () => void
  }

  let { name, onconfirm, oncancel }: Props = $props()
</script>

<Modal title="Remove plugin" size="sm" onsubmit={onconfirm} {oncancel}>
  <p class="text-sm text-text">
    Remove {name}? Its commands stop working in Arc and in Claude Code.
  </p>
  <div class="flex justify-end gap-2">
    <Button onclick={oncancel}>Cancel</Button>
    <Button variant="danger" type="submit">Remove</Button>
  </div>
</Modal>
