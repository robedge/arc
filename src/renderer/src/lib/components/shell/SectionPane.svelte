<script lang="ts">
  import type { Section } from '@shared/types/section'
  import Panel from '../ui/Panel.svelte'
  import ProjectsSection from '../sections/ProjectsSection.svelte'
  import ItemSection from '../sections/ItemSection.svelte'
  import DocsSection from '../sections/DocsSection.svelte'
  import LinksSection from '../sections/LinksSection.svelte'

  let { section }: { section: Section } = $props()
</script>

{#if section.kind === 'projects'}
  <Panel scroll role="tabpanel" aria-label={section.name} class="h-full">
    <div class="p-3"><ProjectsSection /></div>
  </Panel>
{:else if section.kind === 'links'}
  <Panel scroll role="tabpanel" aria-label={section.name} class="h-full">
    <div class="p-3"><LinksSection {section} /></div>
  </Panel>
{:else if section.kind === 'docs'}
  <div role="tabpanel" aria-label={section.name} class="h-full min-h-0">
    <DocsSection {section} />
  </div>
{:else}
  <div role="tabpanel" aria-label={section.name} class="h-full min-h-0">
    <ItemSection {section} />
  </div>
{/if}
