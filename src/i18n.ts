import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCommon from './locales/zh/common.json';
import zhSidebar from './locales/zh/sidebar.json';
import zhReader from './locales/zh/reader.json';
import zhAnnotation from './locales/zh/annotation.json';
import zhSettings from './locales/zh/settings.json';
import zhSync from './locales/zh/sync.json';
import zhEncryption from './locales/zh/encryption.json';
import zhLock from './locales/zh/lock.json';
import zhSearch from './locales/zh/search.json';
import zhData from './locales/zh/data.json';
import zhAi from './locales/zh/ai.json';

import enCommon from './locales/en/common.json';
import enSidebar from './locales/en/sidebar.json';
import enReader from './locales/en/reader.json';
import enAnnotation from './locales/en/annotation.json';
import enSettings from './locales/en/settings.json';
import enSync from './locales/en/sync.json';
import enEncryption from './locales/en/encryption.json';
import enLock from './locales/en/lock.json';
import enSearch from './locales/en/search.json';
import enData from './locales/en/data.json';
import enAi from './locales/en/ai.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: {
        common: zhCommon, sidebar: zhSidebar, reader: zhReader,
        annotation: zhAnnotation, settings: zhSettings, sync: zhSync,
        encryption: zhEncryption, lock: zhLock, search: zhSearch, data: zhData, ai: zhAi,
      },
      en: {
        common: enCommon, sidebar: enSidebar, reader: enReader,
        annotation: enAnnotation, settings: enSettings, sync: enSync,
        encryption: enEncryption, lock: enLock, search: enSearch, data: enData, ai: enAi,
      },
    },
    fallbackLng: 'zh',
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'shibei-language',
      caches: ['localStorage'],
    },
  });

export default i18n;
