import type { AddTagRequest, MediaTagsResponse, Tag, TagsAutocompleteResponse } from '@den/shared';
import { api } from './api';

/** Tags on one media item — used by the chat-side viewer, which (unlike the
 *  gallery) has no page response to inherit batched tags from. */
export function fetchMediaTags(mediaId: string): Promise<MediaTagsResponse> {
  return api<MediaTagsResponse>(`/api/media/${mediaId}/tags`);
}

export function fetchTagAutocomplete(chatId: string, prefix: string): Promise<TagsAutocompleteResponse> {
  const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
  return api<TagsAutocompleteResponse>(`/api/chats/${chatId}/tags${qs}`);
}

export function addTag(mediaId: string, name: string): Promise<Tag> {
  const body: AddTagRequest = { name };
  return api<Tag>(`/api/media/${mediaId}/tags`, { method: 'POST', body: JSON.stringify(body) });
}

export function removeTag(mediaId: string, tagId: string): Promise<{ ok: true }> {
  return api(`/api/media/${mediaId}/tags/${tagId}`, { method: 'DELETE' });
}

/** Tags common to every item in a set, matched by tag id — the batch tag
 *  panel (and, per docs/MEDIA_ATTACHMENTS.md §5.2, the composer's attachment
 *  sheet in multi-select) edits this intersection, not any single item's
 *  tags. Generalized out of `ChatGallery.tsx`'s `computeTagIntersection`
 *  (BACKBONE §15 2026-07-22) to take a list of tag-lists directly rather than
 *  `GalleryItem[]`, so it works for both the gallery's `Tag[]` and the
 *  attachment sheet's client-only synthesized tag objects. `ChatGallery.tsx`
 *  keeps its own local copy for now (coordination note, docs §5.2) — this is
 *  the shared version new call sites should use. */
export function commonTags<T extends { id: string }>(itemTagLists: readonly (readonly T[])[]): T[] {
  if (itemTagLists.length === 0) return [];
  const [first, ...rest] = itemTagLists;
  return (first ?? []).filter((tag) => rest.every((list) => list.some((t) => t.id === tag.id)));
}
