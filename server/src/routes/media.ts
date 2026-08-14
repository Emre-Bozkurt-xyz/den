/**
 * Media upload/download routes (BACKBONE §6/§7). Every route asserts chat
 * membership (CLAUDE.md hard invariant 1) before touching anything. Media
 * bytes never transit this server (hard invariant 2) — these routes only
 * mint presigned URLs and record/verify metadata.
 */
import type { FastifyInstance } from 'fastify';
import { makeEnvelope, WsType, type AddTagRequest, type CompleteUploadRequest, type CreateUploadRequest, type CreateUploadResponse, type MediaTagsResponse, type MediaUrlResponse, type Tag } from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import { validation } from '../errors.js';
import { notifyChatMembers } from '../push/notify.js';
import { chatRoom } from '../realtime/rooms.js';
import { chatIdForMedia, completeUpload, createUpload, finalizeProcessing, getMediaUrls } from '../media/service.js';
import { addTag, removeTag, tagsForMediaIds } from '../media/tags.js';

const MEDIA_KINDS = new Set(['image', 'video', 'voice']);

function parseId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid id');
  }
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateUploadRequest }>('/media/uploads', { preHandler: requireAuth }, async (req) => {
    const body = req.body ?? ({} as CreateUploadRequest);
    if (!body.chatId || typeof body.chatId !== 'string') throw validation('chatId required');
    if (!Array.isArray(body.items) || body.items.length === 0) throw validation('items must be a non-empty array');

    const items = body.items.map((item, i) => {
      if (!item || !MEDIA_KINDS.has(item.kind)) throw validation(`items[${i}].kind must be image, video, or voice`);
      if (typeof item.mime !== 'string' || !item.mime) throw validation(`items[${i}].mime required`);
      if (typeof item.sizeBytes !== 'number') throw validation(`items[${i}].sizeBytes required`);
      // width/height are the optional aspect hint (docs/MEDIA_ATTACHMENTS.md
      // §4.6) — deliberately NOT validated here, because `aspectHint()` in the
      // service already treats every non-number, non-finite and non-positive
      // value as "no hint". Rejecting the request over a cosmetic field would
      // fail an upload for something that costs nothing to ignore.
      return { kind: item.kind, mime: item.mime, sizeBytes: item.sizeBytes, width: item.width, height: item.height };
    });

    const chatId = parseId(body.chatId);
    await assertMember(req.user!.id, chatId);

    let replyToId: bigint | undefined;
    if (typeof body.replyToId === 'string' && body.replyToId) {
      try {
        replyToId = BigInt(body.replyToId);
      } catch {
        throw validation('invalid replyToId');
      }
    }

    const result = await createUpload(chatId, req.user!.id, items, body.caption, replyToId);

    const res: CreateUploadResponse = {
      messageId: result.messageId.toString(),
      items: result.items.map((it, i) => ({
        mediaId: it.mediaId.toString(),
        presignedPutUrl: it.presignedPutUrl,
        requiredContentType: items[i]!.mime,
      })),
    };
    return res;
  });

  app.post<{ Params: { id: string }; Body: CompleteUploadRequest }>(
    '/media/:id/complete',
    { preHandler: requireAuth },
    async (req) => {
      const mediaId = parseId(req.params.id);
      const chatId = await chatIdForMedia(mediaId);
      if (chatId === null) throw validation('media not found');
      await assertMember(req.user!.id, chatId);

      const tags = Array.isArray(req.body?.tags)
        ? req.body.tags.filter((t): t is string => typeof t === 'string')
        : undefined;

      const result = await completeUpload(mediaId, req.user!.id, tags);

      // Placeholder fanout now (§7 step 4) — receivers see "processing", not
      // silence. Fanout rule (docs/MEDIA_ATTACHMENTS.md §4.4): the first item
      // of a message to complete emits message.new; every later one rides
      // media.ready instead (its payload already carries the whole message).
      // One push per album, not one per item — only the first completion
      // notifies.
      if (app.io) {
        const wsType = result.isFirstComplete ? WsType.MessageNew : WsType.MediaReady;
        app.io.to(chatRoom(result.chatId)).emit('ws', makeEnvelope(wsType, { message: result.message }));
        if (result.isFirstComplete) void notifyChatMembers(app.io, result.chatId, result.message);
      }

      // Run the sharp/ffmpeg pipeline in the background; don't make the
      // uploader's request wait on transcode time. media.ready follows.
      void finalizeProcessing(result.mediaId)
        .then((message) => {
          app.io?.to(chatRoom(result.chatId)).emit('ws', makeEnvelope(WsType.MediaReady, { message }));
        })
        .catch((err) => req.log.error({ err, mediaId: result.mediaId.toString() }, 'media processing failed'));

      return result.message;
    },
  );

  app.get<{ Params: { id: string } }>('/media/:id/url', { preHandler: requireAuth }, async (req) => {
    const mediaId = parseId(req.params.id);
    const chatId = await chatIdForMedia(mediaId);
    if (chatId === null) throw validation('media not found');
    await assertMember(req.user!.id, chatId);

    const urls = await getMediaUrls(mediaId);
    const res: MediaUrlResponse = urls;
    return res;
  });

  // Single-media tag read. The gallery batches tags into its page response,
  // but the chat-side viewer opens straight off a message bubble with no
  // gallery page behind it (docs/archive/UI_REVAMP.md UI-7) — same membership gate,
  // same data, just addressable one media at a time.
  app.get<{ Params: { id: string } }>('/media/:id/tags', { preHandler: requireAuth }, async (req) => {
    const mediaId = parseId(req.params.id);
    const chatId = await chatIdForMedia(mediaId);
    if (chatId === null) throw validation('media not found');
    await assertMember(req.user!.id, chatId);

    const byMedia = await tagsForMediaIds([mediaId]);
    const res: MediaTagsResponse = { tags: byMedia.get(mediaId.toString()) ?? [] };
    return res;
  });

  app.post<{ Params: { id: string }; Body: AddTagRequest }>('/media/:id/tags', { preHandler: requireAuth }, async (req) => {
    const mediaId = parseId(req.params.id);
    const chatId = await chatIdForMedia(mediaId);
    if (chatId === null) throw validation('media not found');
    await assertMember(req.user!.id, chatId);

    if (typeof req.body?.name !== 'string' || !req.body.name.trim()) throw validation('name required');
    const tag = await addTag(chatId, mediaId, req.user!.id, req.body.name);

    app.io?.to(chatRoom(chatId)).emit('ws', makeEnvelope(WsType.TagAdded, { mediaId: mediaId.toString(), tag }));
    const res: Tag = tag;
    return res;
  });

  app.delete<{ Params: { id: string; tagId: string } }>('/media/:id/tags/:tagId', { preHandler: requireAuth }, async (req) => {
    const mediaId = parseId(req.params.id);
    const tagId = parseId(req.params.tagId);
    const chatId = await chatIdForMedia(mediaId);
    if (chatId === null) throw validation('media not found');
    await assertMember(req.user!.id, chatId);

    await removeTag(mediaId, tagId);

    app.io?.to(chatRoom(chatId)).emit('ws', makeEnvelope(WsType.TagRemoved, { mediaId: mediaId.toString(), tagId: tagId.toString() }));
    return { ok: true };
  });
}
