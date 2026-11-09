<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import i18n from '../../lib/i18n'
  import { onMount } from 'svelte'
  import { parseLocalServerConfig, type RuntimeState } from '../../../../shared/config'
  import type { ServiceStatus } from '../../../../shared/terminal'
  import { sandboxConfigChanged, type SandboxConfig } from '../../../../shared/sandbox'
  import NavArrowDownIcon from 'iconoir/icons/nav-arrow-down.svg?raw'

  const id = $props.id()
  let { terminalStatus }: { terminalStatus: ServiceStatus } = $props()
  // Suggestions only; arbitrary variable names and values remain editable.
  const suggestions: Record<string, string[]> = {
    OPEN_TERMINAL_ENABLE_TERMINAL: ['true', 'false'],
    OPEN_TERMINAL_ENABLE_BROWSER: ['true', 'false'],
    OPEN_TERMINAL_ENABLE_DESKTOP: ['true', 'false'],
    OPEN_TERMINAL_EXECUTE_TIMEOUT: ['60', '120', '300'],
    OPEN_TERMINAL_MAX_SESSIONS: ['16', '32', '64'],
    OPEN_TERMINAL_FILE_BROWSER_ROOT: ['home', 'filesystem'],
    OPEN_TERMINAL_BROWSER_EXECUTABLE: [],
    OPEN_TERMINAL_BROWSER_NO_SANDBOX: ['false', 'true'],
    OPEN_TERMINAL_BROWSER_MODE: ['managed', 'personal'],
    OPEN_TERMINAL_BROWSER_CDP_URL: [],
    OPEN_TERMINAL_BROWSER_USER_DATA_DIR: [],
    OPEN_TERMINAL_TERM: ['xterm-256color', 'xterm'],
    OPEN_TERMINAL_ENABLE_SYSTEM_PROMPT: ['true', 'false'],
    OPEN_TERMINAL_SYSTEM_PROMPT: [],
    OPEN_TERMINAL_EXECUTE_DESCRIPTION: [],
    OPEN_TERMINAL_INFO: [],
    OPEN_TERMINAL_BINARY_MIME_PREFIXES: ['image', 'image,audio', 'image,audio,video'],
    OPEN_TERMINAL_MAX_LOG_SIZE: ['50000000'],
    OPEN_TERMINAL_LOG_RETENTION: ['604800'],
    OPEN_TERMINAL_LOG_FLUSH_INTERVAL: ['0', '1'],
    OPEN_TERMINAL_LOG_FLUSH_BUFFER: ['0'],
    OPEN_TERMINAL_SESSION_CWD_TTL: ['604800'],
    OPEN_TERMINAL_UVICORN_LOOP: ['auto', 'asyncio', 'uvloop'],
    OPEN_TERMINAL_UVICORN_TIMEOUT_KEEP_ALIVE: []
  }

  function focusNew(node: HTMLInputElement, empty: boolean): void {
    if (empty) node.focus()
  }

  let version = $state('')
  let homeDirectory = $state('')
  let defaultHomeDirectory = $state('')
  let enabled = $state(false)
  let autoUpdate = $state(false)
  let httpEnabled = $state(false)
  let httpHost = $state<'127.0.0.1' | '0.0.0.0'>('127.0.0.1')
  let transportSaving = $state(false)
  let accessCopied = $state(false)
  let env = $state<{ name: string; value: string }[]>([])
  let advancedOpen = $state(false)
  let restarting = $state(false)
  let savedSandbox = $state<SandboxConfig>({
    enabled: false,
    workspacePath: '',
    networkAccess: false
  })
  let sandboxEnabled = $state(false)
  let workspacePath = $state('')
  let networkAccess = $state(false)
  let sandboxSaving = $state(false)
  const sandboxDirty = $derived(
    sandboxConfigChanged(savedSandbox, { enabled: sandboxEnabled, workspacePath, networkAccess })
  )
  let runtime = $state<RuntimeState>({ version: null, status: '', busy: false, error: '' })
  let loaded = $state(false)
  let installing = $state(false)
  let uninstalling = $state(false)
  let error = $state('')
  let saving: Promise<void> = Promise.resolve()
  const busy = $derived(
    runtime.busy ||
      installing ||
      uninstalling ||
      restarting ||
      transportSaving ||
      sandboxSaving ||
      !loaded
  )
  const capabilities = $derived([
    {
      name: 'OPEN_TERMINAL_ENABLE_BROWSER',
      label: $i18n.t('settings.terminal.browserAccess'),
      description: $i18n.t('settings.terminal.browserAccessDesc')
    },
    {
      name: 'OPEN_TERMINAL_ENABLE_DESKTOP',
      label: $i18n.t('settings.terminal.desktopAccess'),
      description: $i18n.t('settings.terminal.desktopAccessDesc')
    }
  ])
  const browserMode = $derived(envValue('OPEN_TERMINAL_BROWSER_MODE', 'managed').toLowerCase())
  const fileRoot = $derived(envValue('OPEN_TERMINAL_FILE_BROWSER_ROOT', 'home').trim())
  const fileRootMode = $derived(
    !fileRoot || fileRoot.toLowerCase() === 'home'
      ? 'home'
      : fileRoot.toLowerCase() === 'filesystem'
        ? 'filesystem'
        : 'custom'
  )

  // Both views edit these same rows; absent variables keep Open Terminal's defaults.
  function envValue(name: string, fallback = ''): string {
    return env.find((row) => row.name.trim() === name)?.value ?? fallback
  }

  function envEnabled(name: string): boolean {
    return !['false', '0', 'no'].includes(envValue(name, 'true').toLowerCase())
  }

  function setEnv(name: string, value: string): void {
    const row = env.find((row) => row.name.trim() === name)
    if (value === '') env = env.filter((row) => row.name.trim() !== name)
    else if (row) row.value = value
    else env = [...env, { name, value }]
    saveSettings()
  }

  async function save(sandbox: SandboxConfig = savedSandbox): Promise<void> {
    const entries = env.filter((row) => row.name.trim() || row.value)
    const names = entries.map((row) => row.name.trim().toUpperCase())
    if (new Set(names).size !== names.length)
      throw new Error($i18n.t('settings.terminal.uniqueVariables'))
    const config = {
      localServer: parseLocalServerConfig({
        enabled,
        version,
        autoUpdate,
        httpEnabled,
        httpHost,
        homeDirectory,
        sandbox,
        env: Object.fromEntries(entries.map((row) => [row.name.trim(), row.value]))
      })
    }
    saving = saving.catch(() => {}).then(() => window.api.setConfig(config))
    return saving
  }

  async function chooseWorkspace(): Promise<void> {
    try {
      const directory = await window.api.selectDirectory()
      if (directory !== null) workspacePath = directory
    } catch (cause) {
      error = String(cause)
    }
  }

  async function applySandbox(): Promise<void> {
    sandboxSaving = true
    error = ''
    try {
      await save({ enabled: sandboxEnabled, workspacePath, networkAccess })
      const config = await window.api.getConfig()
      savedSandbox = config.localServer.sandbox
      sandboxEnabled = savedSandbox.enabled
      workspacePath = savedSandbox.workspacePath
      networkAccess = savedSandbox.networkAccess
      runtime = await window.api.getRuntimeState()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      sandboxSaving = false
    }
  }

  function saveSettings(): void {
    error = ''
    void save().catch((cause) => {
      error = String(cause).replace(/^Error: /, '')
    })
  }

  async function saveTransport(): Promise<void> {
    transportSaving = true
    accessCopied = false
    error = ''
    try {
      await save()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
      const config = (await window.api.getConfig()).localServer
      httpEnabled = config.httpEnabled
      httpHost = config.httpHost
    } finally {
      transportSaving = false
    }
  }

  async function copyCredentials(): Promise<void> {
    error = ''
    try {
      await window.api.copyTerminalCredentials()
      accessCopied = true
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    }
  }

  async function chooseDirectory(variable?: string): Promise<void> {
    error = ''
    try {
      const directory = await window.api.selectDirectory()
      if (directory === null) return
      if (variable) setEnv(variable, directory)
      else {
        homeDirectory = directory
        await save()
      }
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    }
  }

  async function restart(): Promise<void> {
    restarting = true
    error = ''
    try {
      await save()
      await window.api.restartTerminal()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      restarting = false
    }
  }

  async function install(): Promise<void> {
    installing = true
    error = ''
    try {
      await save()
      await window.api.installPackage()
      runtime = await window.api.getRuntimeState()
      enabled = (await window.api.getConfig()).localServer.enabled
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      installing = false
    }
  }

  async function uninstall(): Promise<void> {
    uninstalling = true
    error = ''
    try {
      await saving.catch(() => {})
      await window.api.uninstallPackage()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      try {
        runtime = await window.api.getRuntimeState()
        enabled = (await window.api.getConfig()).localServer.enabled
      } catch (cause) {
        error = String(cause).replace(/^Error: /, '')
      }
      uninstalling = false
    }
  }

  onMount(() => {
    let disposed = false
    const unsubscribe = window.api.onRuntimeState((state) => {
      runtime = state
    })
    void Promise.all([
      window.api.getConfig(),
      window.api.getRuntimeState(),
      window.api.getAppInfo()
    ])
      .then(([config, state, info]) => {
        if (disposed) return
        version = config.localServer.version
        homeDirectory = config.localServer.homeDirectory ?? ''
        defaultHomeDirectory = info.homeDirectory
        enabled = config.localServer.enabled
        autoUpdate = config.localServer.autoUpdate
        httpEnabled = config.localServer.httpEnabled
        httpHost = config.localServer.httpHost
        savedSandbox = config.localServer.sandbox
        sandboxEnabled = savedSandbox.enabled
        workspacePath = savedSandbox.workspacePath
        networkAccess = savedSandbox.networkAccess
        env = Object.entries(config.localServer.env ?? {}).map(([name, value]) => ({ name, value }))
        runtime = state
        loaded = true
      })
      .catch((cause) => {
        error = String(cause).replace(/^Error: /, '')
      })
    return () => {
      disposed = true
      unsubscribe()
    }
  })

  import Switch from '../common/Switch.svelte'
