import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GifLimits,
  type GifFavorite,
  type GifFavoriteKeysResponse,
  type GifFavoritesResponse,
  type Message,
} from '@den/shared';
import { addGifFavorite, fetchGifFavoriteKeys, fetchGifFavorites, removeGifFavorite } from '../lib/gifs';

/**
 * GIF favorites (docs/GIF_FAVORITES.md §8) — the shared state behind all three
 * surfaces: the star on a chat GIF, the star in the picker's long-press
 * popover, and the Favorites tab itself.
 *
 * `useGifFavoriteKeys` is the one that matters architecturally. Every surface
 * asks the same question — *is this GIF starred?* — but holds a different
 * handle for it:
 *
 *  - a **picker tile** has a rotating, suffixed slug and a stable `itemId`;
 *  - a **chat card** has the canonical slug (`embed.providerRef`);
 *  - the **Favorites tab** has both.
 *
 * One small unpaginated list answers all three, so a star never depends on how
 * far a list has been scrolled, and it costs zero extra Klipy calls (the keys
 * come from Den's own table). It is also what lets `DELETE` take a single key:
 * the picker looks up `itemId → canonical slug` here before unfavoriting.
 */

const KEYS_QUERY_KEY = ['gifFavoriteKeys'] as const;
const LIST_QUERY_KEY = ['gifFavorites'] as const;

export interface GifFavoriteLookup {
  /** Starred, by the stable provider id (picker tiles). A null `itemId` is
   *  always "not starred" — docs/GIF_FAVORITES.md §2's floor, where a missing
   *  id costs an unfilled star rather than a wrong one. */
  hasItem: (itemId: string | null) => boolean;
  /** Starred, by canonical slug (chat cards, favorites tiles). */
  hasSlug: (slug: string | null) => boolean;
  /** Canonical slug for a picker tile, so it can be unfavorited. Null when the
   *  item isn't favorited — which is exactly when there's nothing to remove. */
  canonicalSlugFor: (itemId: string | null) => string | null;
}

/** `enabled` is false when GIFs aren't configured server-side (`gifsEnabled`),
 *  so a deployment without a Klipy key doesn't 503 on every mount. */
export function useGifFavoriteKeys(enabled: boolean) {
  const query = useQuery<GifFavoriteKeysResponse>({
    queryKey: KEYS_QUERY_KEY,
    queryFn: fetchGifFavoriteKeys,
    enabled,
    // Favorites only change through this app's own mutations, which invalidate
    // below — so there's nothing for a window-focus refetch to discover.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });

  const lookup = useMemo<GifFavoriteLookup>(() => {
    const keys = query.data?.keys ?? [];
    const byItem = new Map<string, string>();
    const slugs = new Set<string>();
    for (const k of keys) {
      slugs.add(k.slug);
      if (k.itemId) byItem.set(k.itemId, k.slug);
    }
    return {
      hasItem: (itemId) => (itemId ? byItem.has(itemId) : false),
      hasSlug: (slug) => (slug ? slugs.has(slug) : false),
      canonicalSlugFor: (itemId) => (itemId ? (byItem.get(itemId) ?? null) : null),
    };
  }, [query.data]);

  return { lookup, isLoading: query.isLoading };
}

/** The Favorites tab's list. Keyset-paginated, newest first. */
export function useGifFavoritesList(enabled: boolean) {
  return useInfiniteQuery<GifFavoritesResponse, Error, { pages: GifFavoritesResponse[] }, typeof LIST_QUERY_KEY, string | null>({
    queryKey: LIST_QUERY_KEY,
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchGifFavorites(pageParam),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchOnWindowFocus: false,
  });
}

/**
 * Star / unstar. Both mutations invalidate the keys list *and* the favorites
 * list, so all three surfaces agree immediately — starring in chat fills the
 * star on that same GIF in the picker without a reload.
 *
 * Deliberately NOT optimistic. Adding requires a server round-trip to Klipy to
 * canonicalize the slug (D-F3), so the client genuinely does not know the row
 * it is creating; a fake one would have the wrong key and the wrong preview.
 * The action is a small, non-blocking star toggle, not a message send, so the
 * latency is cheap and correctness is worth more here.
 */
export function useGifFavoriteMutations() {
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: LIST_QUERY_KEY });
  }, [qc]);

  const add = useMutation<GifFavorite, Error, string>({
    mutationFn: (slug) => addGifFavorite(slug),
    onSuccess: invalidate,
  });

  const remove = useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (canonicalSlug) => removeGifFavorite(canonicalSlug),
    onSuccess: invalidate,
  });

  return {
    add,
    remove,
    /** True while either direction is in flight — surfaces disable their star
     *  on this so a double-tap can't queue a second add for the same GIF. */
    isBusy: add.isPending || remove.isPending,
    maxFavorites: GifLimits.maxFavorites,
  };
}

/**
 * The chat-side half (docs/GIF_FAVORITES.md §8.1), bundled into one object so
 * `ChatView` can thread a single prop down to `MessageBlockRow` instead of two.
 *
 * Deliberately built **once** at the `ChatView` level rather than by each row
 * calling the hooks itself: a chat renders many message rows, and a per-row
 * `useQuery` + `useMutation` pair would mean hundreds of observers for one
 * shared answer. The message list already passes a wide prop set down this
 * path, so one more prop is the cheaper and more consistent shape.
 */
export interface GifFavoriteApi {
  /** Null when this message has nothing to favorite — which is every message
   *  except a ready inline GIF. Callers render no star at all on null. */
  stateFor: (m: Message) => { favorited: boolean } | null;
  toggle: (m: Message) => void;
}

export function useGifFavoriteActions(enabled: boolean): GifFavoriteApi {
  const { lookup } = useGifFavoriteKeys(enabled);
  const { add, remove } = useGifFavoriteMutations();

  return useMemo<GifFavoriteApi>(
    () => ({
      stateFor(m) {
        if (!enabled) return null;
        const e = m.embed;
        if (!e || e.contentKind !== 'gif' || e.actionType !== 'inline' || !e.providerRef) return null;
        // Only a `ready` row carries the CANONICAL slug. While processing,
        // `providerRef` is still whatever the sender supplied — for a picker
        // send that's the suffixed form (docs/GIFS.md §12), which would never
        // match a stored favorite and would render a wrongly-empty star on a
        // GIF the user has in fact saved. Waiting the ~1s for `embed.ready`
        // costs nothing and keeps the star honest.
        if (e.status !== 'ready') return null;
        return { favorited: lookup.hasSlug(e.providerRef) };
      },
      toggle(m) {
        const ref = m.embed?.providerRef;
        if (!ref) return;
        if (lookup.hasSlug(ref)) remove.mutate(ref);
        else add.mutate(ref);
      },
    }),
    [enabled, lookup, add, remove],
  );
}
