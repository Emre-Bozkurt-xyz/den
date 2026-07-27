/**
 * Stage business logic (docs/EMBEDS.md §6.2, Phase 4) — the DB + Vault-call
 * side of the chat Stage, called by the thin routes in
 * server/src/routes/stage.ts. Every function here assumes the caller has
 * already run `assertMember` (CLAUDE.md hard invariant 1); nothing in this
 * file re-checks chat membership itself.
 *
 * Enrichment posture (docs/EMBEDS.md §6.1's "never a broken half-render",
 * extended to the list view): a Vault outage or a single doc's metadata
 * 404 degrades that row to its cached `title` + null fields, never fails
 * the whole `GET /stage` response.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type {
  AddStageDocRequest,
  AddStageDocResponse,
  PortalSessionResponse,
  RenderedDocResponse,
  StageDoc,
  StageResponse,
  VaultPickerDoc,
} from '@den/shared';
import { db } from '../db/index.js';
import { chatVaultDocs } from '../db/schema.js';
import { env } from '../env.js';
import { forbidden, notFound } from '../errors.js';
import {
  VaultNotFoundError,
  cloneVaultDocumentIntoGroup,
  createVaultEditorSession,
  createVaultGroupDocument,
  fetchVaultDocMetadata,
  fetchVaultDocRendered,
  listVaultDocuments,
} from '../integrations/vaultClient.js';
import { getValidVaultAccessToken, vaultStatus } from '../integrations/vaultLinks.js';
import { ensureChatGroupMembership } from './vaultGroups.js';

type ChatVaultDocRow = typeof chatVaultDocs.$inferSelect;

/** Converts a Vault "can't access" 404 into Den's own not-found error —
 *  every Stage route that reaches into Vault for a SPECIFIC doc (portal,
 *  rendered, clone) wants this same translation. */
function mapVaultErrors<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err) => {
    if (err instanceof VaultNotFoundError) throw notFound('Vault document not found or not accessible');
    throw err;
  });
}

/** Enriches one `chat_vault_docs` row with live Vault metadata. Uses the
 *  viewer's own token when they're linked (so `canEdit` reflects THEIR
 *  access); otherwise falls back to the service principal (which
 *  administers every chat group and can therefore always read the doc) so
 *  an unlinked viewer still sees a real title/snippet — just `canEdit:
 *  false`, since reading via the service principal says nothing about this
 *  particular viewer's own edit rights (docs/EMBEDS.md §6.3: "unlinked
 *  members still read... editing does" need a link). */