</script>

<div class="flex min-w-0 flex-col text-[#171717] dark:text-white">
  <div
    class="flex min-w-0 items-center justify-between gap-[16px] py-[7px] max-sm:gap-[12px] [&>:first-child]:min-w-0 [&>:last-child]:shrink-0 max-sm:[&>:last-child:not([role=switch])]:max-w-[65%]"
  >
    <div>
      <div class="text-[12px] leading-[16px] font-normal text-[#171717] dark:text-white">
        Open Terminal
      </div>
      <p
        class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)] mt-0.5"
      >
        {runtime.version ? `v${runtime.version}` : $i18n.t('settings.openwebui.notInstalled')}
      </p>
    </div>
    <button
      class="inline-flex max-w-full shrink-0 items-center justify-center gap-[6px] whitespace-nowrap border-none bg-transparent p-0 text-[12px] leading-[16px] text-[oklch(0.69_0_0)] transition-colors duration-150 hover:text-[oklch(0.2_0_0)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-white [&>span[aria-hidden]]:size-[12px]"
      disabled={busy}
      onclick={install}
      >{installing || (runtime.busy && !uninstalling)
        ? $i18n.t('common.installing')
        : runtime.version && enabled
          ? $i18n.t('common.update')
          : $i18n.t('common.install')}</button
    >
  </div>
  <div
    class="flex min-w-0 items-center justify-between gap-[16px] py-[7px] max-sm:gap-[12px] [&>:first-child]:min-w-0 [&>:last-child]:shrink-0 max-sm:[&>:last-child:not([role=switch])]:max-w-[65%]"
  >
    <div>
      <label
        for="terminal-version"
        class="text-[12px] leading-[16px] font-normal text-[#171717] dark:text-white"
        >{$i18n.t('common.version')}</label
      >
      <p
        class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)] mt-0.5"
      >
        {$i18n.t('settings.terminal.latestDesc')}
      </p>
    </div>
    <input
      dir="ltr"
      id="terminal-version"
      aria-label={$i18n.t('settings.terminal.version')}
      class="h-[28px] min-h-[28px] max-w-full rounded-[8px] border border-[oklch(0.94_0_0/0.5)] outline-hidden! bg-[oklch(0.98_0_0/0.4)] px-[8px] py-0 text-[12px] leading-[16px] font-normal text-[oklch(0.42_0_0)] transition-colors duration-150 placeholder:text-[oklch(0.85_0_0)] focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-[oklch(0.85_0_0)] dark:placeholder:text-[oklch(0.42_0_0)] dark:focus:border-blue-500 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&[type=number]]:[-moz-appearance:textfield] w-[96px]"
      placeholder={$i18n.t('common.latest')}
      bind:value={version}
      disabled={busy}
      maxlength="100"
      spellcheck="false"
      onchange={saveSettings}
    />
  </div>
  <div
    class="flex min-w-0 items-center justify-between gap-[16px] py-[7px] max-sm:gap-[12px] [&>:first-child]:min-w-0 [&>:last-child]:shrink-0 max-sm:[&>:last-child:not([role=switch])]:max-w-[65%]"
  >
    <div>
      <div class="text-[12px] leading-[16px] font-normal text-[#171717] dark:text-white">
        {$i18n.t('settings.openwebui.autoUpdate')}
      </div>
      <p
        class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)] mt-0.5"
      >
        {$i18n.t('settings.terminal.autoUpdateDesc')}
      </p>
    </div>
    <Switch
      checked={autoUpdate}
      label={$i18n.t('settings.openwebui.autoUpdate')}
      disabled={busy || !!version.trim()}
      onchange={(value) => {
        autoUpdate = value
        saveSettings()
      }}
    />
  </div>
  <p
    class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)] mt-0.5 mt-3!"
  >
    {$i18n.t('settings.terminal.description')}
  </p>
  <section class="mt-5" aria-label={$i18n.t('settings.sandbox.title')}>
    <h3 class="section-label">{$i18n.t('settings.sandbox.title')}</h3>
    <div class="setting-row">
      <div>
        <div class="setting-label">{$i18n.t('settings.sandbox.enable')}</div>
        <p class="setting-description">{$i18n.t('settings.sandbox.description')}</p>
      </div>
      <Switch
        checked={sandboxEnabled}
        label={$i18n.t('settings.sandbox.enable')}
        disabled={busy || (!savedSandbox.enabled && runtime.sandbox?.support.supported === false)}
        onchange={(value) => {
          sandboxEnabled = value
        }}
      />
    </div>
    {#if sandboxEnabled || savedSandbox.enabled}
      <label class="setting-label" for="sandbox-workspace"
        >{$i18n.t('settings.sandbox.workspace')}</label
      >
      <div class="mt-2 flex items-center gap-3">
        <input
          id="sandbox-workspace"
          class="env-input"
          dir="ltr"
          bind:value={workspacePath}
          disabled={busy}
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
        <button class="env-action shrink-0" disabled={busy} onclick={chooseWorkspace}
          >{$i18n.t('common.browse')}</button
        >
      </div>
      <p class="setting-description mt-2">{$i18n.t('settings.sandbox.details')}</p>
      <div class="setting-row mt-3">
        <div>
          <div class="setting-label">{$i18n.t('settings.sandbox.networkAccess')}</div>
          <p class="setting-description">{$i18n.t('settings.sandbox.networkAccessDesc')}</p>
        </div>
        <Switch
          checked={networkAccess}
          label={$i18n.t('settings.sandbox.networkAccess')}
          disabled={busy || !sandboxEnabled}
          onchange={(value) => {
            networkAccess = value
          }}
        />
      </div>
    {/if}
    {#if runtime.sandbox?.support.supported === false}
      <p class="setting-description mt-2" role="status">
        {$i18n.t('settings.sandbox.unavailable')}
        {runtime.sandbox.support.reason}
      </p>
    {:else if savedSandbox.enabled}
      <p class="setting-description mt-2" role="status">
        {runtime.sandbox?.error
          ? $i18n.t('settings.sandbox.failed')
          : runtime.sandbox?.active
            ? $i18n.t('settings.sandbox.active')
            : terminalStatus === 'starting'
              ? $i18n.t('settings.sandbox.starting')
              : $i18n.t('settings.sandbox.inactive')}
      </p>
      {#if runtime.sandbox?.error}<p class="setting-description mt-2" role="alert">
          {runtime.sandbox.error}
        </p>{/if}
    {/if}
    {#if sandboxDirty}
      <p class="setting-description mt-2">{$i18n.t('settings.sandbox.restartNotice')}</p>
      <p class="setting-description mt-2">{$i18n.t('settings.sandbox.existingProcesses')}</p>
      <button
        class="env-action mt-2"
        disabled={busy || (sandboxEnabled && !workspacePath.trim())}
        onclick={applySandbox}
      >
        {$i18n.t('settings.sandbox.apply')}
      </button>
    {/if}
  </section>
  <section class="mt-5" aria-label={$i18n.t('settings.terminal.tools')}>
    <h3 class="section-label">{$i18n.t('settings.terminal.tools')}</h3>
    {#each capabilities as capability (capability.name)}
      <div class="setting-row">
        <div>
          <div class="setting-label">{capability.label}</div>
          <p class="setting-description">{capability.description}</p>
        </div>
        <Switch
          checked={!savedSandbox.enabled && envEnabled(capability.name)}
          label={capability.label}
          disabled={busy || savedSandbox.enabled}
          onchange={(value) => setEnv(capability.name, String(value))}
        />
      </div>
    {/each}
    <div class="setting-row">
      <div>
        <label class="setting-label" for="terminal-session-limit"
          >{$i18n.t('settings.terminal.sessionLimit')}</label
        >
        <p class="setting-description">{$i18n.t('settings.terminal.sessionLimitDesc')}</p>
      </div>
      <input
        id="terminal-session-limit"
        class="env-input session-limit"
        type="number"
        min="1"
        step="1"
        value={envValue('OPEN_TERMINAL_MAX_SESSIONS')}
        placeholder="16"
        disabled={busy}
        onchange={(event) => {
          if (event.currentTarget.reportValidity())
            setEnv('OPEN_TERMINAL_MAX_SESSIONS', event.currentTarget.value)
        }}
      />
    </div>
    {#if !savedSandbox.enabled && envEnabled('OPEN_TERMINAL_ENABLE_BROWSER')}
      <div class="setting-row">
        <div>
          <label class="setting-label" for="terminal-browser-mode"
            >{$i18n.t('settings.terminal.chrome')}</label
          >
          <p class="setting-description">{$i18n.t('settings.terminal.chromeDesc')}</p>
        </div>
        <div class="select-wrapper">
          <select
            id="terminal-browser-mode"
            class="env-input setting-select"
            value={browserMode}
            disabled={busy}
            onchange={(event) => setEnv('OPEN_TERMINAL_BROWSER_MODE', event.currentTarget.value)}
          >
            <option value="managed">{$i18n.t('settings.terminal.managedChrome')}</option>
            <option value="personal">{$i18n.t('settings.terminal.personalChrome')}</option>
            {#if !['managed', 'personal'].includes(browserMode)}
              <option value={browserMode}>{browserMode}</option>
            {/if}
          </select>
          <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
            >{@html NavArrowDownIcon}</span
          >
        </div>
      </div>
      {#if browserMode === 'personal'}
        <p class="setting-description">{$i18n.t('settings.terminal.personalChromeDesc')}</p>
        <div class="mt-3">
          <label class="setting-label" for="terminal-browser-url"
            >{$i18n.t('settings.terminal.chromeUrl')}</label
          >
          <p class="setting-description">{$i18n.t('settings.terminal.chromeUrlDesc')}</p>
          <input
            id="terminal-browser-url"
            class="env-input mt-2"
            dir="ltr"
            type="url"
            pattern="https?://.+|wss?://.+"
            value={envValue('OPEN_TERMINAL_BROWSER_CDP_URL')}
            placeholder="http://127.0.0.1:9222"
            disabled={busy}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            onchange={(event) => {
              if (event.currentTarget.reportValidity())
                setEnv('OPEN_TERMINAL_BROWSER_CDP_URL', event.currentTarget.value.trim())
            }}
          />
        </div>
      {/if}
    {/if}
  </section>
  <section class="mt-5" aria-label={$i18n.t('settings.terminal.httpAccess')}>
    {#if runtime.ipcSupported === false && !httpEnabled && !savedSandbox.enabled}
      <p class="setting-description" role="status">{$i18n.t('settings.terminal.httpFallback')}</p>
    {/if}
    <div class="setting-row">
      <div>
        <div class="setting-label">{$i18n.t('settings.terminal.httpAccess')}</div>
        <p class="setting-description">{$i18n.t('settings.terminal.httpAccessDesc')}</p>
      </div>
      <Switch
        checked={httpEnabled && !savedSandbox.enabled}
        label={$i18n.t('settings.terminal.httpAccess')}
        disabled={busy || savedSandbox.enabled}
        onchange={(value) => {
          httpEnabled = value
          void saveTransport()
        }}
      />
    </div>
    {#if httpEnabled && !savedSandbox.enabled}
      <div class="setting-row">
        <label class="setting-label" for="terminal-http-host"
          >{$i18n.t('settings.terminal.httpHost')}</label
        >
        <select
          id="terminal-http-host"
          class="env-input w-auto!"
          value={httpHost}
          disabled={busy}
          onchange={(event) => {
            httpHost = event.currentTarget.value as typeof httpHost
            void saveTransport()
          }}
        >
          <option value="127.0.0.1">{$i18n.t('settings.terminal.httpLoopback')}</option>
          <option value="0.0.0.0">{$i18n.t('settings.terminal.httpAllInterfaces')}</option>
        </select>
      </div>
      {#if httpHost === '0.0.0.0'}
        <p class="setting-description">{$i18n.t('settings.terminal.httpNetworkDesc')}</p>
      {/if}
      <button
        class="env-action mt-2"
        disabled={busy || !enabled || terminalStatus !== 'started'}
        onclick={copyCredentials}
      >
        {accessCopied ? $i18n.t('logs.copied') : $i18n.t('settings.terminal.copyCredentials')}
      </button>
      <p class="setting-description">{$i18n.t('settings.terminal.httpCredentialsDesc')}</p>
    {/if}
  </section>
  {#if !savedSandbox.enabled}
    <section class="mt-5" aria-label={$i18n.t('settings.terminal.homeDirectory')}>
      <h3 class="section-label">{$i18n.t('settings.terminal.files')}</h3>
      <label for="terminal-home" class="text-[12px] leading-[16px] font-normal"
        >{$i18n.t('settings.terminal.homeDirectory')}</label
      >
      <p
        class="mt-0.5 text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)]"
      >
        {$i18n.t('settings.terminal.homeDirectoryDesc')}
      </p>
      <div class="mt-2 flex items-center gap-3">
        <input
          dir="ltr"
          id="terminal-home"
          class="env-input"
          bind:value={homeDirectory}
          placeholder={defaultHomeDirectory}
          disabled={busy}
          spellcheck="false"
          autocapitalize="off"
          onchange={saveSettings}
        />
        <button class="env-action shrink-0" disabled={busy} onclick={() => chooseDirectory()}
          >{$i18n.t('common.browse')}</button
        >
      </div>
      <div class="setting-row mt-3">
        <div>
          <label class="setting-label" for="terminal-file-root"
            >{$i18n.t('settings.terminal.fileRoot')}</label
          >
          <p class="setting-description">{$i18n.t('settings.terminal.fileRootDesc')}</p>
        </div>
        <div class="select-wrapper">
          <select
            id="terminal-file-root"
            class="env-input setting-select"
            value={fileRootMode}
            disabled={busy}
            onchange={(event) =>
              setEnv(
                'OPEN_TERMINAL_FILE_BROWSER_ROOT',
                event.currentTarget.value === 'custom'
                  ? homeDirectory.trim() || defaultHomeDirectory
                  : event.currentTarget.value
              )}
          >
            <option value="home">{$i18n.t('settings.terminal.homeDirectory')}</option>
            <option value="filesystem">{$i18n.t('settings.terminal.fileSystem')}</option>
            <option value="custom">{$i18n.t('settings.terminal.customFolder')}</option>
          </select>
          <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
            >{@html NavArrowDownIcon}</span
          >
        </div>
      </div>
      {#if fileRootMode === 'custom'}
        <div class="mt-2 flex items-center gap-3">
          <input
            dir="ltr"
            class="env-input"
            aria-label={$i18n.t('settings.terminal.customFolder')}
            value={fileRoot}
            disabled={busy}
            spellcheck="false"
            autocapitalize="off"
            onchange={(event) =>
              setEnv('OPEN_TERMINAL_FILE_BROWSER_ROOT', event.currentTarget.value)}
          />
          <button
            class="env-action shrink-0"
            disabled={busy}
            onclick={() => chooseDirectory('OPEN_TERMINAL_FILE_BROWSER_ROOT')}
            >{$i18n.t('common.browse')}</button
          >
        </div>
      {/if}
    </section>
  {/if}
  <div class="pt-[16px]">
    <button
      class="inline-flex max-w-full shrink-0 items-center justify-center gap-[6px] whitespace-nowrap border-none bg-transparent p-0 text-[12px] leading-[16px] text-[oklch(0.69_0_0)] transition-colors duration-150 hover:text-[oklch(0.2_0_0)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-white [&>span[aria-hidden]]:size-[12px]"
      aria-expanded={advancedOpen}
      aria-controls={`${id}-advanced`}
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
      <section
        id={`${id}-advanced`}
        class="flex flex-col"
        aria-label={$i18n.t('settings.general.environmentVariables')}
      >
        <div class="flex items-center justify-between gap-4 py-[7px]">
          <h3 class="text-[12px] leading-[16px] font-normal">
            {$i18n.t('settings.general.environmentVariables')}
          </h3>
          <button
            class="env-action"
            disabled={busy || env.some((row) => !row.name.trim())}
            onclick={() => {
              env = [...env, { name: '', value: '' }]
            }}>{$i18n.t('settings.terminal.addVariable')}</button
          >
        </div>
        <datalist id={`${id}-names`}>
          {#each Object.keys(suggestions) as name (name)}
            {#if !env.some((row) => row.name.trim().toUpperCase() === name)}
              <option value={name}></option>
            {/if}
          {/each}
        </datalist>
        <div class="flex flex-col gap-2">
          {#each env as row, index (row)}
            {@const options = Object.hasOwn(suggestions, row.name.trim())
              ? suggestions[row.name.trim()]
              : []}
            <div class="env-row">
              <input
                dir="ltr"
                class="env-input"
                aria-label={$i18n.t('settings.terminal.variableName', { number: index + 1 })}
                placeholder={$i18n.t('common.name')}
                list={`${id}-names`}
                autocomplete="off"
                title={row.name}
                use:focusNew={!row.name}
                bind:value={row.name}
                disabled={busy}
                spellcheck="false"
                autocapitalize="off"
                onchange={saveSettings}
              />
              <input
                dir="ltr"
                class="env-input"
                aria-label={$i18n.t('settings.terminal.variableValue', { number: index + 1 })}
                placeholder={$i18n.t('common.value')}
                list={options.length ? `${id}-values-${index}` : undefined}
                autocomplete="off"
                bind:value={row.value}
                disabled={busy}
                spellcheck="false"
                autocapitalize="off"
                onchange={saveSettings}
              />
              {#if options.length}
                <datalist id={`${id}-values-${index}`}>
                  {#each options as option (option)}<option value={option}></option>{/each}
                </datalist>
              {/if}
              <button
                class="env-action"
                aria-label={$i18n.t('settings.terminal.removeVariable', { number: index + 1 })}
                disabled={busy}
                onclick={() => {
                  env = env.filter((_, i) => i !== index)
                  saveSettings()
                }}>{$i18n.t('common.remove')}</button
              >
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
  <div class="mt-4 flex items-start justify-between gap-4">
    <p class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)]">
      {$i18n.t('settings.terminal.environmentDesc')}
    </p>
    <button
      class="env-action shrink-0"
      disabled={busy || !runtime.version || !enabled}
      onclick={restart}
      >{restarting
        ? $i18n.t('common.restarting')
        : $i18n.t('settings.terminal.restartToApply')}</button
    >
  </div>
  {#if runtime.version || enabled}
    <div class="mt-[10px] flex min-w-0 items-center justify-between gap-[16px] pt-[16px] pb-[7px]">
      <div>
        <div class="text-[12px] leading-[16px] font-normal">{$i18n.t('common.uninstall')}</div>
        <p
          class="mt-0.5 text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)]"
        >
          {$i18n.t('settings.terminal.uninstallDesc')}
        </p>
      </div>
      <button class="env-action shrink-0" disabled={busy} onclick={uninstall}>
        {uninstalling ? $i18n.t('common.uninstalling') : $i18n.t('common.uninstall')}
      </button>
    </div>
  {/if}
  {#if runtime.status}<p
      class="text-[11px] leading-[16px] text-[oklch(0.51_0_0)] dark:text-[oklch(0.77_0_0)] mt-0.5 mt-2! break-words select-text"
      role="status"
    >
      {runtime.status}
    </p>{/if}
  {#if error || runtime.error}<p
      class="mt-2 text-[11px] leading-[16px] text-red-600 dark:text-red-400 break-words select-text"
      role="alert"
    >
      {error || runtime.error}
    </p>{/if}
</div>

<style>
  .section-label {
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 500;
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
  .setting-label {
    font-size: 12px;
    line-height: 16px;
    font-weight: 400;
    color: #171717;
  }
  :global(.dark) .setting-label {
    color: #fff;
  }
  .setting-description {
    margin-top: 2px;
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
  }
  :global(.dark) .setting-description {
    color: oklch(0.77 0 0);
  }
  .select-wrapper {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    max-width: 55%;
  }
  .env-input.setting-select {
    appearance: none;
    padding-inline: 10px 32px;
  }
  .select-chevron {
    position: absolute;
    pointer-events: none;
    inset-inline-end: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    color: oklch(0.77 0 0);
  }
  :global(.dark) .select-chevron {
    color: oklch(0.69 0 0);
  }
  .env-input.session-limit {
    width: 72px;
    flex-shrink: 0;
  }
  .env-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }
  .env-input {
    height: 28px;
    min-width: 0;
    width: 100%;
    border-radius: 8px;
    border: 1px solid oklch(0.94 0 0 / 0.5);
    background: oklch(0.98 0 0 / 0.4);
    padding: 0 8px;
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.42 0 0);
    outline: none;
  }
  .env-input::placeholder {
    color: oklch(0.85 0 0);
  }
  .env-input:focus {
    border-color: #60a5fa;
  }
  :global(.dark) .env-input {
    border-color: #ffffff0a;
    background: #ffffff08;
    color: oklch(0.85 0 0);
  }
  :global(.dark) .env-input::placeholder {
    color: oklch(0.42 0 0);
  }
  :global(.dark) .env-input:focus {
    border-color: #3b82f6;
  }
  .env-action {
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.69 0 0);
    transition: color 150ms;
  }
  .env-action:hover {
    color: oklch(0.2 0 0);
  }
  :global(.dark) .env-action:hover {
    color: white;
  }
  .env-input:disabled,
  .env-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (max-width: 540px) {
    .env-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .env-input:first-child {
      grid-column: 1 / -1;
    }
  }
</style>
