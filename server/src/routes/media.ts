/**
 * Media upload/download routes (BACKBONE §6/§7). Every route asserts chat
 * membership (CLAUDE.md hard invariant 1) before touching anything. Media
 * bytes never transit this server (hard invariant 2) — these routes only
 * mint presigned URLs and record/verify metadata.
 */
import type { FastifyInstance } from 'fastify';
import { makeEnvelope, WsType, type AddTagRequest, type CompleteUploadRequest, type CreateUploadRequest, type CreateUploadResponse, type MediaUrlResponse, type Tag } from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import { validation } from '../errors.js';
import { notifyChatMembers } from '../push/notify.js';
import { chatRoom } from '../realtime/rooms.js';
import { chatIdForMedia, completeUpload, createUpload, finalizeProcessing, getMediaUrls } from '../media/service.js';
import { addTag, removeTag } from '../media/tags.js';

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
    if (!MEDIA_KINDS.has(body.kind)) throw validation('kind must be image, video, or voice');
    if (typeof body.mime !== 'string' || !body.mime) throw validation('mime required');
    if (typeof body.sizeBytes !== 'number') throw validation('sizeBytes required');

    const chatId = parseId(body.chatId);
    await assertMember(req.user!.id, chatId);

    const { mediaId, presignedPutUrl } = await createUpload(chatId, req.user!.id, body.kind, body.mime, body.sizeBytes);

    const res: CreateUploadResponse = {
      mediaId: mediaId.toString(),
      presignedPutUrl,
      requiredContentType: body.mime,
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

      const result = await completeUpload(mediaId, req.user!.id, req.body?.body);

      // Placeholder fanout now (§7 step 4) — receivers see "processing", not silence.
      if (app.io) {
        app.io.to(chatRoom(result.chatId)).emit('ws', makeEnvelope(WsType.MessageNew, { message: result.message }));
        void notifyChatMembers(app.io, result.chatId, result.message);
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
