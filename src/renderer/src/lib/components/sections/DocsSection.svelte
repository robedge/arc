<script lang="ts">
  import type { Section } from '@shared/types/section'
  import ItemSection from './ItemSection.svelte'

  let { section }: { section: Section } = $props()
</script>

<ItemSection {section} docs />
