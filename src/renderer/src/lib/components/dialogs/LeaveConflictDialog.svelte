<script lang="ts">
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import type { LeaveChoice } from '../../stores/leave-guard.svelte'

  interface Props {
    kind: 'changed' | 'deleted'
    title: string
    onanswer: (choice: LeaveChoice) => void
  }

  let { kind, title, onanswer }: Props = $props()
</script>

<Modal
  title="Unsaved changes"
  onsubmit={() => onanswer('keep')}
  oncancel={() => onanswer('cancel')}
  size="md"
>
  <p class="text-sm text-text">
    {#if kind === 'changed'}
      You have unsaved changes to <strong class="text-text">{title}</strong> that conflict with the file
      on disk.
    {:else}
      You have unsaved changes to <strong class="text-text">{title}</strong>, and the file was
      deleted on disk.
    {/if}
  </p>
  <div class="flex justify-end gap-2">
    <Button onclick={() => onanswer('cancel')}>Cancel</Button>
    <Button onclick={() => onanswer('discard')}>Discard mine</Button>
    <Button type="submit" variant="primary"
      >{kind === 'changed' ? 'Keep mine' : 'Save as new'}</Button
    >
  </div>
</Modal>
