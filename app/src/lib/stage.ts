import {
  StageLimits,
  type AddStageDocRequest,
  type AddStageDocResponse,
  type PortalSessionResponse,
  type RenderedDocResponse,
  type StageDoc,
  type StageResponse,
  type VaultPickerDoc,
} from '@den/shared';
import { api } from './api';

/** docs/EMBEDS.md §6.2 / shared/src/vault.ts — the Stage's REST surface.
 *  Mirrors `lib/gallery.ts`/`lib/chats.ts`'s plain-function-over-`api()`
 *  shape; all DTOs come from `@den/shared`, never redefined here. */

export function fetchStage(chatId: string): Promise<StageResponse> {
  return api<StageResponse>(`/api/chats/${chatId}/stage`);
}

export function addStageDoc(chatId: string, body: AddStageDocRequest): Promise<AddStageDocResponse> {
  return api<AddStageDocResponse>(`/api/chats/${chatId}/stage/docs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function removeStageDoc(chatId: string, docId: string): Promise<void> {
  return api<void>(`/api/chats/${chatId}/stage/docs/${docId}`, { method: 'DELETE' });
}

/** Mints a single-use portal session. Callers must treat the result as
 *  use-once (shared/src/vault.ts `PortalSessionResponse` doc comment) — this
 *  function itself is just the fetch; the "never cache/reuse" discipline
 *  lives in the caller (see `hooks/useStage.ts`'s `useStagePortal`, a
 *  mutation rather than a query). */
export function openStagePortal(chatId: string, docId: string): Promise<PortalSessionResponse> {
  return api<PortalSessionResponse>(`/api/chats/${chatId}/stage/docs/${docId}/portal`, { method: 'POST' });
}

export function fetchStagePicker(chatId: string, query: string): Promise<VaultPickerDoc[]> {
  const q = clampPickerQuery(query);
  const qs = q ? `?query=${encodeURIComponent(q)}` : '';
  return api<VaultPickerDoc[]>(`/api/chats/${chatId}/stage/documents${qs}`);
}

export function fetchRenderedStageDoc(chatId: string, vaultDocumentId: string): Promise<RenderedDocResponse> {
  return api<RenderedDocResponse>(`/api/chats/${chatId}/stage/rendered/${vaultDocumentId}`);
}

/** Clamps a picker search query to Vault's own limit
 *  (`StageLimits.maxPickerQueryLength`, shared/src/vault.ts) — Vault rejects
 *  anything longer with a 400 (docs/EMBEDS.md §7 Contract B2), so the client
 *  never sends a query it already knows will bounce. Trims first so trailing
 *  whitespace doesn't eat into the budget. Exported (not just used inline)
 *  so both `fetchStagePicker` and the picker's debounced input share exactly
 *  one definition of "too long". */
export function clampPickerQuery(query: string): string {
  return query.trim().slice(0, StageLimits.maxPickerQueryLength);
}

/** Grid ordering (docs/EMBEDS.md §6.2.1 "Ordering"): most-recently-updated
 *  first; docs Vault couldn't be reached for (`updatedAt: null`) sort after
 *  every doc with a real timestamp, broken by add order (`addedAt`, always
 *  present) among themselves. A fresh sorted copy — never mutates `docs`. */
export function sortStageDocs(docs: StageDoc[]): StageDoc[] {
  return [...docs].sort((a, b) => {
    if (a.updatedAt && b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    if (a.updatedAt && !b.updatedAt) return -1;
    if (!a.updatedAt && b.updatedAt) return 1;
    return b.addedAt.localeCompare(a.addedAt);
  });
}

/**
 * Private Vault images inside relayed HTML 404 for Den's cross-origin
 * viewers by design (docs/EMBEDS.md §7.1 item 5) — without this, a failed
 * `<img>` paints the browser's broken-image icon + alt box, which reads as
 * Den being broken rather than a known, documented gap. `error` events don't
 * bubble, but DO fire during the *capture* phase on ancestors as they travel
 * down to the target, so one capturing listener on the rendered-HTML
 * container catches every descendant `<img>` failure without needing to
 * touch the raw HTML string (which would risk breaking the sanitized markup
 * Vault handed back). Returns a cleanup function for the caller's effect.
 */
export function hideBrokenStageImages(container: HTMLElement): () => void {
  function onError(e: Event) {
    if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
  }
  container.addEventListener('error', onError, true);
  return () => container.removeEventListener('error', onError, true);
}
