/**
 * Tests for GIF favorites (docs/GIF_FAVORITES.md §11), against the real dev
 * Postgres — same throwaway-row posture as `embeds/vaultGroups.test.ts`.
 *
 * **What is deliberately NOT tested here: `addFavorite`'s Klipy leg.** That
 * function's first act is a live `gifBySlug` call, and the development key
 * allows 100 requests per hour across the entire app (docs/GIFS.md §10). A
 * unit test that spent quota on every `npm test` would make the picker fail
 * for whoever ran the suite last, which is a worse outcome than the coverage
 * is worth. Canonicalization and the idempotent double-add are verified in the
 * scripted end-to-end pass instead, where the call happens once on purpose.
 *
 * What IS covered here is everything that can go wrong without the network,
 * and in particular the one security-relevant property: **a favorite is
 * private to the user who wrote it.** Nothing in this feature is chat-scoped
 * (see the module header for why invariant 1 has nothing to guard), so
 * per-user isolation is the whole access-control story and gets tested
 * directly rather than assumed from the `where` clauses.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { GifLimits } from '@den/shared';
import { db, closeDb } from '../db/index.js';
import { gifFavorites, users } from '../db/schema.js';
import { favoriteKeys, listFavorites, removeFavorite } from './favorites.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let ownerId: bigint;
let strangerId: bigint;

async function insertUser(suffix: string): Promise<bigint> {
  const username = `gif-fav-test-${suffix}-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  return rows[0]!.id;
}

/** Inserts a favorite directly, bypassing `addFavorite` so no Klipy call is
 *  made. The row shape is exactly what the resolver would have written. */
async function seed(userId: bigint, slug: string, itemId: string | null): Promise<void> {
  await db.insert(gifFavorites).values({
    userId,
    provider: 'klipy',
    providerRef: slug,
    providerItemId: itemId,
    previewUrl: `https://cdn.klipy.com/${slug}.webp`,
    width: 220,
    height: 160,
    title: slug,
  });
}

before(async () => {
  ownerId = await insertUser('owner');
  strangerId = await insertUser('stranger');
});

after(async () => {
  await db.delete(gifFavorites).where(inArray(gifFavorites.userId, [ownerId, strangerId]));
  await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
  await closeDb();
});

describe('gif favorites: privacy', () => {
  test("one user's favorites are invisible to another", async () => {
    await seed(ownerId, `mine-${RUN_ID}`, '111');
    await seed(strangerId, `theirs-${RUN_ID}`, '222');

    const mine = await listFavorites(ownerId);
    const theirs = await listFavorites(strangerId);

    assert.deepEqual(mine.items.map((i) => i.slug), [`mine-${RUN_ID}`]);
    assert.deepEqual(theirs.items.map((i) => i.slug), [`theirs-${RUN_ID}`]);

    // Same for the keys route, which is what drives every star in the UI —
    // a leak here would show one person's saved GIFs as starred for another.
    const mineKeys = await favoriteKeys(ownerId);
    assert.deepEqual(mineKeys.map((k) => k.slug), [`mine-${RUN_ID}`]);
  });

  test("removing another user's slug removes nothing", async () => {
    // The delete is keyed on (user, slug). Passing a slug you don't own must
    // be a silent no-op, never a cross-user delete.
    await removeFavorite(strangerId, `mine-${RUN_ID}`);

    const stillMine = await listFavorites(ownerId);
    assert.equal(stillMine.items.length, 1, "the owner's favorite must survive");
  });
});

describe('gif favorites: keys', () => {
  test('carries both handles, and tolerates a missing item id', async () => {
    await db.delete(gifFavorites).where(eq(gifFavorites.userId, ownerId));
    await seed(ownerId, `with-id-${RUN_ID}`, '999');
    // docs/GIF_FAVORITES.md §2's floor: a provider that stopped reporting ids
    // must still produce a usable favorite — it just can't pre-fill a star.
    await seed(ownerId, `no-id-${RUN_ID}`, null);

    const keys = await favoriteKeys(ownerId);
    const withId = keys.find((k) => k.slug === `with-id-${RUN_ID}`);
    const noId = keys.find((k) => k.slug === `no-id-${RUN_ID}`);

    assert.equal(withId?.itemId, '999');
    assert.equal(noId?.itemId, null, 'a null id must round-trip, not throw or vanish');
    assert.equal(keys.length, 2);
  });
});

describe('gif favorites: hard delete (D-F2)', () => {
  test('unfavoriting removes the row outright, and re-adding is a fresh insert', async () => {
    await db.delete(gifFavorites).where(eq(gifFavorites.userId, ownerId));
    const slug = `toggle-${RUN_ID}`;
    await seed(ownerId, slug, '555');

    await removeFavorite(ownerId, slug);

    // The point of D-F2: no tombstone. A soft delete here would make
    // re-favoriting an un-delete rather than an insert.
    const rows = await db.select({ id: gifFavorites.id }).from(gifFavorites).where(eq(gifFavorites.userId, ownerId));
    assert.equal(rows.length, 0, 'the row must be gone, not flagged');

    await seed(ownerId, slug, '555');
    const after = await listFavorites(ownerId);
    assert.equal(after.items.length, 1);
  });

  test('unfavoriting something already gone is silent', async () => {
    // The desired end state is "not favorited", which is already true.
    await removeFavorite(ownerId, `never-existed-${RUN_ID}`);
  });

  test('a malformed slug is rejected rather than run as a query', async () => {
    await assert.rejects(() => removeFavorite(ownerId, '../../etc/passwd'), /invalid gif slug/);
  });
});

describe('gif favorites: keyset pagination', () => {
  test('walks the whole list newest-first, with no repeats and no gaps', async () => {
    await db.delete(gifFavorites).where(eq(gifFavorites.userId, ownerId));

    const total = GifLimits.favoritesPerPage + 5;
    for (let i = 0; i < total; i++) await seed(ownerId, `page-${i}-${RUN_ID}`, String(i));

    const first = await listFavorites(ownerId);
    assert.equal(first.items.length, GifLimits.favoritesPerPage);
    assert.ok(first.nextCursor, 'a full page must offer a cursor');

    const second = await listFavorites(ownerId, BigInt(first.nextCursor!));
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null, 'the last page must end the walk');

    const seen = [...first.items, ...second.items].map((i) => i.slug);
    assert.equal(new Set(seen).size, total, 'no repeats and no gaps across pages');

    // Newest first: the last-seeded row leads.
    assert.equal(first.items[0]!.slug, `page-${total - 1}-${RUN_ID}`);
  });
});
