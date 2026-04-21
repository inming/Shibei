import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { ShibeiService, ShibeiError } from '../services/ShibeiService';

// Phase 2 Track A4 batch 2 — exercises the 6 query commands against an
// empty local DB. A fresh install has no resources/folders/tags beyond the
// "收件箱" (inbox) folder that shibei-db seeds on migration, so the
// expected shape is:
//   listFolders    → [{ id: "__inbox__", name: "收件箱", ... }]
//   listResources  → []
//   listTags       → []
//   searchResources → []
//   getResource    → null (for any id)
//   summary        → ""

@Entry
@Component
struct Demo10Queries {
  @State dataDir: string = '';
  @State initStatus: string = '(press Init then query buttons)';
  @State foldersLine: string = '';
  @State resourcesLine: string = '';
  @State tagsLine: string = '';
  @State searchLine: string = '';
  @State getResourceLine: string = '';
  @State summaryLine: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.dataDir = ctx.filesDir;
  }

  private async runInit(): Promise<void> {
    try {
      await ShibeiService.instance.init(this.dataDir);
      this.initStatus = `init ok (${this.dataDir})`;
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : `${err.name}: ${err.message}`;
      this.initStatus = `ERR: ${code}`;
    }
  }

  private queryFolders(): void {
    try {
      const list = ShibeiService.instance.listFolders();
      this.foldersLine = `listFolders: ${list.length} rows — ${list.map(f => `${f.name}(${f.id})`).join(', ') || '(none)'}`;
    } catch (err) {
      this.foldersLine = `ERR: ${err.message}`;
      hilog.error(0x0000, 'shibei', 'demo10 listFolders fail: %{public}s', err.message);
    }
  }

  private queryResources(): void {
    try {
      const list = ShibeiService.instance.listResources('__all__');
      this.resourcesLine = `listResources(__all__): ${list.length} rows`;
    } catch (err) {
      this.resourcesLine = `ERR: ${err.message}`;
    }
  }

  private queryTags(): void {
    try {
      const list = ShibeiService.instance.listTags();
      this.tagsLine = `listTags: ${list.length} rows`;
    } catch (err) {
      this.tagsLine = `ERR: ${err.message}`;
    }
  }

  private runSearch(): void {
    try {
      const list = ShibeiService.instance.searchResources('hello');
      this.searchLine = `searchResources("hello"): ${list.length} hits`;
    } catch (err) {
      this.searchLine = `ERR: ${err.message}`;
    }
  }

  private runGetResource(): void {
    try {
      const r = ShibeiService.instance.getResource('nonexistent-id-for-smoke');
      this.getResourceLine = `getResource(bogus): ${r === null ? 'null (ok)' : `${r.title}`}`;
    } catch (err) {
      this.getResourceLine = `ERR: ${err.message}`;
    }
  }

  private runSummary(): void {
    try {
      const s = ShibeiService.instance.getResourceSummary('nonexistent-id-for-smoke', 100);
      this.summaryLine = `getResourceSummary(bogus, 100) → "${s}"`;
    } catch (err) {
      this.summaryLine = `ERR: ${err.message}`;
    }
  }

  private runAll(): void {
    this.queryFolders();
    this.queryResources();
    this.queryTags();
    this.runSearch();
    this.runGetResource();
    this.runSummary();
  }

  build() {
    Scroll() {
      Column() {
        Text('Demo 10: Queries (A4 batch 2)').fontSize(20).margin({ top: 24, bottom: 8 });

        Text('Must press Init first (A3 lifecycle); calling queries before\ninit() returns "error.notInitialized".').fontSize(12).width('90%');

        Button('1) run init').width('90%').margin({ top: 16 }).onClick(() => this.runInit());
        Text(this.initStatus).margin({ top: 8 }).width('90%');

        Button('2) run all queries').width('90%').margin({ top: 16 }).onClick(() => this.runAll());

        Text(this.foldersLine).margin({ top: 12 }).width('90%').fontSize(12).fontFamily('monospace');
        Text(this.resourcesLine).margin({ top: 4 }).width('90%').fontSize(12).fontFamily('monospace');
        Text(this.tagsLine).margin({ top: 4 }).width('90%').fontSize(12).fontFamily('monospace');
        Text(this.searchLine).margin({ top: 4 }).width('90%').fontSize(12).fontFamily('monospace');
        Text(this.getResourceLine).margin({ top: 4 }).width('90%').fontSize(12).fontFamily('monospace');
        Text(this.summaryLine).margin({ top: 4 }).width('90%').fontSize(12).fontFamily('monospace');

        Text('Expected on empty local DB:').fontSize(14).margin({ top: 20 });
        Text('  listFolders    → 1 row (__inbox__ seed)').fontSize(12).fontFamily('monospace');
        Text('  listResources  → 0 rows').fontSize(12).fontFamily('monospace');
        Text('  listTags       → 0 rows').fontSize(12).fontFamily('monospace');
        Text('  searchResources → 0 hits').fontSize(12).fontFamily('monospace');
        Text('  getResource(bogus) → null').fontSize(12).fontFamily('monospace');
        Text('  summary(bogus)  → ""').fontSize(12).fontFamily('monospace');
      }
      .width('100%').padding(16);
    }
    .width('100%').height('100%');
  }
}
