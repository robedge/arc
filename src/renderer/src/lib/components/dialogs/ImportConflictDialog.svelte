<script lang="ts">
  import type { ConflictResolution } from '@shared/types/item'
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import Checkbox from '../ui/Checkbox.svelte'

  interface Props {
    name: string
    sectionName: string
    onanswer: (answer: { choice: ConflictResolution; applyToAll: boolean }) => void
  }

  let { name, sectionName, onanswer }: Props = $props()

  let applyToAll = $state(false)

  function answer(choice: ConflictResolution): void {
    onanswer({ choice, applyToAll })
  }
</script>

<Modal title="File already exists" onsubmit={() => {}} oncancel={() => answer('skip')} size="md">
  <p class="text-sm text-text">'{name}' already exists in {sectionName}.</p>
  <Checkbox id="apply-to-all" label="Apply to all remaining conflicts" bind:checked={applyToAll} />
  <div class="flex justify-end gap-2">
    <Button onclick={() => answer('skip')}>Cancel</Button>
    <Button onclick={() => answer('keepBoth')}>Keep Both</Button>
    <Button variant="danger" onclick={() => answer('replace')}>Replace</Button>
  </div>
</Modal>
