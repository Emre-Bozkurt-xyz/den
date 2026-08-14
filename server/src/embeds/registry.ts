/**
 * Provider-resolver seam (docs/EMBEDS.md §4.3) — the whole point of the embed
 * framework: adding a source is one resolver function registered here, zero
 * changes to the message-mint lifecycle or the client's shared `EmbedCard`.
 * Kept a plain map, same posture as the media-kind switch (media/process.ts).
 */
import type { EmbedActionType, EmbedProvider } from '@den/shared';
import { resolveInstagram } from './instagram.js';
import { resolveVault } from './vault.js';
import { resolveKlipy } from './klipy.js';

/** What a resolver is handed — enough to fetch/verify without re-querying
 *  the DB for context it already has (mirrors media/process.ts's ProcessArgs). */
export interface EmbedResolveCtx {
  chatId: bigint;
  embedId: bigint;
  /** The canonical URL recorded at message-mint time (docs/EMBEDS.md §4.3). */
  url: string;
  providerRef: string;
}

/** What a resolver hands back — written verbatim onto the `embeds` row by
 *  `finalizeEmbed` (embeds/service.ts) on success. */
export interface ResolvedEmbed {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  /** R2 key of the re-encoded snapshot image, or null if there's nothing to
   *  show (still a valid 'ready' card — see the doc's link-fallback note). */
  thumbKey: string | null;
  /** Overrides the mint-time URL only if the resolver normalized it further;
   *  most resolvers just echo `ctx.url` back. */
  canonicalUrl: string | null;
  /** Same idea for the provider's own id, for the case where the value minted
   *  from client input isn't the canonical one. Klipy needs this: search
   *  results append a per-response analytics suffix to the slug, and only the
   *  by-slug lookup reports the durable form (docs/GIFS.md §12). Omit to keep
   *  what was stored at mint time, which is what every other resolver does. */
  providerRef?: string;
  contentKind: string | null;
  actionType: EmbedActionType;
  data?: Record<string, unknown>;
}

export type EmbedResolver = (ctx: EmbedResolveCtx) => Promise<ResolvedEmbed>;

// Phase 3 (docs/EMBEDS.md §6.1): 'vault' resolves a shared doc URL into a
// read-only card, authenticated with the SHARER's own linked token
// (embeds/vault.ts). shared/src/embeds.ts's detectEmbedUrl recognizes both
// providers as of this phase.
const RESOLVERS: Partial<Record<EmbedProvider, EmbedResolver>> = {
  instagram: resolveInstagram,
  vault: resolveVault,
  // docs/GIFS.md §7 — unlike the two above, this provider is never reached by
  // URL detection: `ctx.url` is null and `ctx.providerRef` (the Klipy slug)
  // carries everything, because the client picks a GIF rather than pasting a
  // link.
  klipy: resolveKlipy,
};

export function resolverFor(provider: EmbedProvider): EmbedResolver | null {
  return RESOLVERS[provider] ?? null;
}
