<script lang="ts">
  import i18n from '../../lib/i18n'
  import ConnectionList from './ConnectionList.svelte'
  import ToolConnections from './ToolConnections.svelte'
</script>

<div class="flex flex-col gap-3">
  <ConnectionList
    type="openai"
    title={$i18n.t('settings.integrations.models')}
    description={$i18n.t('settings.integrations.modelsDesc')}
    add={$i18n.t('settings.integrations.addModel')}
    editTitle={$i18n.t('settings.integrations.editModel')}
    placeholder="http://127.0.0.1:11434/v1"
    suggestions={[
      { label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
      { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }
    ]}
    warning={false}
  />
  <ToolConnections />
  <ConnectionList
    type="terminal"
    title={$i18n.t('settings.integrations.terminals')}
    description={$i18n.t('settings.integrations.terminalsDesc')}
    add={$i18n.t('settings.integrations.addTerminal')}
    editTitle={$i18n.t('settings.integrations.editTerminal')}
    placeholder="http://127.0.0.1:8000"
  />
</div>
