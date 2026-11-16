<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import { onMount, type Snippet } from 'svelte'
  import XmarkIcon from 'iconoir/icons/xmark.svg?raw'
  import i18n from '../../lib/i18n'

  let {
    title,
    busy = false,
    onClose,
    children
  }: {
    title: string
    busy?: boolean
    onClose: () => void
    children: Snippet
  } = $props()
  let dialog: HTMLDialogElement

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.showModal()
    dialog.querySelector('input')?.focus()
    return () => {
      dialog.close()
      previousFocus?.focus({ preventScroll: true })
    }
  })
</script>

<dialog
  bind:this={dialog}
  aria-label={title}
  class="m-auto max-h-[calc(100dvh-64px)] w-[calc(100%-48px)] max-w-[560px] flex-col overflow-hidden rounded-[24px] border-none bg-white p-0 text-[#171717] shadow-2xl open:flex backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:bg-[oklch(0.2_0_0)] dark:text-white"
  oncancel={(event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onClose()
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') event.stopPropagation()
  }}
  onclick={(event) => {
    if (event.target === dialog && !busy) onClose()
  }}
>
  <div class="flex shrink-0 items-center justify-between gap-4 px-[20px] pt-[20px] pb-[12px]">
    <h2 class="text-[14px] leading-[20px] font-medium">{title}</h2>
    <button
      type="button"
      class="inline-flex size-[24px] items-center justify-center rounded-[8px] text-gray-500 hover:text-gray-900 dark:hover:text-white"
      aria-label={$i18n.t('common.close')}
      disabled={busy}
      onclick={onClose}
    >
      <span aria-hidden="true" class="inline-flex size-[14px] [&>svg]:size-full"
        >{@html XmarkIcon}</span
      >
    </button>
  </div>
  <div class="min-h-0 overflow-y-auto px-[20px] pb-[20px] text-[12px] leading-[16px]">
    {@render children()}
  </div>
</dialog>
