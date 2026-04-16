import 'i18next';
import type zhCommon from '../locales/zh/common.json';
import type zhSidebar from '../locales/zh/sidebar.json';
import type zhReader from '../locales/zh/reader.json';
import type zhAnnotation from '../locales/zh/annotation.json';
import type zhSettings from '../locales/zh/settings.json';
import type zhSync from '../locales/zh/sync.json';
import type zhEncryption from '../locales/zh/encryption.json';
import type zhLock from '../locales/zh/lock.json';
import type zhSearch from '../locales/zh/search.json';
import type zhData from '../locales/zh/data.json';
import type zhAi from '../locales/zh/ai.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof zhCommon;
      sidebar: typeof zhSidebar;
      reader: typeof zhReader;
      annotation: typeof zhAnnotation;
      settings: typeof zhSettings;
      sync: typeof zhSync;
      encryption: typeof zhEncryption;
      lock: typeof zhLock;
      search: typeof zhSearch;
      data: typeof zhData;
      ai: typeof zhAi;
    };
  }
}
