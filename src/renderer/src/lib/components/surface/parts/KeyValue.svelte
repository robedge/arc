<script lang="ts">
  interface Props {
    items: { label: string; value: string | string[] }[]
  }

  let { items }: Props = $props()
</script>

<dl class="m-0 grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
  {#each items as item, i (i)}
    <dt class="text-text-muted">{item.label}</dt>
    <dd class="m-0 min-w-0 font-mono break-all text-text">
      {#if Array.isArray(item.value)}
        {#each item.value as line, j (j)}<div>{line}</div>{/each}
      {:else}
        {item.value}
      {/if}
    </dd>
  {/each}
</dl>
