<script lang="ts">
  import i18n, { changeLanguage } from '../lib/i18n'
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import { onMount, tick } from 'svelte'
  import ArrowUp from 'iconoir/icons/arrow-up.svg?raw'
  import Xmark from 'iconoir/icons/xmark.svg?raw'
  import Camera from 'iconoir/icons/camera.svg?raw'
  import type { Connection } from '../../../shared/connections'
  import {
    MAX_IMAGES,
    MAX_IMAGE_BYTES,
    validateQuery,
    type QueryData
  } from '../../../shared/events'

  const api = window.spotlight
  let input: HTMLTextAreaElement
  let query = $state('')
  let files = $state<QueryData['files']>([])
  let connections = $state<Connection[]>([])
  let destination = $state<Connection | null>(null)
  let error = $state('')
  let busy = $state(false)
  let capturing = $state(false)
  let screenPicker = $state(false)
  let preview = $state('')
  let width = $state(1920)
  let height = $state(1080)
  let x = $state(0)
  let y = $state(160)
  const barWidth = $derived(Math.min(748, width - 32))
  const validDestination = $derived(
    connections.some((item) => item.id === destination?.id && item.url === destination.url)
  )
  let generation = 0
  let dragging: { x: number; y: number; bx: number; by: number } | null = null
  let selecting = $state(false)
  let start = { x: 0, y: 0 }
  let rect = $state({ x: 0, y: 0, width: 0, height: 0 })

  function showError(cause: unknown): void {
    error = String(cause).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')
  }

  async function focusInput(): Promise<void> {
    await tick()
    if (document.hasFocus()) input?.focus({ preventScroll: true })
  }

  function addImage(dataUrl: string, mimeType = 'image/png', name = 'Screenshot.png'): void {
    const next = [...files, { name, mimeType, dataUrl }]
    validateQuery({ query, files: next })
    files = next
    error = ''
  }

  async function submit(): Promise<void> {
    if (busy || capturing || !validDestination || !destination) return
    busy = true
    error = ''
    try {
      const payload = { query: query.trim(), files: files.map((file) => ({ ...file })) }
      validateQuery(payload)
      await api.sendEvent({ ...destination }, { type: 'query', data: payload })
      query = ''
      files = []
      destination = null
    } catch (cause) {
      showError(cause)
    } finally {
      busy = false
      void focusInput()
    }
  }

  async function paste(event: ClipboardEvent): Promise<void> {
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    )
    if (!images.length) return
    event.preventDefault()
    if (busy || capturing) return
    const current = generation
    try {
      for (const file of images) {
        if (file.size > MAX_IMAGE_BYTES) throw new Error($i18n.t('spotlight.imageTooLarge'))
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error($i18n.t('spotlight.clipboardError')))
          reader.readAsDataURL(file)
        })
        if (current !== generation) return
        addImage(dataUrl, file.type, file.name || 'Clipboard.png')
      }
    } catch (cause) {
      if (current === generation) showError(cause)
    }
  }

  function begin(event: MouseEvent): void {
    if (event.button !== 0 || busy || capturing) return
    const target = event.target as HTMLElement
    if (target.closest('.bar')) {
      if (target.closest('textarea, button, select, .preview')) return
      event.preventDefault()
      dragging = { x: event.clientX, y: event.clientY, bx: x, by: y }
    } else {
      if (screenPicker && !preview) {
        void api.close()
        return
      }
      event.preventDefault()
      start = { x: event.clientX, y: event.clientY }
      rect = { ...start, width: 0, height: 0 }
      selecting = true
    }
  }

  function move(event: MouseEvent): void {
    if (dragging) {
      x = Math.max(16, Math.min(width - barWidth - 16, dragging.bx + event.clientX - dragging.x))
      y = Math.max(16, Math.min(height - 260, dragging.by + event.clientY - dragging.y))
    } else if (selecting) {
      const endX = Math.max(0, Math.min(width, event.clientX))
      const endY = Math.max(0, Math.min(height, event.clientY))
      rect = {
        x: Math.min(endX, start.x),
        y: Math.min(endY, start.y),
        width: Math.abs(endX - start.x),
        height: Math.abs(endY - start.y)
      }
    }
  }

  async function capture(pickScreen = false): Promise<void> {
    if (busy || capturing) return
    if (files.length >= MAX_IMAGES) {
      error = $i18n.t('spotlight.tooManyImages')
      return
    }
    capturing = true
    error = ''
    const current = generation
    try {
      const result = await api.capture(pickScreen ? undefined : { ...rect })
      if (current !== generation) return
      if (pickScreen) preview = result
      else {
        addImage(result)
        preview = ''
      }
    } catch (cause) {
      if (current === generation) showError(cause)
    } finally {
      capturing = false
      await focusInput()
    }
  }

  function end(): void {
    if (dragging) {
      dragging = null
      void api.savePosition({ x, y }).catch(showError)
    } else if (selecting) {
      selecting = false
      if (rect.width > 10 && rect.height > 10) void capture()
      else void api.close()
    }
  }

  onMount(() => {
    const offInit = api.onInit(async (state) => {
      generation++
      connections = state.connections
      if (!destination)
        destination =
          connections.find((item) => item.id === state.selected) ?? connections[0] ?? null
      width = state.width
      height = state.height
      x = Math.max(
        16,
        Math.min(
          width - Math.min(748, width - 32) - 16,
          state.position?.x ?? (width - Math.min(748, width - 32)) / 2
        )
      )
      y = Math.max(16, Math.min(height - 260, state.position?.y ?? 160))
      screenPicker = state.useScreenPicker
      document.documentElement.classList.toggle('dark', state.dark)
      document.documentElement.style.colorScheme = state.dark ? 'dark' : 'light'
      if (!query && !files.length && !busy && state.clipboard) query = state.clipboard
      await changeLanguage(state.language)
      await focusInput()
    })
    const offHide = api.onHide(() => {
      generation++
      selecting = false
      dragging = null
      preview = ''
    })
    return () => {
      offInit()
      offHide()
    }
  })
