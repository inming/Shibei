// Central list of AppStorage / preferences keys. Add entries here before
// reading/writing elsewhere so collisions and typos show up at compile time.

export const KEY_FOLD_STATUS = 'foldStatus';           // FoldStatus enum
export const KEY_PENDING_DEEP_LINK = 'pendingDeepLink'; // string URL
export const KEY_PENDING_SHARE_URL = 'pendingShareUrl'; // string URL captured by share intent while locked
export const KEY_SUSPENDED_AT = 'suspendedAt';          // epoch ms, written on onBackground
export const KEY_SYNC_PROGRESS = 'syncProgress';        // { current, total }

// Preferences (persistent) keys
export const PREF_SESSION_STATE = 'shibei-session-state';
export const PREF_LIBRARY_LEFT_WIDTH = 'library-left-width';
export const PREF_ANNOTATION_WIDTH = 'annotation-drawer-width';
export const PREF_AUTO_LOCK_MINUTES = 'autoLockMinutes';
export const PREF_MK_BIOMETRIC_WRAPPED = 'mk_biometric_wrapped';
export const PREF_THEME = 'shibei-theme';               // 'system' | 'light' | 'dark'
