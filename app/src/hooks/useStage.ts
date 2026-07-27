import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddStageDocRequest } from '@den/shared';
import {
  addStageDoc,
  clampPickerQuery,
  fetchRenderedStageDoc,
  fetchStage,
  fetchStagePicker,
  openStagePortal,
  removeStageDoc,
} from '../lib/stage';

/** `GET /chats/:id/stage` — the grid's data source. Only ever mounted while
 *  the Stage overlay/panel is open (see `components/Stage.tsx`), so unlike
 *  `useMessageSearch` there's no separate `enabled` gate to thread through. */
export function useStage(chatId: string) {
  return useQuery({ queryKey: ['stage', chatId] as const, queryFn: () => fetchStage(chatId) });
}

/** `GET /chats/:id/stage/documents?query=` — the clone picker's list.
 *  `enabled` gates on both "picker modal open" and "viewer linked" (an
 *  unlinked viewer sees a Connect-Vault prompt instead, see Stage.tsx) so an
 *  unlinked user's keystrokes never fire a request that would just 4xx. */
export function useStagePicker(chatId: string, query: string, enabled: boolean) {
  const clamped = clampPickerQuery(query);
  return useQuery({
    queryKey: ['stagePicker', chatId, clamped] as const,
    queryFn: () => fetchStagePicker(chatId, clamped),
    enabled,
  });
}

export function useAddStageDoc(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddStageDocRequest) => addStageDoc(chatId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stage', chatId] }),
  });
}

export function useRemoveStageDoc(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => removeStageDoc(chatId, docId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stage', chatId] }),
  });
}

/** `POST /chats/:id/stage/docs/:docId/portal` — mints a fresh, single-use
 *  editor session. Deliberately a *mutation*, not a query: React Query would
 *  happily serve a cached `portalUrl` back out of a query cache, which is
 *  exactly the "reuse" shared/src/vault.ts's `PortalSessionResponse` warns
 *  against (the boot token is single-use, so a reused URL fails closed). */
export function useStagePortal(chatId: string) {
  return useMutation({ mutationFn: (docId: string) => openStagePortal(chatId, docId) });
}

/** `GET /chats/:id/stage/rendered/:vaultDocumentId` — the snapshot backing
 *  both the read view and the paper thumbnail (docs/EMBEDS.md §6.2.1). Safe
 *  to cache normally (it's a relayed server-side snapshot, not a live
 *  session): a short `staleTime` just avoids re-fetching the same doc's
 *  thumbnail and its read-view open within the same Stage visit. */
export function useRenderedStageDoc(chatId: string, vaultDocumentId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['stageRendered', chatId, vaultDocumentId] as const,
    queryFn: () => fetchRenderedStageDoc(chatId, vaultDocumentId!),
    enabled: enabled && !!vaultDocumentId,
    staleTime: 60_000,
  });
}