</script>

<svelte:window
  onfocus={focusInput}
  onmousemove={move}
  onmouseup={end}
  onpaste={paste}
  onkeydown={(event) => {
    if (event.key === 'Escape') void api.close()
  }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onmousedown={begin}>
  {#if preview}<img
      class="screen-preview"
      src={preview}
      alt={$i18n.t('spotlight.screenSelection')}
    />{/if}
  {#if selecting && rect.width > 8 && rect.height > 8}
    <div
      class="selection"
      style:left={`${rect.x}px`}
      style:top={`${rect.y}px`}
      style:width={`${rect.width}px`}
      style:height={`${rect.height}px`}
    ></div>
  {/if}
  <section
    class="bar rounded-[20px] border border-black/5 bg-white px-[12px] pb-[12px] pt-[8px] shadow-2xl dark:border-white/10 dark:bg-gray-900"
    aria-label={$i18n.t('spotlight.title')}
    style:left={`${x}px`}
    style:top={`${y}px`}
    style:width={`${barWidth}px`}
  >
    <div class="mb-[8px] flex items-center gap-[12px] text-[11px] text-gray-600 dark:text-gray-400">
      <span class="cursor-move font-medium">Open WebUI Tether</span>
      {#if connections.length}
        <select
          aria-label={$i18n.t('spotlight.destination')}
          title={destination?.url}
          disabled={busy}
          class="max-w-[65%] truncate rounded-[6px] bg-transparent px-[4px] py-[2px] outline-none focus:ring-1 focus:ring-blue-400"
          value={validDestination ? destination?.id : ''}
          onchange={(event) => {
            destination = connections.find((item) => item.id === event.currentTarget.value) ?? null
            error = ''
          }}
        >
          {#if !validDestination}<option value="" disabled
              >{$i18n.t('spotlight.selectConnection')}</option
            >{/if}
          {#each connections as connection (connection.id)}<option value={connection.id}
              >{connection.name}</option
            >{/each}
        </select>
      {:else}<button class="underline underline-offset-2" onclick={() => api.addConnection()}
          >{$i18n.t('connections.add')}</button
        >{/if}
      <div class="flex-1"></div>
      {#if query || files.length}<button
          disabled={busy || capturing}
          onclick={() => {
            generation++
            query = ''
            files = []
            error = ''
            preview = ''
            input?.focus()
          }}>{$i18n.t('common.clear')}</button
        >{/if}
      <span class="text-gray-400/60 dark:text-gray-600/70">
        {busy
          ? $i18n.t('spotlight.sending')
          : capturing
            ? $i18n.t('spotlight.capturing')
            : $i18n.t('spotlight.sendHint')}{$i18n.t('spotlight.closeHint')}</span
      >
    </div>
    {#if files.length}
      <div class="preview mb-[12px] flex flex-wrap gap-[8px]">
        {#each files as file, i (file)}
          <div class="relative">
            <img
              src={file.dataUrl}
              alt={file.name}
              class="h-[72px] w-[96px] rounded-[8px] border border-black/5 object-cover dark:border-white/10"
            />
            <button
              aria-label={$i18n.t('spotlight.removeImage', { number: i + 1 })}
              disabled={busy}
              class="absolute -end-[4px] -top-[4px] size-[18px] rounded-full bg-gray-900 p-[3px] text-white [&>svg]:size-full"
              onclick={() => (files = files.filter((_, index) => index !== i))}
              >{@html Xmark}</button
            >
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex items-center gap-[12px]">
      <textarea
        dir={query ? 'auto' : $i18n.dir()}
        bind:this={input}
        bind:value={query}
        aria-label={$i18n.t('spotlight.ask')}
        placeholder={$i18n.t('spotlight.placeholder')}
        rows="1"
        maxlength="100000"
        disabled={busy}
        class="field-sizing-content max-h-[144px] min-h-[24px] min-w-0 flex-1 resize-none bg-transparent text-[16px] leading-[24px] text-gray-900 outline-none placeholder:text-gray-500 dark:text-gray-100 dark:placeholder:text-gray-600"
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      ></textarea>
      <button
        aria-label={$i18n.t('common.send')}
        disabled={busy || capturing || !validDestination || (!query.trim() && !files.length)}
        onclick={submit}
        class="size-[30px] shrink-0 rounded-full bg-gray-900 p-[7px] text-white dark:bg-white dark:text-gray-900 [&>svg]:size-full [&>svg]:stroke-[2.5]"
        >{@html ArrowUp}</button
      >
    </div>
    {#if screenPicker && !preview}
      <button
        class="mt-[12px] flex items-center gap-[6px] text-[11px] text-gray-500"
        disabled={busy || capturing}
        onclick={() => capture(true)}
      >
        <span class="size-[12px] [&>svg]:size-full" aria-hidden="true">{@html Camera}</span
        >{$i18n.t('spotlight.chooseScreen')}</button
      >
    {/if}
    {#if !validDestination && destination}<p
        role="alert"
        class="mt-3 text-[12px] text-red-600 dark:text-red-400"
      >
        {$i18n.t('spotlight.connectionChanged')}
      </p>{/if}
    {#if error}<p role="alert" class="mt-3 text-[12px] text-red-600 dark:text-red-400 select-text">
        {error}
      </p>{/if}
  </section>
</div>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    background: transparent !important;
  }
  .overlay {
    position: fixed;
    inset: 0;
  }
  .bar {
    position: absolute;
  }
  .screen-preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .selection {
    position: absolute;
    border: 1px solid white;
    box-shadow: 0 0 0 9999px #0005;
    pointer-events: none;
  }
</style>
