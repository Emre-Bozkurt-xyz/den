/**
 * GIF favorites (docs/GIF_FAVORITES.md §7) — all DB access for one user's
 * saved GIFs.
 *
 * **Not chat-scoped, and that is worth stating rather than leaving to look
 * like an omission.** CLAUDE.md invariant 1 ("authorization = chat
 * membership") is the app's whole privacy model, so a module with no
 * `assertMember` call deserves an explanation: nothing here references a Den
 * object. A favorite is `(user, public provider id)`. It crosses no chat
 * boundary, reveals nothing about any chat, and is readable only by the user
 * who wrote it — enforced by every query below filtering on `userId`.
 *
 * **The client sends only a slug** (D-F3). Every stored field is derived here
 * from Klipy's own response, because `previewUrl` is later loaded in an
 * `<img>` and a client-chosen URL in that column would be a stored-and-served
 * third-party fetch — exactly what invariant 7 exists to prevent.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { GifLimits, type GifFavorite, type GifFavoriteKey } from '@den/shared';
import { ErrorCode } from '@den/shared';
import { db } from '../db/index.js';
import { gifFavorites } from '../db/schema.js';
import { AppError, notFound, validation } from '../errors.js';
import { gifBySlug, isValidGifSlug } from './klipy.js';

/** The only provider this table accepts today; mirrors the CHECK constraint.
 *  Kept as a named constant rather than a literal at each call site so a
 *  future second provider is a change with a compiler-visible blast radius. */
const PROVIDER = 'klipy';

interface FavoriteRow {
  slug: string;
  itemId: string | null;
  previewUrl: string;
  width: number;
  height: number;
  title: string;
}

function toFavorite(row: FavoriteRow): GifFavorite {
  return {
    slug: row.slug,
    itemId: row.itemId,
    previewUrl: row.previewUrl,
    width: row.width,
    height: row.height,
    title: row.title,
  };
}

/**
 * One page of favorites, newest first, keyset-paginated on `id` (PROJECT.md
 * §6 — no OFFSET in new code). `before` is the last id of the previous page.
 */
export async function listFavorites(
  userId: bigint,
  before?: bigint,
): Promise<{ items: GifFavorite[]; nextCursor: string | null }> {
  const limit = GifLimits.favoritesPerPage;
  const rows = await db
    .select({
      id: gifFavorites.id,
      slug: gifFavorites.providerRef,
      itemId: gifFavorites.providerItemId,
      previewUrl: gifFavorites.previewUrl,
      width: gifFavorites.width,
      height: gifFavorites.height,
      title: gifFavorites.title,
    })
    .from(gifFavorites)
    .where(
      before === undefined
        ? and(eq(gifFavorites.userId, userId), eq(gifFavorites.provider, PROVIDER))
        : and(eq(gifFavorites.userId, userId), eq(gifFavorites.provider, PROVIDER), lt(gifFavorites.id, before)),
    )
    .orderBy(desc(gifFavorites.id))
    // One extra row is the cheapest honest way to know whether another page
    // exists — a COUNT would be a second scan for a boolean.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(toFavorite),
    nextCursor: hasMore ? page[page.length - 1]!.id.toString() : null,
  };
}

/**
 * Every favorite's two handles, unpaginated — the star state for all three
 * surfaces at once (§6). Bounded by `GifLimits.maxFavorites`, which is the
 * reason that cap exists at all.
 */
export async function favoriteKeys(userId: bigint): Promise<GifFavoriteKey[]> {
  const rows = await db
    .select({ slug: gifFavorites.providerRef, itemId: gifFavorites.providerItemId })
    .from(gifFavorites)
    .where(and(eq(gifFavorites.userId, userId), eq(gifFavorites.provider, PROVIDER)))
    .orderBy(desc(gifFavorites.id))
    .limit(GifLimits.maxFavorites);
  return rows.map((r) => ({ slug: r.slug, itemId: r.itemId }));
}

async function favoriteCount(userId: bigint): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gifFavorites)
    .where(and(eq(gifFavorites.userId, userId), eq(gifFavorites.provider, PROVIDER)));
  return rows[0]?.n ?? 0;
}

/**
 * Favorite a GIF by slug — **suffixed or canonical, both work**.
 *
 * The `gifBySlug` call is the load-bearing part: it canonicalizes the slug
 * (search results carry a rotating suffix — docs/GIFS.md §12) *and* it is
 * where every stored field comes from. Storing the client's slug verbatim
 * would scatter the same GIF across several rows as its suffix rotated.
 *
 * Idempotent: a double-tap, or favoriting the same GIF from two surfaces,
 * returns the existing row rather than erroring. The unique index is what
 * makes that true under concurrency, not the read below.
 */
export async function addFavorite(userId: bigint, slug: string): Promise<GifFavorite> {
  if (!isValidGifSlug(slug)) throw validation('invalid gif slug');

  const item = await gifBySlug(slug);
  if (!item) throw notFound('GIF not found');

  // Checked before the insert rather than enforced by a constraint: the cap is
  // a product limit with a message, not a data-integrity rule. Racing past it
  // by a row or two under concurrent adds is harmless.
  const existing = await db
    .select({ id: gifFavorites.id })
    .from(gifFavorites)
    .where(
      and(
        eq(gifFavorites.userId, userId),
        eq(gifFavorites.provider, PROVIDER),
        eq(gifFavorites.providerRef, item.slug),
      ),
    )
    .limit(1);

  if (existing.length === 0 && (await favoriteCount(userId)) >= GifLimits.maxFavorites) {
    throw new AppError(
      409,
      ErrorCode.Validation,
      `You can save up to ${GifLimits.maxFavorites} GIFs. Remove one to make room.`,
    );
  }

  const row: FavoriteRow = {
    slug: item.slug,
    itemId: item.itemId,
    previewUrl: item.preview.url,
    width: item.preview.width,
    height: item.preview.height,
    title: item.title,
  };

  await db
    .insert(gifFavorites)
    .values({
      userId,
      provider: PROVIDER,
      providerRef: row.slug,
      providerItemId: row.itemId,
      previewUrl: row.previewUrl,
      width: row.width,
      height: row.height,
      title: row.title,
    })
    // Re-favoriting refreshes the snapshot rather than doing nothing: the
    // preview URL is perishable third-party state (D-F4), so a user hitting
    // the star again on a GIF whose tile has gone dead is the most natural
    // possible way to ask for it to be repaired, and this makes that work.
    .onConflictDoUpdate({
      target: [gifFavorites.userId, gifFavorites.provider, gifFavorites.providerRef],
      set: {
        providerItemId: row.itemId,
        previewUrl: row.previewUrl,
        width: row.width,
        height: row.height,
        title: row.title,
      },
    });

  return toFavorite(row);
}

/** Unfavorite by canonical slug. Hard delete — D-F2, and see the schema
 *  comment on `gifFavorites` for why that isn't an invariant-8 violation.
 *  Silent when nothing matched: unfavoriting something already gone is the
 *  desired end state, not an error. */
export async function removeFavorite(userId: bigint, slug: string): Promise<void> {
  if (!isValidGifSlug(slug)) throw validation('invalid gif slug');
  await db
    .delete(gifFavorites)
    .where(
      and(eq(gifFavorites.userId, userId), eq(gifFavorites.provider, PROVIDER), eq(gifFavorites.providerRef, slug)),
    );
}
