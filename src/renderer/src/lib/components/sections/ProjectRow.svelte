<script lang="ts">
  import type { Project } from '@shared/types/project'
  import { messageFor } from '../../ipc/messages'
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import Icon from '../ui/Icon.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import { messageKinds } from '../ui/kinds'
  import { ui } from '../../stores/ui.svelte'

  let { project }: { project: Project } = $props()

  async function locate(): Promise<void> {
    const error = await groupDetail.relocateProject(project.id)
    if (error) toasts.show(messageFor(error), 'error')
  }

  function remove(): void {
    ui.openDialog({ kind: 'project-remove', projectId: project.id })
  }
</script>

{#snippet status(kind: 'warning' | 'error', text: string, id: string)}
  <div
    data-project-state={id}
    class="mt-1 flex items-center gap-1.5 text-xs font-semibold {messageKinds[kind].text}"
  >
    <Icon name={messageKinds[kind].icon} size={14} />
    <span>{text}</span>
  </div>
{/snippet}

<li
  data-selected="false"
  data-available={project.available ? 'true' : 'false'}
  class="hud-row gap-3 border {project.available
    ? 'border-transparent bg-surface-raised'
    : `${messageKinds.error.border} bg-surface-raised/50`}"
>
  <div class="min-w-0 flex-1">
    <div class="font-semibold text-text">{project.name}</div>
    <div class="truncate font-mono text-xs text-text-muted" title={project.path}>
      {project.path}
    </div>
    {#if !project.available}
      {@render status('error', 'Folder not found', 'missing')}
    {/if}
    {#if !project.isGit}
      {@render status('warning', 'Not a git repository — read-only in sessions', 'not-git')}
    {/if}
  </div>
  {#if !project.available}
    <Button onclick={() => void locate()}>Locate…</Button>
    <Button onclick={remove}>Remove</Button>
  {/if}
  <IconButton label="Remove project" icon="trash" onclick={remove} />
</li>
