/**
 * The chat Stage REST surface (docs/EMBEDS.md §6.2/§6.4, Phase 4). Every
 * route asserts chat membership first (CLAUDE.md hard invariant 1) — Vault
 * group membership is a mirror, never the primary check on these routes
 * (docs/EMBEDS.md §2). All DB/Vault work lives in embeds/stage.ts; these
 * handlers just parse/validate the HTTP edges.
 */
import type { FastifyInstance } from 'fastify';
import {
  StageLimits,
  type AddStageDocRequest,
  type AddStageDocResponse,
  type PortalSessionResponse,
  type RenderedDocResponse,
  type StageResponse,
  type VaultPickerDoc,
} from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import { validation } from '../errors.js';
import { addStageDoc, getRenderedDoc, getStage, listStagePickerDocs, mintPortalSession, removeStageDoc } from '../embeds/stage.js';

function parseId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid id');
  }
}

function clampPickerLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : StageLimits.pickerLimit;
  if (!Number.isFinite(n) || n <= 0) return StageLimits.pickerLimit;
  return Math.min(Math.floor(n), StageLimits.pickerLimit);
}

function clampPickerQuery(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.slice(0, StageLimits.maxPickerQueryLength);
}

export async function stageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/chats/:id/stage', { preHandler: requireAuth }, async (req) => {
    const chatId = parseId(req.params.id);
    await assertMember(req.user!.id, chatId);
    const res: StageResponse = await getStage(chatId, req.user!.id);
    return res;
  });

  app.post<{ Params: { id: string }; Body: AddStageDocRequest }>(
    '/chats/:id/stage/docs',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);

      const body = req.body ?? {};
      const title = typeof body.title === 'string' ? body.title.trim() : undefined;
      const sourceDocumentId = typeof body.sourceDocumentId === 'string' ? body.sourceDocumentId.trim() : undefined;
      if (!title && !sourceDocumentId) throw validation('title or sourceDocumentId is required');
      if (title && title.length > StageLimits.maxTitleLength) {
        throw validation(`title too long (max ${StageLimits.maxTitleLength} characters)`);
      }

      const res: AddStageDocResponse = await addStageDoc(chatId, req.user!.id, { title, sourceDocumentId });
      return res;
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    '/chats/:id/stage/docs/:docId',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const docId = parseId(req.params.docId);
      await removeStageDoc(chatId, docId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; docId: string } }>(
    '/chats/:id/stage/docs/:docId/portal',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const docId = parseId(req.params.docId);
      const res: PortalSessionResponse = await mintPortalSession(chatId, docId, req.user!.id);
      return res;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { query?: string; limit?: string } }>(
    '/chats/:id/stage/documents',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const query = clampPickerQuery(req.query.query);
      const limit = clampPickerLimit(req.query.limit);
      const docs: VaultPickerDoc[] = await listStagePickerDocs(req.user!.id, query, limit);
      return docs;
    },
  );

  app.get<{ Params: { id: string; vaultDocumentId: string } }>(
    '/chats/:id/stage/rendered/:vaultDocumentId',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const res: RenderedDocResponse = await getRenderedDoc(req.params.vaultDocumentId, req.user!.id);
      return res;
    },
  );
}
