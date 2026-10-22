<script lang="ts">
  import type { AddProjectsResult } from '@shared/types/project'
  import type { AppError } from '@shared/errors'
  import { messageFor } from '../../ipc/messages'
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import DropZone from '../ui/DropZone.svelte'
  import ProjectRow from './ProjectRow.svelte'

  function report(result: AddProjectsResult | AppError): void {
    if ('code' in result) {
      toasts.show(messageFor(result), 'error')
      return
    }
    const messages = new Set(result.skipped.map((s) => messageFor({ code: s.code })))
    for (const message of messages) toasts.show(message, 'warning')
  }

  async function pick(): Promise<void> {
    report(await groupDetail.pickProjects())
  }

  async function addDropped(paths: string[]): Promise<void> {
    report(await groupDetail.addProjects(paths))
  }
</script>

<DropZone ondrop={addDropped}>
  <div class="flex items-center justify-between py-2">
    <h3 class="font-display text-sm tracking-title text-text-muted uppercase">Projects</h3>
    <Button variant="primary" onclick={pick}>Add Project</Button>
  </div>
  {#if groupDetail.projects.length === 0}
    <EmptyState icon="folder" text="Add a project folder or drag one here" />
  {:else}
    <ul aria-label="Projects" class="flex flex-col gap-2">
      {#each groupDetail.projects as project (project.id)}
        <ProjectRow {project} />
      {/each}
    </ul>
  {/if}
</DropZone>
