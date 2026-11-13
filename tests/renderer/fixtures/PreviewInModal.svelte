<script lang="ts">
  import AttachmentRow from '../../../src/renderer/src/lib/components/ui/AttachmentRow.svelte'
  import Modal from '../../../src/renderer/src/lib/components/ui/Modal.svelte'

  let { oncancel, items }: { oncancel: () => void; items: { key: string; name: string }[] } =
    $props()
</script>

<Modal title="Outer" onsubmit={() => {}} {oncancel}>
  <AttachmentRow {items} onremove={() => {}} />
</Modal>
