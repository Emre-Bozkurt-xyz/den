/**
 * Gallery + tag-autocomplete routes (Stage 4/5, BACKBONE §6/§9). Every
 * chat-scoped route asserts membership (CLAUDE.md hard invariant 1).
 */
import type { FastifyInstance } from 'fastify';
import {
  GALLERY_KIND_FILTERS,
  GalleryLimits,
  type GalleryAlbumsResponse,
  type GalleryKindFilter,
  type GalleryResponse,
  type TagsAutocompleteResponse,
} from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import { validation } from '../errors.js';
import { getAlbumsForUser, getGalleryPage } from '../media/gallery.js';
import { autocompleteTags } from '../media/tags.js';

const GALLERY_KINDS = new Set<string>(GALLERY_KIND_FILTERS);

function parseId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid id');
  }
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : GalleryLimits.pageDefault;
  if (!Number.isFinite(n) || n <= 0) return GalleryLimits.pageDefault;
  return Math.min(n, GalleryLimits.pageMax);
}

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/gallery/albums', { preHandler: requireAuth }, async (req) => {
    const res: GalleryAlbumsResponse = { albums: await getAlbumsForUser(req.user!.id) };
    return res;
  });

  app.get<{ Params: { id: string }; Querystring: { kind?: string; q?: string; before?: string; limit?: string } }>(
    '/chats/:id/gallery',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);

      const kindRaw = req.query.kind;
      if (kindRaw && !GALLERY_KINDS.has(kindRaw)) throw validation('kind must be image, video, voice, or visual');
      const kind = (kindRaw as GalleryKindFilter | undefined) ?? null;

      const before = req.query.before ? parseId(req.query.before) : null;
      const limit = clampLimit(req.query.limit);

      const res: GalleryResponse = await getGalleryPage(chatId, kind, req.query.q ?? null, before, limit);
      return res;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { prefix?: string } }>(
    '/chats/:id/tags',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const res: TagsAutocompleteResponse = { tags: await autocompleteTags(chatId, (req.query.prefix ?? '').toLowerCase()) };
      return res;
    },
  );
}
