<script lang="ts">
  import type { Section } from '@shared/types/section'
  import { openLink } from '../../ipc/open-link'
  import { knowledge } from '../../stores/knowledge.svelte'
  import { ui } from '../../stores/ui.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Button from '../ui/Button.svelte'

  let { section }: { section: Section } = $props()

  $effect(() => {
    void knowledge.load(section.id)
  })
</script>

<div class="flex items-center justify-between py-2">
  <h3 class="font-display text-sm tracking-title text-text-muted uppercase">{section.name}</h3>
  <Button variant="primary" onclick={() => ui.openDialog({ kind: 'link-form' })}>Add Link</Button>
</div>

{#if knowledge.items.length === 0}
  <EmptyState icon="link" text="No links yet" />
{:else}
  <ul aria-label="Links" class="flex flex-col gap-2">
    {#each knowledge.items as item (item.id)}
      <li class="hud-row cursor-default items-start! justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-sm font-medium text-text">{item.title}</span>
          <button
            type="button"
            onclick={() => void openLink(item.id)}
            class="min-h-[var(--size-hit)] truncate text-left text-sm text-accent underline hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
            >{item.url}</button
          >
          {#if item.description}
            <span class="truncate text-xs text-text-muted">{item.description}</span>
          {/if}
        </div>
        <div class="flex shrink-0 gap-2">
          <IconButton
            label="Edit"
            icon="edit"
            onclick={() => ui.openDialog({ kind: 'link-form', itemId: item.id })}
          />
          <IconButton
            label="Delete"
            icon="trash"
            onclick={() => ui.openDialog({ kind: 'item-delete', itemId: item.id })}
          />
        </div>
      </li>
    {/each}
  </ul>
{/if}
