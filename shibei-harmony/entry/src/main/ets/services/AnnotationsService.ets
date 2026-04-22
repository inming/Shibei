// Façade over ShibeiService that tracks annotations per-resource with a
// local in-memory cache and notifies subscribers on mutation. Reader uses
// this instead of calling ShibeiService directly so painting highlights
// and updating the panel stay in sync.

import { ShibeiService, Highlight, Comment, AnnotationsBundle } from './ShibeiService';

type Listener = (bundle: AnnotationsBundle) => void;

export class AnnotationsService {
  private static _instance: AnnotationsService | null = null;

  static get instance(): AnnotationsService {
    if (!AnnotationsService._instance) {
      AnnotationsService._instance = new AnnotationsService();
    }
    return AnnotationsService._instance;
  }

  private cache: Map<string, AnnotationsBundle> = new Map();
  private listeners: Map<string, Listener[]> = new Map();

  private notify(resourceId: string): void {
    const bundle = this.cache.get(resourceId);
    if (!bundle) return;
    const subs = this.listeners.get(resourceId) ?? [];
    // Copy before iterating so a listener can unsubscribe itself mid-dispatch.
    for (const fn of subs.slice()) fn(bundle);
  }

  subscribe(resourceId: string, fn: Listener): () => void {
    const list = this.listeners.get(resourceId) ?? [];
    list.push(fn);
    this.listeners.set(resourceId, list);
    return () => {
      const cur = this.listeners.get(resourceId) ?? [];
      this.listeners.set(resourceId, cur.filter(x => x !== fn));
    };
  }

  async load(resourceId: string): Promise<AnnotationsBundle> {
    const bundle = ShibeiService.instance.listAnnotations(resourceId);
    this.cache.set(resourceId, bundle);
    this.notify(resourceId);
    return bundle;
  }

  get(resourceId: string): AnnotationsBundle {
    return this.cache.get(resourceId) ?? { highlights: [], comments: [] };
  }

  createHighlight(
    resourceId: string,
    textContent: string,
    anchor: Object,
    color: string,
  ): Highlight {
    const h = ShibeiService.instance.createHighlight(resourceId, textContent, anchor, color);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = { highlights: cur.highlights.concat([h]), comments: cur.comments };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
    return h;
  }

  deleteHighlight(resourceId: string, id: string): void {
    ShibeiService.instance.deleteHighlight(id);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights.filter(h => h.id !== id),
      comments: cur.comments.filter(c => c.highlight_id !== id),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  updateHighlightColor(resourceId: string, id: string, color: string): void {
    const updated = ShibeiService.instance.updateHighlightColor(id, color);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights.map(h => h.id === id ? updated : h),
      comments: cur.comments,
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  createComment(
    resourceId: string,
    highlightId: string | null,
    content: string,
  ): Comment {
    const c = ShibeiService.instance.createComment(resourceId, highlightId, content);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = { highlights: cur.highlights, comments: cur.comments.concat([c]) };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
    return c;
  }

  updateComment(resourceId: string, id: string, content: string): void {
    ShibeiService.instance.updateComment(id, content);
    const cur = this.get(resourceId);
    const now = new Date().toISOString();
    const next: AnnotationsBundle = {
      highlights: cur.highlights,
      comments: cur.comments.map(c => {
        if (c.id !== id) {
          return c;
        }
        const nextComment: Comment = {
          id: c.id,
          highlight_id: c.highlight_id,
          resource_id: c.resource_id,
          content,
          created_at: c.created_at,
          updated_at: now,
        };
        return nextComment;
      }),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }

  deleteComment(resourceId: string, id: string): void {
    ShibeiService.instance.deleteComment(id);
    const cur = this.get(resourceId);
    const next: AnnotationsBundle = {
      highlights: cur.highlights,
      comments: cur.comments.filter(c => c.id !== id),
    };
    this.cache.set(resourceId, next);
    this.notify(resourceId);
  }
}
