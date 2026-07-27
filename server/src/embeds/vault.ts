/**
 * Vault embed resolver (docs/EMBEDS.md §6.1, Phase 3) — turns a Vault doc URL
 * dropped into a chat into a read-only card. Unlike the Instagram resolver,
 * this never fetches raw bytes off the open internet: the "hostile input" is
 * already narrowed to a syntactically valid Vault doc id by
 * shared/src/embeds.ts's `detectEmbedUrl`, and everything else is one
 * server-to-server call authenticated by the SHARER's own linked token.
 *
 * "Sharer" here is the sender of the message the embed is attached to, not
 * the viewer rendering the card — `EmbedResolveCtx` doesn't carry a userId,
 * so this looks the sender up itself via the embed's owning message. That
 * keeps the shared `EmbedResolver` seam (registry.ts) untouched for every
 * other provider.
 *
 * `VaultNotFoundError` (sharer can't read the doc — private, deleted, or
 * their link is broken) is exactly the "resolver failure" case: it's just
 * thrown through, same as any other error here, so finalizeEmbed (embeds/
 * service.ts) flips the row to `status='failed'` and the client falls back
 * to a plain link (docs/EMBEDS.md §6.1: "never a broken half-render").
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { embeds, messages } from '../db/schema.js';
import { fetchVaultDocMetadata } from '../integrations/vaultClient.js';
import { getValidVaultAccessToken } from '../integrations/vaultLinks.js';
import type { EmbedResolveCtx, EmbedResolver, ResolvedEmbed } from './registry.js';

async function senderIdForEmbed(embedId: bigint): Promise<bigint> {
  const rows = await db
    .select({ senderId: messages.senderId })
    .from(embeds)
    .innerJoin(messages, eq(messages.id, embeds.messageId))
    .where(eq(embeds.id, embedId))
    .limit(1);
  const senderId = rows[0]?.senderId;
  if (senderId === undefined) throw new Error(`embed ${embedId} has no owning message`);
  return senderId;
}

export const resolveVault: EmbedResolver = async (ctx: EmbedResolveCtx): Promise<ResolvedEmbed> => {
  const senderId = await senderIdForEmbed(ctx.embedId);

  const token = await getValidVaultAccessToken(senderId);
  if (!token) {
    // No link, or the link's refresh failed and getValidVaultAccessToken
    // already deleted the row (integrations/vaultLinks.ts) — either way the
    // sharer can't vouch for this doc right now. Same failure shape as
    // "can't read it": link fallback, not a broken card.
    throw new Error(`embed ${ctx.embedId}: sender ${senderId} has no valid Vault link`);
  }

  // Lets VaultNotFoundError (and any other error) propagate as-is —
  // finalizeEmbed's catch-all already turns any thrown error into
  // status='failed' + a logged message; there's nothing provider-specific
  // to add here since Vault's metadata 404 already means exactly "resolver
  // failure" for this provider.
  const meta = await fetchVaultDocMetadata(token, ctx.providerRef);

  return {
    title: meta.title,
    // The card's "author handle / doc owner" slot (embeds.subtitle) — for a
    // group-owned doc Vault reports the GROUP name here, never the service
    // principal (docs/EMBEDS.md §7.1 item 3); that's Vault's own contract,
    // nothing to special-case on this side.
    subtitle: meta.ownerName,
    description: meta.snippet,
    // No R2 snapshot for Vault docs (unlike Instagram's og:image) — the card
    // is text-first, and the "paper thumbnail" treatment (docs/EMBEDS.md
    // §6.2.1) is a Phase-4 Stage-grid concern built off the on-demand
    // `/rendered` relay, not something this resolver caches.
    thumbKey: null,
    canonicalUrl: ctx.url,
    contentKind: 'document',
    actionType: 'read',
    data: undefined,
  };
};
