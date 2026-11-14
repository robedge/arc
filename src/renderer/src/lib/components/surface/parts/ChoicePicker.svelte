<script lang="ts">
  import Checkbox from '../../ui/Checkbox.svelte'
  import Radio from '../../ui/Radio.svelte'

  export interface ChoiceOption {
    label: string
    value: string
    description?: string
  }

  interface Props {
    id: string
    label: string
    options: ChoiceOption[]
    multi: boolean
    display: 'radio' | 'buttons'
    selected: string[]
    /** While true the picks are shown as not selected (they are kept, not erased). */
    overridden: boolean
    onpick: (value: string) => void
  }

  let { id, label, options, multi, display, selected, overridden, onpick }: Props = $props()

  const shown = $derived(overridden ? [] : selected)
  // The radio group follows what is shown (empty while overridden or before any pick).
  let group = $derived(shown[0] ?? '')
</script>

<fieldset
  role={display === 'radio' && !multi ? 'radiogroup' : undefined}
  class="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
  data-choice-picker={display}
>
  {#if label}
    <legend class="p-0 text-sm font-medium text-text">{label}</legend>
  {/if}
  <div class="flex flex-col gap-2 pt-1">
    {#each options as option, i (option.value)}
      {#if multi}
        <div class="flex flex-col">
          <Checkbox
            id="{id}-{i}"
            label={option.label}
            checked={shown.includes(option.value)}
            onchange={() => onpick(option.value)}
          />
          {#if option.description}
            <p class="pl-8 text-xs text-text-muted">{option.description}</p>
          {/if}
        </div>
      {:else if display === 'radio'}
        <Radio
          id="{id}-{i}"
          name={id}
          label={option.label}
          description={option.description}
          value={option.value}
          bind:group
          onchange={() => onpick(option.value)}
        />
      {:else}
        {@const on = shown.includes(option.value)}
        <button
          type="button"
          aria-pressed={on}
          onclick={() => onpick(option.value)}
          class="flex min-h-[var(--size-hit)] cursor-pointer flex-col items-start justify-center gap-0.5 rounded-hud border px-3 py-2 text-left focus:outline-none focus-visible:shadow-focus {on
            ? 'border-accent bg-accent/20'
            : 'border-border-strong bg-surface-code'}"
        >
          <span class="text-sm text-text">{option.label}</span>
          {#if option.description}
            <span class="text-xs text-text-muted">{option.description}</span>
          {/if}
        </button>
      {/if}
    {/each}
  </div>
</fieldset>
