<script lang="ts">
  import i18n from '../../lib/i18n'
  import ConnectionList from './ConnectionList.svelte'
</script>

<ConnectionList
  type="openai"
  title={$i18n.t('settings.models.title')}
  description={$i18n.t('settings.models.description')}
  add={$i18n.t('settings.models.add')}
  placeholder="http://127.0.0.1:11434/v1"
  suggestions={[
    { label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
    { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }
  ]}
/>
