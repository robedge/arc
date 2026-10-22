<script lang="ts">
  import { GROUP_NAME_MAX, SECTION_NAME_MAX } from '@shared/limits'
  import { groupNameKey, normalizeGroupName } from '@shared/group-name'
  import { sectionNameKey } from '@shared/sections'
  import { messageFor } from '../../ipc/messages'
  import { groups } from '../../stores/groups.svelte'
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { ui } from '../../stores/ui.svelte'
  import { knowledge, validateItemTitle } from '../../stores/knowledge.svelte'
  import { itemDraft } from '../../stores/item-draft.svelte'
  import { leaveGuard } from '../../stores/leave-guard.svelte'
  import LeaveConflictDialog from './LeaveConflictDialog.svelte'
  import { importFlow } from '../../stores/import-flow.svelte'
  import { storage } from '../../stores/storage.svelte'
  import LinkFolderDialog from './LinkFolderDialog.svelte'
  import UnlinkDialog from './UnlinkDialog.svelte'
  import UseAppStorageDialog from './UseAppStorageDialog.svelte'
  import ImportConflictDialog from './ImportConflictDialog.svelte'
  import NameDialog from './NameDialog.svelte'
  import ConfirmDelete from './ConfirmDelete.svelte'
  import LinkForm from '../sections/LinkForm.svelte'
  import type { AppError } from '@shared/errors'

  function validateGroupName(raw: string, excludeId?: string): string | null {
    const name = normalizeGroupName(raw)
    if (name.length === 0) return messageFor({ code: 'GROUP_NAME_REQUIRED' })
    if ([...name].length > GROUP_NAME_MAX) return messageFor({ code: 'GROUP_NAME_TOO_LONG' })
    const key = groupNameKey(name)
    if (groups.list.some((g) => g.id !== excludeId && groupNameKey(g.name) === key))
      return messageFor({ code: 'GROUP_NAME_DUPLICATE' })
    return null
  }

  async function createGroup(name: string): Promise<AppError | null> {
    const result = await groups.create(name)
    if ('code' in result) return result
    void leaveGuard.selectGroup(result.id)
    return null
  }

  function validateSectionName(raw: string, excludeId?: string): string | null {
    const name = normalizeGroupName(raw)
    const length = [...name].length
    if (length < 1 || length > SECTION_NAME_MAX) return messageFor({ code: 'SECTION_NAME_INVALID' })
    const key = sectionNameKey(name)
    if (groupDetail.sections.some((s) => s.id !== excludeId && sectionNameKey(s.name) === key))
      return messageFor({ code: 'SECTION_NAME_DUPLICATE' })
    return null
  }

  async function createSection(name: string): Promise<AppError | null> {
    const result = await groupDetail.createSection(name)
    if ('code' in result) return result
    void leaveGuard.selectSection(result.id)
    return null
  }

  async function renameSection(sectionId: string, name: string): Promise<AppError | null> {
    const result = await groupDetail.renameSection(sectionId, name)
    return 'code' in result ? result : null
  }

  async function deleteSection(sectionId: string): Promise<AppError | null> {
    const failure = await groupDetail.deleteSection(sectionId)
    if (failure) return failure
    if (ui.selectedSectionId === sectionId) ui.selectSection(null)
    return null
  }

  async function removeProject(projectId: string): Promise<AppError | null> {
    return groupDetail.removeProject(projectId)
  }

  async function createItem(title: string): Promise<AppError | null> {
    const result = await knowledge.create(title.trim())
    if ('code' in result) return result
    void leaveGuard.selectItem(result.id)
    return null
  }

  async function deleteItem(itemId: string): Promise<AppError | null> {
    itemDraft.discard()
    const failure = await knowledge.remove(itemId)
    if (failure) return failure
    if (ui.selectedItemId === itemId) ui.selectItem(null)
    return null
  }

  async function saveLink(
    values: { url: string; title: string; description: string },
    itemId?: string
  ): Promise<AppError | null> {
    const result = await knowledge.upsertLink(values, itemId)
    return 'code' in result ? result : null
  }

  const linkTarget = $derived.by(() => {
    const d = ui.dialog
    return d?.kind === 'link-form' && d.itemId
      ? (knowledge.items.find((i) => i.id === d.itemId) ?? null)
      : null
  })

  const itemTarget = $derived.by(() => {
    const d = ui.dialog
    return d?.kind === 'item-delete'
      ? (knowledge.items.find((i) => i.id === d.itemId) ?? null)
      : null
  })
  const newItemTitle = $derived.by(() => {
    const d = ui.dialog
    const kind = groupDetail.sections.find(
      (s) => d?.kind === 'item-create' && s.id === d.sectionId
    )?.kind
    return kind === 'notes' ? 'New Note' : kind === 'playbooks' ? 'New Playbook' : 'New Item'
  })

  const dialog = $derived(ui.dialog)
  const projectTarget = $derived(
    dialog?.kind === 'project-remove'
      ? (groupDetail.projects.find((p) => p.id === dialog.projectId) ?? null)
      : null
  )
  const sectionTarget = $derived(
    dialog && 'sectionId' in dialog
      ? (groupDetail.sections.find((s) => s.id === dialog.sectionId) ?? null)
      : null
  )
  const target = $derived(
    dialog && 'groupId' in dialog
      ? (groups.list.find((g) => g.id === dialog.groupId) ?? null)
      : null
  )

  async function renameGroup(groupId: string, name: string): Promise<AppError | null> {
    const result = await groups.rename(groupId, name)
    return 'code' in result ? result : null
  }

  async function deleteGroup(groupId: string): Promise<AppError | null> {
    const failure = await groups.remove(groupId)
    if (failure) return failure
    if (ui.selectedGroupId === groupId) ui.selectGroup(null)
    return null
  }
