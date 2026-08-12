import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MediaInfo } from '@den/shared';

/**
 * Reveal state for sensitive media (docs/MEDIA_ATTACHMENTS.md §5.4, D8).
 *
 * Which `nsfw`/`spoiler` items the viewer has tapped to un-blur, held in
 * memory for the lifetime of the app session and deliberately never
 * persisted. Three reasons that's the right scope, not a shortcut:
 *
 *  - Re-blurring on scroll-out would be hostile; revealing forever would
 *    make a photo you marked once stay exposed for good.
 *  - localStorage/IndexedDB is unreliable for exactly this on the primary
 *    platform — iOS evicts PWA origin storage after weeks (PROJECT.md §12),
 *    so persisted reveals would come back randomly re-blurred and the rule
 *    would feel arbitrary.
 *  - It's pure view state, so losing it on reload is *correct* under the
 *    "server is truth, client is a cache" invariant. Nothing here needs a
 *    table, a sync, or a migration.
 *
 * One provider serves chat, the album mosaic, the stack grid sheet, the
 * full-screen viewer and the gallery, so revealing a photo in the chat means
 * it's already revealed when you open the gallery, and vice versa. That
 * shared set is the whole point — a second, screen-local reveal concept
 * would let the same photo be both revealed and hidden at once.
 */

interface SensitivityState {
  isRevealed: (mediaId: string) => boolean;
  /** Reveal one item or a whole album at once (docs §5.4: revealing any
   *  blurred tile of an album reveals all of them — they were composed and
   *  marked together, so one-by-one is the tedium this feature removes). */
  reveal: (mediaIds: string | readonly string[]) => void;
  /** "Hide again" — drops items back out of the revealed set. */
  hide: (mediaIds: string | readonly string[]) => void;
  /** docs §5.5 — the gallery's "Show all" is a session-scoped override, not
   *  a bulk write of every loaded id: tiles arriving from later pagination
   *  must come in revealed too, instead of the button needing a re-press on
   *  every scroll. Same app-session lifetime as `revealed`. */
  galleryShowAll: boolean;
  setGalleryShowAll: (value: boolean) => void;
}

const SensitivityContext = createContext<SensitivityState | null>(null);

function toArray(ids: string | readonly string[]): readonly string[] {
  return typeof ids === 'string' ? [ids] : ids;
}

export function SensitivityProvider({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [galleryShowAll, setGalleryShowAll] = useState(false);

  const isRevealed = useCallback((mediaId: string) => revealed.has(mediaId), [revealed]);

  const reveal = useCallback((mediaIds: string | readonly string[]) => {
    setRevealed((prev) => {
      const ids = toArray(mediaIds);
      if (ids.every((id) => prev.has(id))) return prev; // no-op → no re-render
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const hide = useCallback((mediaIds: string | readonly string[]) => {
    setRevealed((prev) => {
      const ids = toArray(mediaIds);
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<SensitivityState>(
    () => ({ isRevealed, reveal, hide, galleryShowAll, setGalleryShowAll }),
    [isRevealed, reveal, hide, galleryShowAll],
  );

  return <SensitivityContext.Provider value={value}>{children}</SensitivityContext.Provider>;
}

export function useSensitivity(): SensitivityState {
  const ctx = useContext(SensitivityContext);
  if (!ctx) throw new Error('useSensitivity must be used inside <SensitivityProvider>');
  return ctx;
}

/**
 * Should this item render blurred right now?
 *
 * The single decision point for every surface — no component may re-derive
 * blur from tag names (that's what `MediaInfo.sensitivity` is for) or invent
 * its own reveal bookkeeping.
 *
 * `galleryOverride` is passed only by gallery surfaces: it's true when the
 * user's `galleryShowSensitive` setting is on, or when they've pressed "Show
 * all" this session. Chat never passes it — the split is deliberate (docs
 * §5.5): the gallery is a place you navigated to on purpose, chat is a
 * surface you scroll past in public.
 *
 * Note there is no "it's mine" exemption (D9): the sender sees their own
 * sent nsfw/spoiler media blurred too, because the threat is someone
 * glancing at your screen, and the sender already knows what it is.
 */
export function useIsBlurred(media: Pick<MediaInfo, 'id' | 'sensitivity'>, galleryOverride = false): boolean {
  const { isRevealed } = useSensitivity();
  if (media.sensitivity === null) return false;
  if (galleryOverride) return false;
  return !isRevealed(media.id);
}

/** Every id in an album that is currently blurred — what a tile's tap hands
 *  to `reveal()` so one tap clears the whole album (docs §5.4). */
export function blurredIdsOf(
  items: readonly Pick<MediaInfo, 'id' | 'sensitivity'>[],
  isRevealed: (id: string) => boolean,
): string[] {
  return items.filter((m) => m.sensitivity !== null && !isRevealed(m.id)).map((m) => m.id);
}
