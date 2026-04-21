// Single NavPathStack shared across pages so any page can pushPath/popPath
// without passing the stack down a prop chain. Components Provide/Consume
// this under the key 'pathStack'.

export class NavPathManager {
  private static _instance: NavPathManager | null = null;
  readonly stack: NavPathStack = new NavPathStack();

  static get instance(): NavPathManager {
    if (!NavPathManager._instance) {
      NavPathManager._instance = new NavPathManager();
    }
    return NavPathManager._instance;
  }
}

// Page names — string literals everywhere use these constants to keep the
// PageMap builder in sync with pushPath call sites.
export const PAGE_ONBOARD = 'Onboard';
export const PAGE_LOCK = 'Lock';
export const PAGE_LIBRARY = 'Library';
export const PAGE_READER = 'Reader';
export const PAGE_SEARCH = 'Search';
export const PAGE_SETTINGS = 'Settings';
