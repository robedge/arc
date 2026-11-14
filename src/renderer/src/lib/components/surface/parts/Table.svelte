<script lang="ts">
  interface Props {
    columns: string[]
    rows: string[][]
  }

  let { columns, rows }: Props = $props()
</script>

<div class="min-w-0 overflow-x-auto">
  <table class="w-full border-collapse text-left text-sm">
    <thead>
      <tr>
        {#each columns as col, i (i)}
          <th
            class="border-b border-border-strong px-2 py-1 text-xs tracking-label text-text-muted uppercase"
            >{col}</th
          >
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, r (r)}
        <tr>
          {#each row as cell, i (i)}
            <td class="border-b border-border px-2 py-1 [overflow-wrap:anywhere] text-text"
              >{cell}</td
            >
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
