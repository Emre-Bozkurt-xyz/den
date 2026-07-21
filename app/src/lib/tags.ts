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
