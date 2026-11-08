<script lang="ts">
  import i18n, { getLanguages, changeLanguage } from '../../lib/i18n'
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import { onMount } from 'svelte'
  import NavArrowDownIcon from 'iconoir/icons/nav-arrow-down.svg?raw'
  import XmarkIcon from 'iconoir/icons/xmark.svg?raw'
  import Switch from '../common/Switch.svelte'
  import {
    defaultGeneralConfig,
    uiScaleOptions,
    type GeneralConfig
  } from '../../../../shared/config'

  let config = $state<GeneralConfig>({ ...defaultGeneralConfig })
  let platform = $state('')
  let deviceName = $state('')
  let launchAtLogin = $state(false)
  let loaded = $state(false)
  let busy = $state(false)
  let recording = $state<'globalShortcut' | 'spotlightShortcut' | null>(null)
  let advancedOpen = $state(false)
  let resetting = $state(false)
  let error = $state('')
  const languages = getLanguages()
  const toggles = $derived([
    {
      key: 'spotlightClipboardPaste',
      label: $i18n.t('settings.general.clipboardPaste'),
      description: $i18n.t('settings.general.clipboardPasteDesc')
    },
    {
      key: 'startMinimized',
      label: $i18n.t('settings.general.startMinimized'),
      description: $i18n.t('settings.general.startMinimizedDesc')
    },
    {
      key: 'runInBackground',
      label: $i18n.t('settings.general.runInBackground'),
      description: $i18n.t('settings.general.runInBackgroundDesc')
    },
    {
      key: 'showMenuBarIcon',
      label: $i18n.t('settings.general.showMenuBarIcon'),
      description: $i18n.t('settings.general.showMenuBarIconDesc')
    }
  ] as const)

  onMount(() => {
    let disposed = false
    const unsubscribe = window.api.onConfigChanged((saved) => {
      config = saved
    })
    void Promise.all([
      window.api.getConfig(),
      window.api.getAppInfo(),
      window.api.getLaunchAtLogin()
    ])
      .then(([saved, info, login]) => {
        if (disposed) return
        config = saved
        platform = info.platform
        deviceName = info.deviceName
        launchAtLogin = login
        loaded = true
      })
      .catch((cause) => {
        if (!disposed) error = String(cause).replace(/^Error: /, '')
      })
    return () => {
      disposed = true
      unsubscribe()
    }
  })

  async function save(patch: Partial<GeneralConfig>): Promise<void> {
    const previous = config
    config = { ...config, ...patch }
    busy = true
    error = ''
    try {
      await window.api.setConfig(patch)
      config = await window.api.getConfig()
    } catch (cause) {
      config = previous
      error = String(cause).replace(/^Error: /, '')
    } finally {
      busy = false
    }
  }

  async function setLaunchAtLogin(enabled: boolean): Promise<void> {
    const previous = launchAtLogin
    launchAtLogin = enabled
    busy = true
    error = ''
    try {
      launchAtLogin = await window.api.setLaunchAtLogin(enabled)
    } catch (cause) {
      launchAtLogin = previous
      error = String(cause).replace(/^Error: /, '')
    } finally {
      busy = false
    }
  }

  async function reset(): Promise<void> {
    resetting = true
    error = ''
    try {
      await window.api.resetApp()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      resetting = false
    }
  }

  function recordShortcut(event: KeyboardEvent): void {
    if (!recording) return
    const keySetting = recording
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      recording = null
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      recording = null
      void save({ [keySetting]: '' })
      return
    }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
    const parts: string[] = []
    if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    const keys: Record<string, string> = {
      Space: 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Return',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/'
    }
    const key =
      keys[event.code] ??
      (event.code.startsWith('Key')
        ? event.code.slice(3)
        : event.code.startsWith('Digit')
          ? event.code.slice(5)
          : event.key)
    parts.push(key)
    recording = null
    void save({ [keySetting]: parts.join('+') })
  }

  const shortcut = (value: string): string =>
    value
      .replace(/CommandOrControl/g, platform === 'darwin' ? '⌘' : 'Ctrl')
      .replace(/Alt/g, platform === 'darwin' ? '⌥' : 'Alt')
      .replace(/Shift/g, platform === 'darwin' ? '⇧' : 'Shift')
      .replace(/\+/g, ' + ')
</script>

