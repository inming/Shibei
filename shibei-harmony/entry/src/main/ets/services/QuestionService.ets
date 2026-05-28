// Façade over ShibeiService for the questions system. Caches the active /
// archived lists and per-question link arrays, and notifies subscribers on
// every mutation so the sidebar / detail view stay in sync without manual
// callback wiring. Mirrors AnnotationsService's pattern.

import {
  ShibeiService,
  Question,
  QuestionLink,
  QuestionStatus,
  QuestionTargetType,
} from './ShibeiService';

type ListListener = (snapshot: QuestionListSnapshot) => void;
type LinkListener = (links: QuestionLink[]) => void;
type TargetListener = (questions: Question[]) => void;

/** Snapshot delivered to list subscribers. Both lists are always present
 *  (possibly empty) so consumers don't need null-checks. */
export interface QuestionListSnapshot {
  active: Question[];
  archived: Question[];
}

const EMPTY_SNAPSHOT: QuestionListSnapshot = { active: [], archived: [] };

function targetKey(targetType: QuestionTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

export class QuestionService {
  private static _instance: QuestionService | null = null;

  static get instance(): QuestionService {
    if (!QuestionService._instance) {
      const svc = new QuestionService();
      // Self-subscribe to sync completion so remote changes propagate to
      // every cache without each page needing to remember. Best-effort; the
      // subscription returns an unsubscribe fn we deliberately drop because
      // the service lives for the whole app process.
      ShibeiService.instance.onDataChanged(() => {
        svc.onSyncCompleted().catch(() => { /* swallow */ });
      });
      QuestionService._instance = svc;
    }
    return QuestionService._instance;
  }

  // ── caches ──
  private listCache: QuestionListSnapshot = EMPTY_SNAPSHOT;
  private linkCache: Map<string, QuestionLink[]> = new Map();
  private targetCache: Map<string, Question[]> = new Map();

  // ── listeners ──
  private listListeners: ListListener[] = [];
  private linkListeners: Map<string, LinkListener[]> = new Map();
  private targetListeners: Map<string, TargetListener[]> = new Map();

  // ─── list (sidebar) ─────────────────────────────────────────────

  subscribeList(fn: ListListener): () => void {
    this.listListeners.push(fn);
    return () => {
      this.listListeners = this.listListeners.filter(x => x !== fn);
    };
  }

  getList(): QuestionListSnapshot {
    return this.listCache;
  }

  async loadList(): Promise<QuestionListSnapshot> {
    const active = ShibeiService.instance.listQuestions('active');
    const archived = ShibeiService.instance.listQuestions('archived');
    this.listCache = { active, archived };
    this.notifyList();
    return this.listCache;
  }

  private notifyList(): void {
    for (const fn of this.listListeners.slice()) fn(this.listCache);
  }

  // ─── per-question links (detail view) ──────────────────────────

  subscribeLinks(questionId: string, fn: LinkListener): () => void {
    const list = this.linkListeners.get(questionId) ?? [];
    list.push(fn);
    this.linkListeners.set(questionId, list);
    return () => {
      const cur = this.linkListeners.get(questionId) ?? [];
      this.linkListeners.set(questionId, cur.filter(x => x !== fn));
    };
  }

  getLinks(questionId: string): QuestionLink[] {
    return this.linkCache.get(questionId) ?? [];
  }

  async loadLinks(questionId: string): Promise<QuestionLink[]> {
    const links = ShibeiService.instance.listQuestionLinks(questionId);
    this.linkCache.set(questionId, links);
    this.notifyLinks(questionId);
    return links;
  }

  private notifyLinks(questionId: string): void {
    const links = this.getLinks(questionId);
    const subs = this.linkListeners.get(questionId) ?? [];
    for (const fn of subs.slice()) fn(links);
  }

  // ─── reverse-lookup (per resource/highlight/comment) ────────────

  subscribeTarget(
    targetType: QuestionTargetType,
    targetId: string,
    fn: TargetListener,
  ): () => void {
    const key = targetKey(targetType, targetId);
    const list = this.targetListeners.get(key) ?? [];
    list.push(fn);
    this.targetListeners.set(key, list);
    return () => {
      const cur = this.targetListeners.get(key) ?? [];
      this.targetListeners.set(key, cur.filter(x => x !== fn));
    };
  }

  getTargetQuestions(targetType: QuestionTargetType, targetId: string): Question[] {
    return this.targetCache.get(targetKey(targetType, targetId)) ?? [];
  }

  async loadTargetQuestions(
    targetType: QuestionTargetType,
    targetId: string,
  ): Promise<Question[]> {
    const qs = ShibeiService.instance.listQuestionsForTarget(targetType, targetId);
    const key = targetKey(targetType, targetId);
    this.targetCache.set(key, qs);
    this.notifyTarget(key);
    return qs;
  }

  private notifyTarget(key: string): void {
    const qs = this.targetCache.get(key) ?? [];
    const subs = this.targetListeners.get(key) ?? [];
    for (const fn of subs.slice()) fn(qs);
  }

  /** Invalidate every cached reverse-lookup. Called by mutations that may
   *  affect arbitrary targets — currently the question-level cascades
   *  (delete / archive) and the per-link mutations. */
  private refreshAllTargets(): void {
    for (const key of this.targetCache.keys()) {
      const parts = key.split(':');
      if (parts.length < 2) continue;
      const tt = parts[0] as QuestionTargetType;
      const tid = parts.slice(1).join(':');
      // best effort — fire-and-forget; the next loadTargetQuestions call
      // will repopulate
      try {
        const qs = ShibeiService.instance.listQuestionsForTarget(tt, tid);
        this.targetCache.set(key, qs);
        this.notifyTarget(key);
      } catch {
        // ignore — empty result is acceptable
      }
    }
  }

  // ─── mutations ───────────────────────────────────────────────────

  createQuestion(title: string, description: string | null = null): Question {
    const q = ShibeiService.instance.createQuestion(title, description);
    this.listCache = {
      active: [q, ...this.listCache.active],
      archived: this.listCache.archived,
    };
    this.notifyList();
    return q;
  }

  updateQuestion(id: string, title: string, description: string | null = null): void {
    ShibeiService.instance.updateQuestion(id, title, description);
    const apply = (q: Question): Question =>
      q.id === id ? mergeQuestion(q, title, description) : q;
    this.listCache = {
      active: this.listCache.active.map(apply),
      archived: this.listCache.archived.map(apply),
    };
    this.notifyList();
  }

  archiveQuestion(id: string): void {
    ShibeiService.instance.archiveQuestion(id);
    const moved = this.listCache.active.find(q => q.id === id);
    if (!moved) return;
    const archivedQ: Question = {
      id: moved.id,
      title: moved.title,
      description: moved.description,
      status: 'archived',
      archived_at: new Date().toISOString(),
      created_at: moved.created_at,
      updated_at: new Date().toISOString(),
    };
    this.listCache = {
      active: this.listCache.active.filter(q => q.id !== id),
      archived: [archivedQ, ...this.listCache.archived],
    };
    this.notifyList();
    // Status change affects target chips' rendering (active vs archived).
    this.refreshAllTargets();
  }

  unarchiveQuestion(id: string): void {
    ShibeiService.instance.unarchiveQuestion(id);
    const moved = this.listCache.archived.find(q => q.id === id);
    if (!moved) return;
    const activeQ: Question = {
      id: moved.id,
      title: moved.title,
      description: moved.description,
      status: 'active',
      archived_at: null,
      created_at: moved.created_at,
      updated_at: new Date().toISOString(),
    };
    this.listCache = {
      active: [activeQ, ...this.listCache.active],
      archived: this.listCache.archived.filter(q => q.id !== id),
    };
    this.notifyList();
    this.refreshAllTargets();
  }

  deleteQuestion(id: string): void {
    ShibeiService.instance.deleteQuestion(id);
    this.listCache = {
      active: this.listCache.active.filter(q => q.id !== id),
      archived: this.listCache.archived.filter(q => q.id !== id),
    };
    this.linkCache.delete(id);
    this.notifyList();
    // Detail view subscribers on the deleted question get an empty list.
    this.notifyLinks(id);
    // Every reverse-lookup that included this question must drop it.
    this.refreshAllTargets();
  }

  linkToQuestion(
    questionId: string,
    targetType: QuestionTargetType,
    targetId: string,
    reason: string | null = null,
  ): QuestionLink {
    const link = ShibeiService.instance.linkToQuestion(questionId, targetType, targetId, reason);
    const cur = this.linkCache.get(questionId) ?? [];
    // Avoid duplicates (link is idempotent server-side).
    if (!cur.some(l => l.id === link.id)) {
      this.linkCache.set(questionId, cur.concat([link]));
      this.notifyLinks(questionId);
    }
    // Reverse-lookup for this target must include the new question.
    this.refreshTarget(targetType, targetId);
    return link;
  }

  updateLinkReason(questionId: string, linkId: string, reason: string | null): void {
    ShibeiService.instance.updateLinkReason(linkId, reason);
    const cur = this.linkCache.get(questionId) ?? [];
    const next = cur.map(l =>
      l.id === linkId
        ? {
            id: l.id,
            question_id: l.question_id,
            target_type: l.target_type,
            target_id: l.target_id,
            reason,
            created_at: l.created_at,
            updated_at: new Date().toISOString(),
          } as QuestionLink
        : l,
    );
    this.linkCache.set(questionId, next);
    this.notifyLinks(questionId);
  }

  unlinkQuestion(questionId: string, linkId: string): void {
    const cur = this.linkCache.get(questionId) ?? [];
    const removed = cur.find(l => l.id === linkId);
    ShibeiService.instance.unlinkQuestion(linkId);
    this.linkCache.set(questionId, cur.filter(l => l.id !== linkId));
    this.notifyLinks(questionId);
    if (removed) {
      this.refreshTarget(removed.target_type, removed.target_id);
    }
  }

  private refreshTarget(targetType: QuestionTargetType, targetId: string): void {
    const key = targetKey(targetType, targetId);
    if (!this.targetListeners.get(key)?.length) {
      // No subscribers — drop the stale cache and skip the DB roundtrip;
      // a future subscribe will refetch.
      this.targetCache.delete(key);
      return;
    }
    try {
      const qs = ShibeiService.instance.listQuestionsForTarget(targetType, targetId);
      this.targetCache.set(key, qs);
      this.notifyTarget(key);
    } catch {
      // ignore
    }
  }

  /** Called by ShibeiService.onDataChanged after a sync pulled remote
   *  changes. Reloads any cached list / per-question links to surface
   *  cross-device updates without UI manual refresh. */
  async onSyncCompleted(): Promise<void> {
    if (this.listListeners.length > 0) {
      try { await this.loadList(); } catch { /* ignore */ }
    }
    for (const qid of Array.from(this.linkCache.keys())) {
      try { await this.loadLinks(qid); } catch { /* ignore */ }
    }
    this.refreshAllTargets();
  }
}

function mergeQuestion(
  base: Question,
  title: string,
  description: string | null,
): Question {
  return {
    id: base.id,
    title,
    description,
    status: base.status,
    archived_at: base.archived_at,
    created_at: base.created_at,
    updated_at: new Date().toISOString(),
  };
}
