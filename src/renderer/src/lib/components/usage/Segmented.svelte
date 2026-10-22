<script lang="ts" generics="T extends string">
  interface Option<V extends string> {
    value: V
    label: string
  }

  interface Props<V extends string> {
    options: readonly Option<V>[]
    value: V
    /** Accessible name of the group. */
    label: string
    /** The data attribute each option carries its value in, for example "data-range". */
    hook: string
    onchange?: (value: V) => void
  }

  let { options, value = $bindable(), label, hook, onchange }: Props<T> = $props()

  let buttons: (HTMLButtonElement | undefined)[] = $state([])

  function select(index: number): void {
    const option = options[(index + options.length) % options.length]
    if (!option) return
    value = option.value
    buttons[options.indexOf(option)]?.focus()
    onchange?.(option.value)
  }

  function onkeydown(event: KeyboardEvent, index: number): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    select(index + step)
  }
</script>

<div role="radiogroup" aria-label={label} class="inline-flex" data-segmented>
  {#each options as option, i (option.value)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="radio"
      aria-checked={value === option.value}
      tabindex={value === option.value ? 0 : -1}
      {...{ [hook]: option.value }}
      class="hud-tab border border-border"
      data-selected={value === option.value ? 'true' : 'false'}
      onclick={() => select(i)}
      onkeydown={(e) => onkeydown(e, i)}>{option.label}</button
    >
  {/each}
</div>