<div class="general-settings">
  <div class="setting-row">
    <div>
      <label class="setting-label" for="language">{$i18n.t('settings.general.language')}</label>
      <p class="setting-description">{$i18n.t('settings.general.languageDesc')}</p>
    </div>
    <div class="select-wrapper">
      <select
        id="language"
        class="setting-input"
        value={$i18n.resolvedLanguage}
        disabled={!loaded || busy}
        onchange={async (event) => {
          const language = event.currentTarget.value
          await save({ language })
          if (!error) await changeLanguage(language)
        }}
      >
        {#each languages as language (language.code)}
          <option value={language.code}>{language.title}</option>
        {/each}
      </select>
      <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
        >{@html NavArrowDownIcon}</span
      >
    </div>
  </div>
  <div class="setting-row">
    <div>
      <label class="setting-label" for="device-name">{$i18n.t('settings.general.deviceName')}</label
      >
      <p class="setting-description">{$i18n.t('settings.general.deviceNameDesc')}</p>
    </div>
    <input
      id="device-name"
      dir="auto"
      class="setting-input device-name"
      value={config.deviceName}
      placeholder={deviceName}
      maxlength="100"
      disabled={!loaded || busy}
      onchange={(event) => save({ deviceName: event.currentTarget.value })}
    />
  </div>
  <div class="setting-row">
    <div>
      <label class="setting-label" for="appearance">{$i18n.t('settings.general.appearance')}</label>
      <p class="setting-description">{$i18n.t('settings.general.appearanceDesc')}</p>
    </div>
    <div class="select-wrapper">
      <select
        id="appearance"
        class="setting-input"
        value={config.theme}
        disabled={!loaded || busy}
        onchange={(event) => save({ theme: event.currentTarget.value as GeneralConfig['theme'] })}
      >
        <option value="system">{$i18n.t('common.auto')}</option><option value="light"
          >{$i18n.t('settings.general.light')}</option
        ><option value="dark">{$i18n.t('settings.general.dark')}</option>
      </select>
      <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
        >{@html NavArrowDownIcon}</span
      >
    </div>
  </div>
  <div class="setting-row">
    <div>
      <label class="setting-label" for="ui-scale">{$i18n.t('settings.general.uiScale')}</label>
      <p class="setting-description">{$i18n.t('settings.general.uiScaleDesc')}</p>
    </div>
    <div class="select-wrapper">
      <select
        id="ui-scale"
        class="setting-input"
        value={config.uiScale}
        disabled={!loaded || busy}
        onchange={(event) => save({ uiScale: Number(event.currentTarget.value) })}
      >
        {#each uiScaleOptions as scale (scale)}
          <option value={scale}>{Math.round(scale * 100)}%</option>
        {/each}
      </select>
      <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
        >{@html NavArrowDownIcon}</span
      >
    </div>
  </div>
  {#if platform !== 'linux'}
    <div class="setting-row">
      <div>
        <div class="setting-label">{$i18n.t('settings.general.launchAtLogin')}</div>
        <p class="setting-description">{$i18n.t('settings.general.launchAtLoginDesc')}</p>
      </div>
      <Switch
        checked={launchAtLogin}
        label={$i18n.t('settings.general.launchAtLogin')}
        disabled={!loaded || busy}
        onchange={setLaunchAtLogin}
      />
    </div>
  {/if}
  {#each toggles as setting (setting.key)}
    {#if setting.key !== 'showMenuBarIcon' || platform === 'darwin'}
      <div class="setting-row">
        <div>
          <div class="setting-label">{setting.label}</div>
          <p class="setting-description">{setting.description}</p>
        </div>
        <Switch
          checked={config[setting.key]}
          label={setting.label}
          disabled={!loaded || busy}
          onchange={(value) => save({ [setting.key]: value })}
        />
      </div>
    {/if}
  {/each}
  {#each [{ key: 'globalShortcut', label: $i18n.t('settings.general.globalShortcut'), description: $i18n.t('settings.general.globalShortcutDesc') }, { key: 'spotlightShortcut', label: $i18n.t('settings.general.spotlightShortcut'), description: $i18n.t('settings.general.spotlightShortcutDesc') }] as setting (setting.key)}
    <div class="setting-row">
      <div>
        <div class="setting-label">{setting.label}</div>
        <p class="setting-description">{setting.description}</p>
      </div>
      <div class="shortcut-controls">
        <button
          class="shortcut-button"
          class:animate-pulse={recording === setting.key}
          aria-label={setting.label}
          aria-pressed={recording === setting.key}
          disabled={!loaded || busy}
          onclick={() => {
            recording = setting.key as typeof recording
            error = ''
          }}
          onkeydown={recordShortcut}
          onblur={() => (recording = null)}
        >
          {recording === setting.key
            ? $i18n.t('settings.general.pressShortcut')
            : shortcut(config[setting.key]) || $i18n.t('common.disabled')}
        </button>
        {#if config[setting.key] && recording !== setting.key}
          <button
            class="clear-shortcut"
            aria-label={$i18n.t('settings.general.clearNamedShortcut', { shortcut: setting.label })}
            title={$i18n.t('settings.general.clearShortcut')}
            disabled={!loaded || busy}
            onclick={() => save({ [setting.key]: '' })}
          >
            <span aria-hidden="true" class="inline-flex size-[12px] [&>svg]:size-full"
              >{@html XmarkIcon}</span
            >
          </button>
        {/if}
      </div>
    </div>
  {/each}
  <div class="setting-row">
    <button class="shortcut-button" onclick={() => window.api.openSpotlight()}
      >{$i18n.t('settings.general.openSpotlight')}</button
    >
  </div>
  <div class="pt-[16px]">
    <button
      class="inline-flex max-w-full shrink-0 items-center justify-center gap-[6px] whitespace-nowrap border-none bg-transparent p-0 text-[12px] leading-[16px] text-[oklch(0.69_0_0)] transition-colors duration-150 hover:text-[oklch(0.2_0_0)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-white [&>span[aria-hidden]]:size-[12px]"
      aria-expanded={advancedOpen}
      aria-controls="advanced-settings"
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <span
        aria-hidden="true"
        class="inline-flex size-[12px] shrink-0 items-center justify-center leading-none transition-transform duration-200 [&>svg]:size-full"
        class:-rotate-90={!advancedOpen && $i18n.dir() !== 'rtl'}
        class:rotate-90={!advancedOpen && $i18n.dir() === 'rtl'}>{@html NavArrowDownIcon}</span
      >
      <span class="setting-label">{$i18n.t('common.advanced')}</span>
    </button>
    {#if advancedOpen}
      <div id="advanced-settings" class="flex flex-col">
        <div class="setting-row">
          <div>
            <div class="setting-label">{$i18n.t('settings.general.factoryReset')}</div>
            <p class="setting-description">{$i18n.t('settings.general.factoryResetDesc')}</p>
          </div>
          <button class="reset-button" disabled={!loaded || busy || resetting} onclick={reset}
            >{resetting ? $i18n.t('common.resetting') : $i18n.t('common.reset')}</button
          >
        </div>
      </div>
    {/if}
  </div>
  {#if error}<p
      class="mt-2 text-[11px] leading-[16px] text-red-600 dark:text-red-400 break-words select-text"
      role="alert"
    >
      {error}
    </p>{/if}
</div>

<style>
  .reset-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.69 0 0);
    transition: color 150ms;
  }
  .reset-button:hover {
    color: oklch(0.2 0 0);
  }
  :global(.dark) .reset-button:hover {
    color: white;
  }
  .reset-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .general-settings {
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 7px;
  }
  .setting-row > :first-child {
    min-width: 0;
  }
  .setting-row > :last-child {
    flex-shrink: 0;
  }
  .setting-label {
    font-size: 12px;
    line-height: 16px;
    font-weight: 400;
    color: #171717;
  }
  .setting-description {
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
    margin-top: 2px;
  }
  :global(.dark) .setting-label {
    color: #fff;
  }
  :global(.dark) .setting-description {
    color: oklch(0.77 0 0);
  }
  .select-wrapper {
    position: relative;
    display: inline-flex;
    max-width: 100%;
  }
  .setting-input {
    appearance: none;
    outline: none !important;
    transition: border-color 150ms;
    min-width: 100px;
    height: 28px;
    max-width: 100%;
    border-radius: 8px;
    border: 1px solid oklch(0.94 0 0 / 0.5);
    background: oklch(0.98 0 0 / 0.4);
    padding-block: 0;
    padding-inline: 10px 32px;
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.42 0 0);
  }
  .setting-input:focus {
    border-color: #60a5fa;
  }
  .device-name {
    width: 180px;
    min-width: 0;
    max-width: 50%;
    padding-inline: 10px;
  }
  .device-name::placeholder {
    color: var(--text-placeholder);
  }
  :global(.dark) .setting-input:focus {
    border-color: #3b82f6;
  }
  .select-chevron {
    pointer-events: none;
    position: absolute;
    inset-inline-end: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    color: oklch(0.77 0 0);
  }
  :global(.dark) .setting-input {
    border-color: #ffffff0a;
    background: #ffffff08;
    color: oklch(0.85 0 0);
  }
  :global(.dark) .select-chevron {
    color: oklch(0.69 0 0);
  }
  .shortcut-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 65%;
  }
  .shortcut-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 80px;
    padding: 0;
    white-space: nowrap;
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.69 0 0);
    transition: color 150ms;
  }
  .shortcut-button:hover {
    color: oklch(0.2 0 0);
  }
  :global(.dark) .shortcut-button:hover {
    color: #fff;
  }
  .clear-shortcut {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: oklch(0.69 0 0);
  }
  .clear-shortcut:hover {
    color: oklch(0.2 0 0);
  }
  :global(.dark) .clear-shortcut:hover {
    color: #fff;
  }
  .setting-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (max-width: 640px) {
    .setting-row {
      gap: 12px;
    }
  }
</style>
