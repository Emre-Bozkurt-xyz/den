/**
 * Provider-resolver seam (docs/EMBEDS.md §4.3) — the whole point of the embed
 * framework: adding a source is one resolver function registered here, zero
 * changes to the message-mint lifecycle or the client's shared `EmbedCard`.
 * Kept a plain map, same posture as the media-kind switch (media/process.ts).
 */
import type { EmbedActionType, EmbedProvider } from '@den/shared';
import { resolveInstagram } from './instagram.js';

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
  contentKind: string | null;
  actionType: EmbedActionType;
  data?: Record<string, unknown>;
}

export type EmbedResolver = (ctx: EmbedResolveCtx) => Promise<ResolvedEmbed>;

// 'vault' has no resolver until Phase 3 (docs/EMBEDS.md §6.1) — a vault-kind
// embed message can't be created by Phase 1/2's URL-detection path anyway
// (shared/src/embeds.ts's detectEmbedUrl only recognizes Instagram today), so
// leaving it unregistered rather than stubbing it is deliberate.
const RESOLVERS: Partial<Record<EmbedProvider, EmbedResolver>> = {
  instagram: resolveInstagram,
};

export function resolverFor(provider: EmbedProvider): EmbedResolver | null {
  return RESOLVERS[provider] ?? null;
}
