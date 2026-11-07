import { createInstance } from 'i18next'
import enUS from '../renderer/src/lib/i18n/locales/en-US/translation.json' with { type: 'json' }
import ar from '../renderer/src/lib/i18n/locales/ar/translation.json' with { type: 'json' }
import bgBG from '../renderer/src/lib/i18n/locales/bg-BG/translation.json' with { type: 'json' }
import deDE from '../renderer/src/lib/i18n/locales/de-DE/translation.json' with { type: 'json' }
import esES from '../renderer/src/lib/i18n/locales/es-ES/translation.json' with { type: 'json' }
import frFR from '../renderer/src/lib/i18n/locales/fr-FR/translation.json' with { type: 'json' }
import heIL from '../renderer/src/lib/i18n/locales/he-IL/translation.json' with { type: 'json' }
import hiIN from '../renderer/src/lib/i18n/locales/hi-IN/translation.json' with { type: 'json' }
import itIT from '../renderer/src/lib/i18n/locales/it-IT/translation.json' with { type: 'json' }
import jaJP from '../renderer/src/lib/i18n/locales/ja-JP/translation.json' with { type: 'json' }
import koKR from '../renderer/src/lib/i18n/locales/ko-KR/translation.json' with { type: 'json' }
import nlNL from '../renderer/src/lib/i18n/locales/nl-NL/translation.json' with { type: 'json' }
import plPL from '../renderer/src/lib/i18n/locales/pl-PL/translation.json' with { type: 'json' }
import ruRU from '../renderer/src/lib/i18n/locales/ru-RU/translation.json' with { type: 'json' }
import zhCN from '../renderer/src/lib/i18n/locales/zh-CN/translation.json' with { type: 'json' }
import zhTW from '../renderer/src/lib/i18n/locales/zh-TW/translation.json' with { type: 'json' }

const resources = {
  'en-US': { translation: enUS },
  ar: { translation: ar },
  'bg-BG': { translation: bgBG },
  'de-DE': { translation: deDE },
  'es-ES': { translation: esES },
  'fr-FR': { translation: frFR },
  'he-IL': { translation: heIL },
  'hi-IN': { translation: hiIN },
  'it-IT': { translation: itIT },
  'ja-JP': { translation: jaJP },
  'ko-KR': { translation: koKR },
  'nl-NL': { translation: nlNL },
  'pl-PL': { translation: plPL },
  'ru-RU': { translation: ruRU },
  'zh-CN': { translation: zhCN },
  'zh-TW': { translation: zhTW }
}

// Native menus and dialogs share the renderer's catalogs and saved language.
const i18n = createInstance()
void i18n.init({
  resources,
  lng: 'en-US',
  fallbackLng: 'en-US',
  supportedLngs: Object.keys(resources),
  initAsync: false,
  keySeparator: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false }
})

export const t = i18n.t.bind(i18n)
export const setLanguage = (language: string): ReturnType<typeof i18n.changeLanguage> =>
  i18n.changeLanguage(language)