</script>

{#if ui.dialog?.kind === 'group-create'}
  <NameDialog
    title="New Group"
    label="Group name"
    confirmText="Create"
    validate={validateGroupName}
    submit={createGroup}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'group-rename' && target}
  {@const groupId = dialog.groupId}
  <NameDialog
    title="Rename Group"
    label="Group name"
    confirmText="Rename"
    initialValue={target.name}
    validate={(raw) => validateGroupName(raw, groupId)}
    submit={(name) => renameGroup(groupId, name)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'group-delete' && target}
  {@const groupId = dialog.groupId}
  <ConfirmDelete
    target={{ kind: 'group', name: target.name, groupId }}
    submit={() => deleteGroup(groupId)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if ui.dialog?.kind === 'section-create'}
  <NameDialog
    title="Add Section"
    label="Section name"
    confirmText="Add"
    validate={(raw) => validateSectionName(raw)}
    submit={createSection}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'section-rename' && sectionTarget}
  {@const sectionId = sectionTarget.id}
  <NameDialog
    title="Rename Section"
    label="Section name"
    confirmText="Rename"
    initialValue={sectionTarget.name}
    validate={(raw) => validateSectionName(raw, sectionId)}
    submit={(name) => renameSection(sectionId, name)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'section-delete' && sectionTarget}
  {@const sectionId = sectionTarget.id}
  <ConfirmDelete
    target={{ kind: 'section', name: sectionTarget.name, itemCount: sectionTarget.itemCount }}
    submit={() => deleteSection(sectionId)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'project-remove' && projectTarget}
  {@const projectId = projectTarget.id}
  <ConfirmDelete
    target={{ kind: 'project', name: projectTarget.name }}
    submit={() => removeProject(projectId)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'item-create'}
  <NameDialog
    title={newItemTitle}
    label="Title"
    confirmText="Create"
    validate={validateItemTitle}
    submit={createItem}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'item-delete' && itemTarget}
  {@const itemId = itemTarget.id}
  <ConfirmDelete
    target={{ kind: 'item', name: itemTarget.title }}
    submit={() => deleteItem(itemId)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'link-form' && (!dialog.itemId || linkTarget)}
  {@const itemId = linkTarget?.id}
  <LinkForm
    item={linkTarget}
    submit={(values) => saveLink(values, itemId)}
    formatError={messageFor}
    onclose={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'storage-link' && storage.pending}
  {@const pick = storage.pending}
  <LinkFolderDialog
    {pick}
    busy={storage.busy}
    progress={storage.progress}
    error={storage.error}
    onchoose={(choice) => void storage.link(pick, choice)}
    oncancel={() => storage.cancelPending()}
  />
{/if}

{#if dialog?.kind === 'storage-unlink' && storage.state?.linkedPath}
  <UnlinkDialog
    linkedPath={storage.state.linkedPath}
    keptAside={storage.state.keptAside}
    busy={storage.busy}
    progress={storage.progress}
    error={storage.error}
    onconfirm={(choice) => void storage.unlink(choice)}
    oncancel={() => ui.closeDialog()}
  />
{/if}

{#if dialog?.kind === 'storage-use-app' && storage.state}
  <UseAppStorageDialog
    keptAside={storage.state.keptAside}
    busy={storage.busy}
    progress={storage.progress}
    error={storage.error}
    onconfirm={() => void storage.useAppStorage()}
    oncancel={() => ui.closeDialog()}
  />
{/if}

{#if importFlow.prompt}
  {@const prompt = importFlow.prompt}
  <ImportConflictDialog
    name={prompt.name}
    sectionName={prompt.sectionName}
    onanswer={prompt.answer}
  />
{/if}

{#if leaveGuard.prompt}
  {@const prompt = leaveGuard.prompt}
  <LeaveConflictDialog kind={prompt.kind} title={prompt.title} onanswer={prompt.answer} />
{/if}
