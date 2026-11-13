<script lang="ts">
  import Button from './Button.svelte'
  import Modal from './Modal.svelte'

  interface Props {
    src: string
    /** The file name, shown as the title. */
    name: string
    onclose: () => void
  }

  let { src, name, onclose }: Props = $props()

  // The preview can open from inside another Modal. Keys and submits stop here so Escape closes
  // only the preview and the outer dialog neither sees the key nor submits.
  function stop(event: Event): void {
    event.stopPropagation()
  }
</script>

<div class="contents" role="presentation" onkeydown={stop} onsubmit={stop}>
  <Modal title={name} size="lg" onsubmit={onclose} oncancel={onclose}>
    <img
      data-image-preview
      {src}
      alt={name}
      class="max-h-[70vh] max-w-full self-center rounded-control object-contain"
    />
    <div class="flex justify-end">
      <Button onclick={onclose}>Close</Button>
    </div>
  </Modal>
</div>
