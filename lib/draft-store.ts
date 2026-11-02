export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const listeners = new Map<string, Set<() => void>>();
// A sent/cleared draft must not resurrect on a repeated recall receipt.
const restoredRecalls = new Map<string, Set<string>>();
export const EMPTY_DRAFT: ChatDraft = Object.freeze({ value: "", images: [] });

export function getDraftSnapshot(key: string): ChatDraft {
  return drafts.get(key) ?? EMPTY_DRAFT;
}

export function subscribeDraft(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, set = new Set());
  set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) {
    try { listener(); } catch { listeners.get(key)?.delete(listener); }
  }
}

/** Promote this editor's provisional draft without aliasing the reusable new:<cwd> key. */
export function promoteDraft(from: string, to: string): void {
  if (from === to) return;
  const source = getDraftSnapshot(from);
  const target = getDraftSnapshot(to);
  const next = { value: [target.value, source.value].filter(Boolean).join("\n\n"), images: [...target.images, ...source.images] };
  if (!isEmptyDraft(next)) drafts.set(to, cloneDraft(next));
  drafts.delete(from);
  const restored = restoredRecalls.get(from);
  if (restored) restoredRecalls.set(to, new Set([...(restoredRecalls.get(to) ?? []), ...restored]));
  notify(from);
  notify(to);
}

export function updateDraft(key: string, update: (draft: ChatDraft) => ChatDraft): void {
  setDraft(key, update(cloneDraft(getDraftSnapshot(key))));
}

export function restoreRecallOnce(key: string, operationId: string, texts: readonly string[]): void {
  let restored = restoredRecalls.get(key);
  if (restored?.has(operationId)) return;
  const draft = getDraftSnapshot(key);
  const text = texts.join("\n\n");
  const next = { ...draft, value: [text, draft.value].filter(value => value.trim()).join("\n\n") };
  if (!restored) restoredRecalls.set(key, restored = new Set());
  restored.add(operationId);
  // Publish text and its dedupe fact together, before subscribers run.
  if (!isEmptyDraft(next)) drafts.set(key, cloneDraft(next));
  notify(key);
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
  } else {
    drafts.set(key, cloneDraft(draft));
  }
  notify(key);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  notify(key);
}