async function enrichStageDoc(row: ChatVaultDocRow, viewerToken: string | null): Promise<StageDoc> {
  const bearer = viewerToken ?? (env.vaultServiceToken || null);

  let title = row.title ?? row.vaultDocumentId;
  let ownerName: string | null = null;
  let snippet: string | null = null;
  let updatedAt: string | null = null;
  let canEdit = false;

  if (bearer) {
    try {
      const meta = await fetchVaultDocMetadata(bearer, row.vaultDocumentId);
      title = meta.title;
      ownerName = meta.ownerName;
      snippet = meta.snippet;
      updatedAt = meta.updatedAt;
      canEdit = viewerToken !== null && meta.canEdit;
      if (meta.title !== row.title) {
        await db.update(chatVaultDocs).set({ title: meta.title }).where(eq(chatVaultDocs.id, row.id));
      }
    } catch (err) {
      // Resilient enrichment (docs/EMBEDS.md build spec): log, keep the
      // cached/default fields, don't fail the row or the list.
      console.error(
        `stage: metadata enrich failed for chatVaultDoc ${row.id} (vault doc ${row.vaultDocumentId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    id: row.id.toString(),
    vaultDocumentId: row.vaultDocumentId,
    title,
    ownerName,
    snippet,
    updatedAt,
    canEdit,
    addedBy: row.addedBy?.toString() ?? null,
    addedAt: row.createdAt.toISOString(),
  };
}

/** GET /chats/:id/stage */
export async function getStage(chatId: bigint, viewerId: bigint): Promise<StageResponse> {
  const status = await vaultStatus(viewerId);
  const viewerLinked = status.linked;
  const writable = Boolean(env.vaultServiceToken);

  const rows = await db
    .select()
    .from(chatVaultDocs)
    .where(and(eq(chatVaultDocs.chatId, chatId), isNull(chatVaultDocs.deletedAt)));

  const viewerToken = viewerLinked ? await getValidVaultAccessToken(viewerId) : null;
  const docs = await Promise.all(rows.map((row) => enrichStageDoc(row, viewerToken)));

  // Most-recently-updated first; docs Vault couldn't be reached for (null
  // updatedAt) fall back to add order, sorted after ones we DO have a date
  // for (docs/EMBEDS.md §6.2.1's ordering rule + StageDoc's updatedAt doc
  // comment).
  docs.sort((a, b) => {
    if (a.updatedAt && b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    if (a.updatedAt && !b.updatedAt) return -1;
    if (!a.updatedAt && b.updatedAt) return 1;
    return b.addedAt.localeCompare(a.addedAt);
  });

  return { docs, viewerLinked, writable };
}

/** POST /chats/:id/stage/docs — create-blank or clone, one route. Runs the
 *  §7.1 item 1 membership precondition first (its errors are allowed to
 *  propagate, unlike the background trigger callers of the same function),
 *  then requires the viewer's own Vault link: both branches need it in
 *  practice — clone reads the source doc with it, and create-then-open
 *  mints the portal session with it immediately after (docs/EMBEDS.md
 *  §6.2.1: "only available to linked users", "you made it to write in
 *  it"). */
export async function addStageDoc(chatId: bigint, userId: bigint, body: AddStageDocRequest): Promise<AddStageDocResponse> {
  const groupId = await ensureChatGroupMembership(chatId, userId);

  const viewerToken = await getValidVaultAccessToken(userId);
  if (!viewerToken) throw forbidden('Link your Vault account to add a Stage document');

  const sourceDocumentId = typeof body.sourceDocumentId === 'string' && body.sourceDocumentId ? body.sourceDocumentId : undefined;
  const requestedTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;

  let vaultDocumentId: string;
  let portalUrl: string | null = null;
  let cachedTitle: string | null = null;

  if (sourceDocumentId) {
    // sourceDocumentId wins if both are present (shared/src/vault.ts) — an
    // optional title just renames the clone, it doesn't switch branches.
    vaultDocumentId = await mapVaultErrors(
      cloneVaultDocumentIntoGroup({ actingUserToken: viewerToken, sourceDocumentId, groupId, title: requestedTitle }),
    );
    // portalUrl stays null — the clone already has content, no reason to
    // force an editor open (docs/EMBEDS.md §6.2.1).
  } else {
    const createTitle = requestedTitle ?? 'Untitled';
    vaultDocumentId = await mapVaultErrors(createVaultGroupDocument(createTitle, groupId));
    cachedTitle = createTitle;
    portalUrl = await mapVaultErrors(createVaultEditorSession(viewerToken, vaultDocumentId));
  }

  const rows = await db
    .insert(chatVaultDocs)
    .values({ chatId, vaultDocumentId, title: cachedTitle, addedBy: userId })
    .onConflictDoUpdate({
      target: [chatVaultDocs.chatId, chatVaultDocs.vaultDocumentId],
      // Revives a previously-removed row (unique on chatId+vaultDocumentId)
      // instead of silently no-op'ing on a soft-deleted duplicate — re-add
      // is idempotent from the client's point of view.
      set: { deletedAt: null, title: cachedTitle, addedBy: userId },
    })
    .returning();
  const row = rows[0]!;

  const doc = await enrichStageDoc(row, viewerToken);
  return { doc, portalUrl };
}

async function stageDocRow(chatId: bigint, docId: bigint): Promise<ChatVaultDocRow | null> {
  const rows = await db
    .select()
    .from(chatVaultDocs)
    .where(and(eq(chatVaultDocs.id, docId), eq(chatVaultDocs.chatId, chatId), isNull(chatVaultDocs.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** DELETE /chats/:id/stage/docs/:docId — shared-wiki removal (docs/EMBEDS.md
 *  §6.2: matches the tag model, ANY member may remove, `addedBy` is
 *  attribution only). Soft-delete only, and NEVER touches Vault — the
 *  group keeps owning the document. Idempotent: removing an already-removed
 *  or nonexistent row is a silent no-op, matching the rest of the API's
 *  soft-delete posture (e.g. markRead on a stale id). */
export async function removeStageDoc(chatId: bigint, docId: bigint): Promise<void> {
  await db
    .update(chatVaultDocs)
    .set({ deletedAt: new Date() })
    .where(and(eq(chatVaultDocs.id, docId), eq(chatVaultDocs.chatId, chatId), isNull(chatVaultDocs.deletedAt)));
}

/** POST /chats/:id/stage/docs/:docId/portal — a fresh single-use editor
 *  session every time (never cached/reused, docs/EMBEDS.md §6.4/§7 Contract
 *  C: an iframe refresh must fail closed). */
export async function mintPortalSession(chatId: bigint, docId: bigint, userId: bigint): Promise<PortalSessionResponse> {
  const row = await stageDocRow(chatId, docId);
  if (!row) throw notFound('Stage document not found');

  const token = await getValidVaultAccessToken(userId);
  if (!token) throw forbidden('Link your Vault account to open the editor');

  const portalUrl = await mapVaultErrors(createVaultEditorSession(token, row.vaultDocumentId));
  return { portalUrl };
}

/** GET /chats/:id/stage/documents?query= — the clone picker (docs/EMBEDS.md
 *  §7 Contract B2), read with the VIEWER's own token. An unlinked viewer
 *  gets an empty list, not an error — listing needs their OAuth token and
 *  there's nothing wrong with not having one yet (§6.2.1: "an unlinked
 *  member sees a Connect Vault prompt in place of it"). */
export async function listStagePickerDocs(userId: bigint, query: string | null, limit: number): Promise<VaultPickerDoc[]> {
  const token = await getValidVaultAccessToken(userId);
  if (!token) return [];

  const items = await listVaultDocuments(token, { query: query ?? undefined, limit });
  return items.map((d) => ({
    id: d.id,
    title: d.title,
    folderPath: d.folderPath,
    updatedAt: d.updatedAt,
    snippet: d.snippet,
  }));
}

/** GET /chats/:id/stage/rendered/:vaultDocumentId — the server-relayed read
 *  view (docs/EMBEDS.md §6.1/§6.2.1); the client never calls Vault directly
 *  and never sees a token. Not restricted to docs actually pinned to this
 *  chat's Stage — a Phase-3 transient embed card's "tap to read" reuses this
 *  same relay (assertMember on the chat is the only gate that matters; the
 *  vaultDocumentId itself is whatever the card/tile is pointing at). Falls
 *  back to the service principal for an unlinked viewer, same reasoning as
 *  `enrichStageDoc`. */
export async function getRenderedDoc(vaultDocumentId: string, userId: bigint): Promise<RenderedDocResponse> {
  const viewerToken = await getValidVaultAccessToken(userId);
  const bearer = viewerToken ?? (env.vaultServiceToken || null);
  if (!bearer) throw forbidden('Link your Vault account to view this document');

  const [rendered, meta] = await Promise.all([
    mapVaultErrors(fetchVaultDocRendered(bearer, vaultDocumentId)),
    fetchVaultDocMetadata(bearer, vaultDocumentId).catch(() => null),
  ]);

  return { html: rendered.html, title: meta?.title ?? '', updatedAt: meta?.updatedAt ?? null };
}
