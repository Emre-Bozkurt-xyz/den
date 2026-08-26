import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Hand, Images, Layers, Reply as ReplyIcon, Search, Trash2, X } from 'lucide-react';
import {
  ReactionLimits,
  type ChatSummary,
  type GifSearchItem,
  type MediaInfo,
  type MeResponse,
  type Message,
  type PublicUser,
  type ReplyPreview,
} from '@den/shared';
import { flattenMessages, useMessages } from '../hooks/useMessages';
import type { SearchFormState } from '../hooks/useMessageSearch';
import { useReceipts } from '../hooks/useReceipts';
import {
  addReaction,
  chatDisplayName,
  deleteMessages,
  editMessage,
  markRead,
  removeReaction,
  restoreMessages,
} from '../lib/chats';
import { formatSendTime } from '../lib/datetime';
import { retryAlbumItems, stageFiles, uploadAlbum, uploadVoice, type StagedAttachment } from '../lib/media';
import { clearChatNotifications } from '../lib/push';
import { blockMessages, buildTimeline, groupMessages, type MessageBlock, type MessageRun } from '../lib/messageGroups';
import { deriveReceipts, type ReceiptDerivation } from '../lib/receipts';
import { addTag, removeTag } from '../lib/tags';
import {
  applyReactionAdded,
  applyReactionRemoved,
  isFailedId,
  isLocalId,
  isPendingId,
  reactionPendingKey,
  useRealtime,
  withAllPages,
  type MessagesCache,
} from '../lib/realtime';
import { useIsMobile } from '../hooks/useIsMobile';
import { useIntroIds } from '../hooks/useIntroIds';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { useMediaTags } from '../hooks/useMediaTags';
import { useGifFavoriteActions, type GifFavoriteApi } from '../hooks/useGifFavorites';
import { useBackHandler } from '../lib/backStack';
import { useTypers } from '../lib/typing';
import { AlbumCard } from './AlbumCard';
import { AttachmentSheet } from './AttachmentSheet';
import { Composer } from './Composer';
import { EmbedCard } from './EmbedCard';
import { MediaBubble } from './MediaBubble';
import { MediaGridSheet, MediaStack } from './MediaStack';
import { MediaViewer } from './MediaViewer';
import { MessageActions } from './MessageActions';
import { MessageFocusMenu } from './MessageFocusMenu';
import { MessageSearchOverlay, MessageSearchPanel } from './MessageSearchPanel';
import { ScreenHeader } from './ScreenHeader';
import { StageOverlay, StagePanel } from './Stage';

/** docs/MEDIA_ATTACHMENTS.md §5.1 — an in-flight album send. `index`/`total`
 *  are 1-based positions within the album (1-of-1 for the unchanged voice
 *  push-to-talk path, which still passes a `label` for the banner text since
 *  it has no attachment tray to show "N of M" against). */
type UploadState = { index: number; total: number; progress: number; label?: string } | null;

/** What the full-screen viewer is showing. A list rather than a single item
 *  so prev/next works when the viewer was opened from a stack's grid sheet,
 *  with the exact same component the gallery uses. */
type ViewerState = { list: MediaInfo[]; index: number } | null;

/** The focus menu's (UI-8d) target — the message plus what was captured at
 *  the moment it opened: the bubble's on-screen rect (the lift animates from
 *  it) and the live DOM node (cloned for the lift — see MessageFocusMenu). */
type ActionMenuState = { message: Message; rect: DOMRect; sourceEl: HTMLElement } | null;

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const UNDO_TOAST_MS = 10_000;
// Post-MVP double-tap-to-react: how long a single tap waits to see if a
// second one arrives before performing its normal action — see `handleTap`.
const DOUBLE_TAP_MS = 250;
// How close to the bottom still counts as "at the bottom" for the re-pin on
// shrink (soft keyboard opening, composer growing) — a little slack so a few
// px of momentum overscroll or a fractional layout height doesn't read as
// "the reader deliberately scrolled up".
const BOTTOM_LATCH_PX = 80;
// One late re-pin after the composer takes focus, for the case where the
// browser pans the page instead of resizing anything and the observer below
// therefore never fires. Comfortably past a soft keyboard's slide-in; a single
// write, not a loop — see `handleComposerFocus` for why that distinction
// matters to how the list feels.
const KEYBOARD_SETTLE_MS = 400;

// Reaction pill row placement (see the row's own comment in MessageBlockRow
// for why both numbers exist and what the earlier revert got wrong).
const REACTION_OVERLAP_PX = 6; // how far the row rides up onto the bubble/media's bottom edge — a graze, deliberately not a half-overlap
// How far the row is pulled in from the sender's edge. Eyeballed down from
// 10 to 2 (owner revision 2026-08-24 — 10 read as the pill floating in the
// middle of the message rather than hanging off its corner). 2 rather than 0
// so it reads as deliberate instead of an accidental flush alignment. The
// original reason for an inset at all — keeping the overlap off live image
// pixels on bare media — survives the cut, because a media card's corner
// radius (rounded-md, 12px) is larger than the 6px of overlap: at a 2px inset
// the sliver still lands inside the rounded-away corner, not on the picture.
const REACTION_EDGE_INSET_PX = 2;
// Mirrors the `gap-[2px]` on the block's flex-col. The pill row is a flex
// child, so that gap is already pushing it down before any margin applies —
// pull it back out, or `REACTION_OVERLAP_PX` silently means 4px, not 6.
const BLOCK_ROW_GAP_PX = 2;
// One value for both the pull-up and the padding that gives the height back,
// so they can't drift apart and start shifting the runs below.
const REACTION_PULL_UP_PX = REACTION_OVERLAP_PX + BLOCK_ROW_GAP_PX;

// Swipe-to-reply gesture thresholds (mobile) — grouped here for later
// real-device tuning, same convention as Composer.tsx's gesture constants.
const SWIPE_REPLY_ENGAGE_PX = 12; // px of horizontal travel before we commit to a horizontal swipe over a vertical scroll/long-press
const SWIPE_REPLY_MAX_PX = 72; // clamp — how far the block can visually travel
const SWIPE_REPLY_THRESHOLD_PX = 56; // release past this to fire the reply
const SWIPE_SNAP_BACK_MS = 150; // must match the transition duration used in MessageBlockRow's style below
// ⚠️ iOS: a rightward swipe starting near the LEFT screen edge collides with
// the standalone PWA's back-edge-swipe gesture (same spirit as the existing
// MediaViewer/Composer iOS gesture flags in this file's family) — flag for
// the iPhone device-testing gate; nothing here can detect or avoid that
// collision without a real device to verify against.

/** Maps raw horizontal travel to the *visual* translateX distance: linear up
 *  to the threshold, then rubber-banded (diminishing returns) up to the max —
 *  so the bubble never just stops dead at the threshold, but also never
 *  travels further than `SWIPE_REPLY_MAX_PX`. */
function swipeTravel(absDx: number): number {
  if (absDx <= SWIPE_REPLY_THRESHOLD_PX) return absDx;
  const over = absDx - SWIPE_REPLY_THRESHOLD_PX;
  return Math.min(SWIPE_REPLY_THRESHOLD_PX + over * 0.35, SWIPE_REPLY_MAX_PX);
}

const MEDIA_REPLY_LABEL: Record<'image' | 'video' | 'voice', string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  voice: '🎤 Voice message',
};

/** docs/MEDIA_ATTACHMENTS.md §6 "ChatList / reply previews" — derived from
 *  `media.length`: 2+ is an album (D2), rendered as "📷 3 photos" rather than
 *  the single-item label above. */
function mediaReplyLabel(m: Message): string {
  if (m.media.length > 1) {
    const kind = m.media[0]!.kind;
    const noun = kind === 'video' ? 'videos' : kind === 'voice' ? 'voice messages' : 'photos';
    return `📷 ${m.media.length} ${noun}`;
  }
  const media = m.media[0];
  return media ? MEDIA_REPLY_LABEL[media.kind] : '';
}

/** Builds the `ReplyPreview` carried on an outgoing reply — a short text
 *  snippet for text messages, a media label otherwise. Mirrors the server's
 *  own preview shape (`ReplyPreview.preview`, "<=120 chars") without a
 *  second round-trip. */
function buildReplyPreview(m: Message): ReplyPreview {
  const preview = m.body ? m.body.slice(0, 120) : mediaReplyLabel(m);
  return { id: m.id, senderId: m.senderId, kind: m.kind, preview, deleted: false };
}

export function ChatView({
  chat,
  me,
  onBack,
  onOpenGallery,
  jumpToMessageId,
  initialDraft,
  onDraftChange,
  initialSearchState,
  onSearchStateChange,
  initialAttachments,
  onAttachmentsChange,
}: {
  chat: ChatSummary;
  me: MeResponse;
  onBack: () => void;
  onOpenGallery: () => void;
  /** Set when arriving from the gallery's "jump to message" — loads older
   *  pages until the target is present, then scrolls it into view. */
  jumpToMessageId?: string;
  /** Draft text lives in a per-chat cache owned by `AuthedApp` (keyed by
   *  chat.id), not purely in this component's local state. `ChatView`
   *  remounts on every genuine chat switch (by design, via `key={chat.id}`)
   *  *and* on a mobile/desktop breakpoint crossing (`AuthedApp` renders two
   *  structurally different trees per `useIsMobile()`) — the latter used to
   *  silently drop in-progress draft text. Seeding from `initialDraft` and
   *  mirroring every change back via `onDraftChange` means the draft
   *  survives either kind of remount. See docs/archive/UI_REVAMP.md §8. */
  initialDraft: string;
  onDraftChange: (draft: string) => void;
  /** Same App-level per-chat cache pattern as `initialDraft`/`onDraftChange`
   *  above, for the search panel's query text/filters/open-flag
   *  (docs/MESSAGE_SEARCH.md §4.1) — surviving the mobile overlay's
   *  close/reopen cycle is the point; this is what makes that possible
   *  across a genuine `ChatView` remount too. */
  initialSearchState: SearchFormState;
  onSearchStateChange: (state: SearchFormState) => void;
  /** Same App-level per-chat cache pattern again (docs/MEDIA_ATTACHMENTS.md
   *  §5.1) — staged-but-unsent attachments must survive switching chats and
   *  crossing the mobile/desktop breakpoint, exactly like draft text. Losing
   *  a picked-and-tagged album to an accidental tab switch would be the same
   *  class of bug as losing typed text, and worse: the user may have spent
   *  time tagging each item.
   *
   *  The cached entries' `previewUrl`s are DEAD by the time they come back —
   *  `Composer` revokes every object URL on unmount, deliberately, so a chat
   *  the user never returns to can't leak them. The `File` objects survive
   *  though (they're just references), so the mount below re-derives fresh
   *  URLs from them. Never render a cached `previewUrl` directly. */
  initialAttachments: StagedAttachment[];
  onAttachmentsChange: (attachments: StagedAttachment[]) => void;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(chat.id);
  const { sendMessage, sendGif, retrySend, discardFailed, notePendingReaction, clearPendingReaction, setActiveChat, sendTyping } = useRealtime();
  const receipts = useReceipts(chat.id);
  const typers = useTypers(chat.id);
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [draft, setDraftState] = useState(initialDraft);
  // Every write mirrors into AuthedApp's per-chat cache (see prop doc above)
  // in addition to updating local state for this render.
  function setDraft(value: string) {
    setDraftState(value);
    onDraftChange(value);
    // docs/TYPING_INDICATORS.md §3. Every draft edit routes through here, so
    // this is the one hook point — the throttle lives in the provider, so
    // calling it per keystroke is intended, not wasteful.
    //
    // ⚠️ Clearing the box is a STOP, not a start: `setDraft('')` runs on send,
    // on cancelling an edit and on cancelling a reply, and reporting "typing"
    // there would leave the indicator up for the full expiry after someone
    // pressed enter.
    sendTyping(chat.id, value.length > 0);
  }
  // Search panel state (docs/MESSAGE_SEARCH.md §4.1) — same mirror-into-cache
  // shape as `draft`/`setDraft` above, for the same remount-survival reason.
  const [searchState, setSearchStateRaw] = useState(initialSearchState);
  function setSearchState(updater: (prev: SearchFormState) => SearchFormState) {
    setSearchStateRaw((prev) => {
      const next = updater(prev);
      onSearchStateChange(next);
      return next;
    });
  }
  // Stage open/closed (docs/EMBEDS.md §6.2) — plain local state, unlike
  // `searchState`'s App-level cache mirroring: the Stage has no form input
  // worth preserving across the mobile/desktop breakpoint remount, so there's
  // nothing to lose by starting closed on every `ChatView` mount.
  const [stageOpen, setStageOpen] = useState(false);
  const [upload, setUpload] = useState<UploadState>(null);
  const [uploadError, setUploadError] = useState('');
  // docs/MEDIA_ATTACHMENTS.md §5.1 — staged, not-yet-uploaded picks; the
  // composer's tray renders from this. Seeded from AuthedApp's per-chat cache
  // and mirrored back on every write (see the prop docs above), so a chat
  // switch or a breakpoint remount doesn't throw away picked-and-tagged
  // files. Object URLs are re-minted here because the previous mount's
  // `Composer` revoked them on the way out.
  const [attachments, setAttachmentsState] = useState<StagedAttachment[]>(() =>
    initialAttachments.map((a) => ({ ...a, previewUrl: a.previewUrl ? URL.createObjectURL(a.file) : a.previewUrl })),
  );
  /** Mirrors into the App-level cache in addition to updating local state —
   *  same shape as `setDraft`/`setSearchState` above. */
  function setAttachments(updater: (prev: StagedAttachment[]) => StagedAttachment[]) {
    setAttachmentsState((prev) => {
      const next = updater(prev);
      onAttachmentsChange(next);
      return next;
    });
  }
  // Which staged attachment's `AttachmentSheet` is open, if any.
  const [attachmentSheetFor, setAttachmentSheetFor] = useState<string | null>(null);
  // The message id an album mint created, kept around only while some of its
  // items are still `failed` — lets `discardAlbum`/an expired-URL retry
  // soft-delete the right orphaned message. Cleared once nothing staged is
  // failed anymore. A plain ref (not state): it never drives a render on its
  // own, only read inside the retry/discard handlers below.
  const failedAlbumMessageIdRef = useRef<string | null>(null);
  // In-flight guard for album sends (user feedback, 2026-08-13: tapping Send
  // repeatedly while an image uploaded sent it several times). The `upload`
  // state alone can't cover this — it isn't set until `uploadAlbum`'s first
  // progress callback, i.e. after the mint round-trip, so every tap during
  // that window sees `upload === null` and starts a whole second album. Same
  // posture as `loadingOlderRef` above: a ref, because the fix has to hold
  // between the call and the re-render, not after it.
  const sendingAlbumRef = useRef(false);
  const [viewer, setViewer] = useState<ViewerState>(null);
  // The items of whichever grid sheet is open (UI-7 legacy fan, or
  // docs/MEDIA_ATTACHMENTS.md §5.3's album "+N" overflow) — held as resolved
  // `MediaInfo[]`, not messages, so `MediaGridSheet` (which only ever needed
  // one media item per row) doesn't care which of the two opened it, and
  // picking a tile can seed the viewer directly from this same array.
  const [gridSheetItems, setGridSheetItems] = useState<MediaInfo[] | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  // Search results' own jump target (docs/MESSAGE_SEARCH.md §4.2) — the
  // gallery's jump uses `jumpToMessageId` (a prop, set once at mount via
  // `App.openChat`); search lives *inside* an already-open ChatView, with no
  // App round-trip, so it needs a settable-from-within target instead. Both
  // feed the same auto-paging effect below via `effectiveJumpId`.
  const [jumpTarget, setJumpTarget] = useState<string | undefined>(undefined);
  const effectiveJumpId = jumpTarget ?? jumpToMessageId;
  const jumpedRef = useRef(false);
  // Scroll metrics captured right before an older page is fetched, so the
  // layout effect below can restore the visual position after the prepend
  // (iOS Safari has no native scroll anchoring — manual restore is required).
  const prependRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // In-flight guard for scroll-triggered older-page fetches: `isFetchingNextPage`
  // only flips true on the *next* render, so momentum-scroll events between the
  // fetch call and that render would double-fire without it.
  const loadingOlderRef = useRef(false);
  // Was the reader parked at the bottom as of the last scroll event? Drives
  // the re-pin-on-shrink effect below (soft keyboard, growing composer).
  // Starts true because every chat opens scrolled to the bottom.
  const atBottomRef = useRef(true);
  // The list's inner content wrapper — watched for *growth* (late-loading
  // media changing height) by the same observer that watches the scroller for
  // shrink; see that effect below.
  const contentRef = useRef<HTMLDivElement>(null);
  const name = chatDisplayName(chat, me.id);

  // Post-MVP: the message the composer is currently replying to (the reply
  // bar above `<Composer>` renders from this), null when not replying.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // docs/MESSAGE_EDIT.md — the message currently being edited (the edit bar
  // above `<Composer>` renders from this), null when not editing. Mutually
  // exclusive with `replyingTo`: starting one clears the other (see
  // `startReply`/`startEdit`). `preEditDraftRef` stashes whatever was in the
  // composer *before* entering edit mode so Cancel/successful-submit can put
  // it back — this is closer to a "swap the draft out and back" than an
  // upload's caption clearing (which has no equivalent need to restore).
  const [editing, setEditing] = useState<Message | null>(null);
  const preEditDraftRef = useRef('');
  // Which block (by its lead message id) currently has a swipe-to-reply
  // gesture on it, or null. This is the *only* React state the gesture
  // touches, and it changes exactly twice per swipe: once when the drag
  // engages (mounting the reveal icon) and once when the snap-back finishes
  // (unmounting it). Only one gesture can be active at a time (a single
  // pointer), so it's a single slot, not a map.
  //
  // The live offset is deliberately NOT state. It used to be
  // (`swipeState: {id, dx}`, written on every pointermove), and that cost two
  // separate defects (owner report, 2026-08-23: "swipe-to-reply seems to have
  // stopped working"):
  //
  //  1. `pointermove` is a *continuous* event, so React schedules its update
  //     at default priority rather than flushing it. A quick flick could lift
  //     the finger before that render committed, leaving `onBubblePointerUp`
  //     holding the previous render's `swipeState` — travel read as 0, no
  //     reply fired, no snap-back. A slow drag worked; a flick silently did
  //     nothing.
  //  2. Nothing in this file is memoized, so each of those ~60 updates/second
  //     re-rendered every run, block, media bubble, embed card and receipt row
  //     on screen. As the list grew (albums, receipts, embeds, GIF cards) that
  //     got heavy enough to jank the first frames of the gesture, which is
  //     exactly the window in which the browser decides whether the touch is a
  //     horizontal swipe or a vertical scroll.
  //
  // So the drag is painted straight to the DOM instead (`paintSwipe`), reading
  // the nodes out of `messageRefs`/`swipeIconRefs`. Nothing re-renders while a
  // finger is down. React must therefore never manage `transform`/`transition`
  // on a block either — see `MessageBlockRow`'s style object.
  const [swipingId, setSwipingId] = useState<string | null>(null);
  // The reveal icons, registered the same way `messageRefs` registers blocks,
  // so `paintSwipe` can drive the icon's fade/scale imperatively too. Only the
  // block being swiped ever has one mounted.
  const swipeIconRefs = useRef(new Map<string, HTMLDivElement>());
  // Per-gesture bookkeeping for the currently pressed block, set at
  // pointerdown and read/mutated on pointermove — a plain ref (like
  // Composer's `gestureRef`) since it doesn't itself need to trigger a render.
  // `travel` is the signed offset currently painted, and it lives here rather
  // than in state specifically so the release check can't read a stale value
  // (defect 1 above).
  const swipeGestureRef = useRef<{
    msg: Message;
    mine: boolean;
    startX: number;
    startY: number;
    engaged: boolean;
    travel: number;
    pointerId: number;
  } | null>(null);
  // Pending snap-back cleanup, so a new gesture landing mid-animation can
  // cancel it rather than have it fire later and unmount a live icon.
  const snapBackTimerRef = useRef<number | null>(null);
  // Post-MVP double-tap-to-react: the message id + pending timer for a tap
  // that's waiting to see if a second one arrives — see `handleTap`.
  const pendingTapRef = useRef<{ id: string; timer: number } | null>(null);

  // Multi-select + deletion (Stage 6 / §2 item 11, docs/archive/MESSAGE_DELETE.md §4).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  // System back gesture / browser back cancels selection mode (matches the X
  // in the selection header) before it would unwind the chat → chat list.
  // Registered after AuthedApp's view handler, so LIFO exits selection first.
  useBackHandler(selectionMode, () => exitSelectionMode(), { escape: true });
  // The message the focus menu (UI-8d — Copy/Select/Delete + send time) is
  // currently open for, plus what was captured at open time for the lift
  // animation. Was `Message | null` pre-UI-8, when this drove a plain
  // bottom-sheet with no shared-element animation to feed.
  const [actionMenuFor, setActionMenuFor] = useState<ActionMenuState>(null);
  const [actionError, setActionError] = useState('');
  const [undoIds, setUndoIds] = useState<string[] | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  // Long-press bookkeeping: a plain 500ms timer with move-slop cancellation
  // (docs/archive/MESSAGE_DELETE.md §4 — deliberately NOT setPointerCapture, which
  // would swallow the list's own scrolling).
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  // Set true when the long-press timer fires, so the click that follows the
  // eventual pointerup (touch synthesizes one even after a long hold) is
  // swallowed instead of also toggling selection or opening the viewer.
  const suppressClickRef = useRef(false);

  const messages = flattenMessages(data?.pages);
  // Runs (same sender, close in time) + stacks (adjacent bare photos/videos).
  // Stacking is off during multi-select so every message stays individually
  // selectable — see lib/messageGroups.ts.
  const runs = groupMessages(messages, { stack: !selectionMode });
  // Date/time dividers interleaved between runs (UI-8b request D) — purely
  // derived over whatever's currently loaded, recomputed every render.
  const timeline = buildTimeline(runs);
  // Which message ids should play the send/receive bubble-in animation on
  // this render (UI-8a) — see the hook's doc for why this has to be more
  // than "is this id new".
  const introIds = useIntroIds(messages, me.id);
  const lastMessageId = messages[messages.length - 1]?.id;
  // docs/RECEIPTS.md §3/§5.4 — seen-avatars + Sent/Delivered status derived
  // fresh every render from the receipts cache + whatever's currently
  // loaded; `lib/receipts.ts` is the pure, unit-tested derivation.
  const receiptDerivation: ReceiptDerivation = deriveReceipts(messages, receipts.data?.receipts ?? [], chat.members, me.id);
  const viewerMedia = viewer ? (viewer.list[viewer.index] ?? null) : null;
  // Tags for whatever the viewer is showing. Per the UI-7 decision, tagging
  // stays a viewing-time action (never part of the send path) — this just
  // makes the existing gallery TagEditor reachable straight from a chat
  // bubble instead of only via the gallery screen.
  const viewerTags = useMediaTags(viewerMedia?.id ?? null);
  // docs/GIF_FAVORITES.md §8.1 — built once here and threaded down as a single
  // prop, rather than each message row subscribing to the same query itself.
  // Gated on `gifsEnabled` so a server with no Klipy key never fetches keys and
  // never renders a star.
  const gifFavorites = useGifFavoriteActions(me.gifsEnabled);
  // Null for every message except a ready inline GIF, which is what makes the
  // focus menu's Favorite row appear only where it means something.
  const menuGifState = actionMenuFor ? gifFavorites.stateFor(actionMenuFor.message) : null;
  const selectedMessages = messages.filter((m) => selectedIds.has(m.id));
  const allSelectedMine = selectedMessages.length > 0 && selectedMessages.every((m) => m.senderId === me.id);
  const canCopySelection = selectedMessages.some((m) => m.body);

  // Mark the newest message read once it's loaded/changes — cheap and matches
  // "open the chat = you've seen it" (BACKBONE §5 last_read_message_id).
  // docs/RECEIPTS.md §5.4: visibility-gated — a backgrounded tab/PWA marking
  // read would now be a user-visible lie (the sender's bubble would show a
  // Seen avatar for a chat the reader never actually looked at). Mirrors the
  // `clearChatNotifications` effect right below: mark immediately if already
  // visible, and again on every later `visibilitychange` that finds it
  // visible (covers "sent while backgrounded, then the user foregrounds it").
  useEffect(() => {
    if (!lastMessageId || isLocalId(lastMessageId)) return;
    function markIfVisible() {
      if (document.visibilityState !== 'visible') return;
      void markRead(chat.id, lastMessageId!).then(() => qc.invalidateQueries({ queryKey: ['chats'] }));
    }
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [chat.id, lastMessageId, qc]);

  // Clear this chat's already-shown notifications when it becomes the active
  // chat — on mount/chat switch, and again if the tab/PWA regains visibility
  // while it's still open (returning to an already-open chat).
  //
  // Same effect reports this chat as the one on screen (docs/NOTIFICATIONS.md
  // §2.1) — the two are the same fact stated to two different consumers, and
  // splitting them would let them drift. Cleanup clears the report rather than
  // leaving it standing: a `ChatView` that unmounted is a chat nobody is
  // looking at, and stale presence is a *suppressed* notification.
  useEffect(() => {
    clearChatNotifications(chat.id);
    setActiveChat(chat.id);
    const onVisible = () => {
      if (document.visibilityState === 'visible') clearChatNotifications(chat.id);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      setActiveChat(null);
    };
  }, [chat.id, setActiveChat]);

  // Restore the visual scroll position after an older page prepends — runs
  // before paint so the list never visibly jumps. Only fires when
  // `loadOlder` captured metrics; jump-to-message paging deliberately
  // doesn't, since it ends in its own scrollIntoView.
  useLayoutEffect(() => {
    const saved = prependRef.current;
    const el = scrollerRef.current;
    if (saved && el && el.scrollHeight !== saved.scrollHeight) {
      el.scrollTop = saved.scrollTop + (el.scrollHeight - saved.scrollHeight);
      prependRef.current = null;
    }
  }, [messages.length]);

  useEffect(() => {
    if (!isFetchingNextPage) {
      loadingOlderRef.current = false;
      // Restore (above) already consumed this if a page landed; clearing here
      // covers a fetch that prepended nothing, so stale metrics can't shift
      // the list on some later unrelated length change.
      prependRef.current = null;
    }
  }, [isFetchingNextPage]);

  /** Fetch the next (older) page, capturing scroll metrics first so the
   *  layout effect above can keep the viewport visually anchored. */
  function loadOlder() {
    const el = scrollerRef.current;
    if (!el || loadingOlderRef.current || !hasNextPage || isFetchingNextPage) return;
    loadingOlderRef.current = true;
    prependRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    void fetchNextPage();
  }

  // Infinite scroll upward: start fetching once the user is within a couple
  // of screens of the top, so older history is usually there before they
  // reach it.
  function onScrollerScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    // Latch "is the reader parked at the bottom?" on every scroll, for the
    // re-pin effect below. Recorded here rather than measured at re-pin time
    // on purpose: by the time the scroller has already shrunk, the reader
    // *looks* scrolled-up (the same scrollTop is now further from the bottom)
    // and the answer we need is the one from before the shrink.
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_LATCH_PX;
    if (el.scrollTop < 300) loadOlder();
  }

  // Scroll the container itself to its full scrollHeight rather than
  // scrollIntoView on a bottom sentinel — the sentinel sits above the
  // container's own bottom padding, so aligning to it left that padding
  // still scrollable (a dangling gap after every send). Keyed on the
  // *newest* message id, not list length — older pages prepending must not
  // yank the reader back to the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!jumpToMessageId && el) el.scrollTop = el.scrollHeight;
  }, [chat.id, lastMessageId, jumpToMessageId]);

  // docs/IOS_KEYBOARD.md — on iOS, opening the keyboard grows the
  // composer's own box (see Composer's padding-bottom), which shrinks this
  // flex-1 scroller and can push the last message out of view underneath
  // it. Re-run the same "snap to bottom" the effect above already does for
  // a new message, but only on the keyboard's closed→open *edge*
  // (`keyboardOpenRef`), not on every intermediate px the hook reports —
  // otherwise later height changes while it's already open (switching to
  // the emoji keyboard, the predictive-text bar toggling) would keep
  // yanking the view back down instead of leaving the user's own scrolling
  // alone. `keyboardInset` is 0 for the whole session off-iOS (the hook's
  // gate), so this effect never fires there.
  const keyboardInset = useKeyboardInset();
  const keyboardOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = keyboardInset > 0;
    if (isOpen && !keyboardOpenRef.current) {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    keyboardOpenRef.current = isOpen;
  }, [keyboardInset]);

  // ...and the same thing everywhere else, by watching boxes instead of the
  // keyboard (user feedback, 2026-08-13). Two independent ways the newest
  // message slides out of view while the reader is parked at the bottom, both
  // invisible to the `keyboardInset` path above:
  //
  //   1. The *scroller shrinks* — Android/Chrome resizes the layout viewport
  //      for the soft keyboard (docs/IOS_KEYBOARD.md §1), so the hook above is
  //      a hard no-op there and nothing re-pinned the list: the box just got
  //      shorter with `scrollTop` untouched. Also covers the composer growing
  //      to multi-line and the attachment tray appearing.
  //   2. The *content grows* — a `MediaBubble` swapping its fixed 128px
  //      "Processing…" card for the real image (up to `max-h-72`, so it can
  //      more than double), an `EmbedCard` resolving, a late-decoding photo
  //      whose stored dimensions were missing so `PreviewImage` had no box to
  //      reserve. Every one of these lengthens the list *below* the fold
  //      without firing a scroll event.
  //
  // Both re-pin only when the reader was already at the bottom
  // (`atBottomRef`), so neither disturbs someone reading history, and both
  // stand down while an older page is landing — `prependRef`'s layout effect
  // owns the scroll position for that frame and would fight this.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastViewport = el.clientHeight;
    let lastContent = content?.offsetHeight ?? 0;
    const ro = new ResizeObserver(() => {
      const viewport = el.clientHeight;
      const contentHeight = content?.offsetHeight ?? 0;
      const shrank = viewport < lastViewport;
      const grew = contentHeight > lastContent;
      lastViewport = viewport;
      lastContent = contentHeight;
      if (!shrank && !grew) return;
      if (prependRef.current) return; // an older page is landing — its restore effect owns the scroll
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, []);

  /** The composer's text field took focus, so the soft keyboard is on its way
   *  up. The observer above is what actually keeps the newest message in view
   *  — it fires in the same layout pass as the resize, which is as early as
   *  any of this can happen — so all this adds is one immediate pin (a no-op
   *  in the common case where the list is already pinned) plus one late one
   *  as a safety net for a browser that pans instead of resizing, where no
   *  observer would ever fire.
   *
   *  Deliberately NOT a rAF loop across the keyboard animation, which is what
   *  the previous cut did: writing `scrollTop` every frame for most of a
   *  second means a swipe during that window gets overwritten, and the list
   *  reads as rigid rather than merely late (user feedback, 2026-08-13 —
   *  "feels forced"). It also bought nothing: content cannot move before the
   *  browser moves the layout, so the frames before the resize were all
   *  no-ops. */
  function handleComposerFocus() {
    const pin = () => {
      const el = scrollerRef.current;
      if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    if (!atBottomRef.current) return;
    pin();
    window.setTimeout(pin, KEYBOARD_SETTLE_MS);
  }

  // Short chats: if the first page doesn't even fill the viewport there's no
  // scrollbar, so the scroll handler alone could never trigger a fetch. Runs
  // after the scroll-to-bottom effect above, so a full viewport is already
  // scrolled down (scrollTop > 0) and won't fetch spuriously.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && hasNextPage && !isFetchingNextPage && el.scrollHeight <= el.clientHeight) loadOlder();
  });

  // One jump per *target*, not per mount (docs/MESSAGE_SEARCH.md §4.2) — a
  // search-result tap can set a brand-new `jumpTarget` several times across
  // one ChatView mount (gallery's `jumpToMessageId` only ever changes via a
  // remount, so this used to be equivalent to "once per mount"). Resetting
  // the guard whenever the effective target changes lets a second, third,
  // etc. search-jump in the same session still fire.
  useEffect(() => {
    jumpedRef.current = false;
  }, [effectiveJumpId]);

  // Keyset pagination is newest-first, so an older target message may not be
  // in the first page yet — keep paging back until it shows up (or we run
  // out of history). Runs once per jump target (see the guard-reset effect
  // above).
  useEffect(() => {
    if (!effectiveJumpId || jumpedRef.current) return;
    const found = messages.some((m) => m.id === effectiveJumpId);
    if (found) {
      jumpedRef.current = true;
      messageRefs.current.get(effectiveJumpId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightId(effectiveJumpId);
      setTimeout(() => setHighlightId(null), 2000);
    } else if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [effectiveJumpId, messages, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Undo toast is purely client-side (~10s, docs/archive/MESSAGE_DELETE.md §4) — make
  // sure navigating away from this chat can't leave a stray timer firing
  // setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Same reasoning, for the double-tap-to-react pending timer (`handleTap`)
  // — a tap right before navigating away shouldn't fire its delayed action
  // into an unmounted component.
  useEffect(() => {
    return () => {
      if (pendingTapRef.current) window.clearTimeout(pendingTapRef.current.timer);
    };
  }, []);

  // Same again for the swipe-to-reply snap-back (`snapBack`): leaving the chat
  // mid-gesture would otherwise leave a timer holding a `setSwipingId` call.
  useEffect(() => {
    return () => {
      if (snapBackTimerRef.current !== null) window.clearTimeout(snapBackTimerRef.current);
    };
  }, []);

  // docs/MESSAGE_EDIT.md §4.2 edge case: a `message.deleted` frame (this
  // client's own bulk-select delete, another tab, etc.) removed the message
  // currently being edited out from under the composer — cancel edit mode
  // rather than let Update fire against a message that no longer exists.
  useEffect(() => {
    if (editing && !messages.some((m) => m.id === editing.id)) cancelEdit();
  }, [editing, messages]);

  // Escape cancels an in-progress edit (desktop; mirrors the X on the edit
  // bar) — same "Escape dismisses the transient thing on top" convention as
  // `MessageFocusMenu`'s own Escape handler.
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelEdit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  /** Takes a list, not a single message, because long-pressing a fanned stack
   *  selects every message it covers — a stack is a drawing of N messages,
   *  never an addressable unit of its own (docs/archive/UI_REVAMP.md UI-7). Entering
   *  selection mode also un-stacks the run, so the user immediately sees the
   *  individual bubbles they just selected. */
  function enterSelectionMode(msgs: Message[]) {
    const ids = msgs.map((m) => m.id);
    if (ids.length === 0) return;
    setSelectionMode(true);
    setSelectedIds(new Set(ids));
    setSelectionAnchorId(ids[ids.length - 1]!);
    setActionMenuFor(null);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectionAnchorId(id);
  }

  // Inclusive range between the tracked anchor and the clicked message,
  // replacing the current selection (desktop shift-click, matching the
  // familiar file-explorer convention: further shift-clicks extend/shrink
  // relative to the original anchor, which is left untouched here).
  function selectRange(anchorId: string, targetId: string) {
    const ids = messages.map((m) => m.id);
    const ai = ids.indexOf(anchorId);
    const ti = ids.indexOf(targetId);
    if (ai === -1 || ti === -1) return;
    const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
    setSelectedIds(new Set(ids.slice(lo, hi + 1).filter((id) => !isLocalId(id))));
  }

  function showUndoToast(ids: string[]) {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    // A second delete while a toast is live replaces it, it doesn't stack —
    // the earlier deletion is still undoable via the API, just not via this
    // toast anymore (docs/archive/MESSAGE_DELETE.md §4).
    setUndoIds(ids);
    undoTimerRef.current = window.setTimeout(() => {
      setUndoIds(null);
      undoTimerRef.current = null;
    }, UNDO_TOAST_MS);
  }

  async function performDelete(ids: string[]) {
    if (ids.length === 0) return;
    setActionError('');
    try {
      const res = await deleteMessages(chat.id, ids);
      // The chat itself updates via the message.deleted WS broadcast (the
      // sender's own room membership includes them) — this call only tells
      // us whether to bother with the undo toast.
      if (res.messageIds.length > 0) showUndoToast(res.messageIds);
    } catch {
      setActionError('Delete failed — try again');
    }
  }

  async function handleUndo() {
    const ids = undoIds;
    if (!ids) return;
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoIds(null);
    setActionError('');
    try {
      await restoreMessages(chat.id, ids);
    } catch {
      setActionError('Restore failed — try again');
    }
  }

  async function handleBulkDelete() {
    if (!allSelectedMine) return;
    const ids = Array.from(selectedIds);
    exitSelectionMode();
    await performDelete(ids);
  }

  function handleBulkCopy() {
    const text = selectedMessages
      .filter((m) => m.body)
      .map((m) => m.body)
      .join('\n');
    if (text) void navigator.clipboard.writeText(text);
  }

  function handleMenuCopy(m: Message) {
    if (m.body) void navigator.clipboard.writeText(m.body);
    setActionMenuFor(null);
  }

  async function handleMenuDelete(m: Message) {
    setActionMenuFor(null);
    await performDelete([m.id]);
  }

  /** Opens the UI-8d focus menu for a message, capturing its current
   *  on-screen rect + DOM node from `messageRefs` — both are needed for the
   *  lift animation (see `MessageFocusMenu`). No-ops if the message isn't
   *  currently rendered with a ref (shouldn't happen — every visible block
   *  registers one before it's interactive). */
  function openActionMenu(m: Message) {
    const el = messageRefs.current.get(m.id);
    if (!el) return;
    setActionMenuFor({ message: m, rect: el.getBoundingClientRect(), sourceEl: el });
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  /** Sets `replyingTo`, shared by every reply affordance (swipe, the
   *  desktop hover bar, and the focus menu's Reply row) so they all funnel
   *  through one place. Cancels an in-progress edit first — the two modes
   *  are mutually exclusive (docs/MESSAGE_EDIT.md §4.2). */
  function startReply(m: Message) {
    if (editing) cancelEdit();
    setReplyingTo(m);
  }

  /** Enters edit mode for `m` (docs/MESSAGE_EDIT.md §4.2) — the focus menu's
   *  Edit row is the only entry point. Stashes the current draft (restored
   *  on cancel/submit), clears any in-progress reply (mutual exclusion), and
   *  seeds the composer with the message's current body. */
  function startEdit(m: Message) {
    if (!m.body) return;
    // docs/MEDIA_ATTACHMENTS.md §5.1 — entering edit mode is blocked while
    // attachments are staged: a hidden-but-alive tray whose contents the
    // Update button ignores would be quietly confusing. Surfaced through the
    // existing error path rather than silently hiding the tray.
    if (attachments.length > 0) {
      setUploadError('Send or remove the attachment first');
      return;
    }
    setReplyingTo(null);
    preEditDraftRef.current = draft;
    setEditing(m);
    setDraft(m.body);
  }

  /** Exits edit mode without submitting, restoring whatever draft was there
   *  before — shared by the edit bar's ✕, Escape, and the "target got
   *  deleted out from under us" effect below. */
  function cancelEdit() {
    setEditing(null);
    setDraft(preEditDraftRef.current);
  }

  /** Submits the in-progress edit (docs/MESSAGE_EDIT.md §4.2): trimmed,
   *  non-empty, and different from the original → PATCH via POST .../edit,
   *  patch the cache from the response (REST-first — the `message.edited` WS
   *  frame that follows is just an idempotent replace, see
   *  `lib/realtime.tsx`), exit edit mode, restore the stashed draft.
   *  Unchanged body just cancels — no request, matching the no-op guard the
   *  server itself applies. */
  async function submitEdit() {
    const target = editing;
    if (!target) return;
    const trimmed = draft.trim();
    if (!trimmed) return; // Update is disabled on an empty draft; guard anyway
    if (trimmed === (target.body ?? '').trim()) {
      cancelEdit();
      return;
    }
    setActionError('');
    try {
      const res = await editMessage(chat.id, target.id, trimmed);
      qc.setQueryData<MessagesCache>(['messages', chat.id], (old) =>
        withAllPages(old, (msgs) => msgs.map((mm) => (mm.id === res.message.id ? res.message : mm))),
      );
      setEditing(null);
      setDraft(preEditDraftRef.current);
    } catch {
      setActionError('Edit failed — try again');
    }
  }

  /** Scrolls a quoted message's original into view and highlights it —
   *  reuses the exact `messageRefs`/`setHighlightId`/2s-timeout machinery the
   *  `jumpToMessageId` effect (above) already drives for gallery "jump to
   *  message". Unlike that effect, this doesn't page back through older
   *  history looking for the target — it's a best-effort jump limited to
   *  whatever's currently loaded (the quoted block already shows the
   *  preview text, so a miss here isn't a dead end, just a no-op tap). */
  function jumpToMessage(id: string) {
    const el = messageRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 2000);
  }

  /** A search result was tapped (docs/MESSAGE_SEARCH.md §4.2). Sets the jump
   *  target (which drives the auto-paging effect above, same as the
   *  gallery's `jumpToMessageId`) and, on mobile only, closes the overlay in
   *  the same interaction — search state itself is untouched either way, so
   *  reopening shows exactly what was there. Desktop's panel stays open
   *  (Discord behavior): the tap just scrolls/highlights beside it. */
  function jumpFromSearchResult(id: string) {
    setJumpTarget(id);
    if (isMobile) setSearchState((s) => ({ ...s, panelOpen: false }));
  }

  // Long-press → focus menu (or, if already selecting, a direct toggle — see
  // docs/archive/MESSAGE_DELETE.md §4's "long-press when already in selection mode").
  // Never selectable/actionable while still an optimistic pending bubble —
  // there's nothing to delete server-side yet.
  //
  // Also arms the swipe-to-reply gesture (mobile only) on the same pointer
  // sequence — see `onBubblePointerMove` for where it actually engages. Both
  // gestures start from this one pointerdown so they never fight over which
  // "owns" the touch; swipe engaging cancels the long-press timer below.
  function onBubblePointerDown(e: React.PointerEvent, msgs: Message[], mine: boolean) {
    // Clear any stale suppression from a previous interaction whose click
    // never arrived (long-press fired, then the pointer lifted off the
    // bubble — no click event, so onBubbleClick never got to reset it).
    // Without this, that next tap would be silently swallowed.
    suppressClickRef.current = false;
    const m = msgs[0];
    // Pending bubbles have nothing to act on yet (no server-side id at all)
    // and stay excluded entirely. Failed ones are deliberately let through —
    // docs/RECEIPTS.md §5.4 wants long-press to reach a (reduced, Discard-
    // only) focus menu for them, so only `isPendingId` bails here, not the
    // broader `isLocalId`.
    if (!m || isPendingId(m.id)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      // Stacks (msgs.length > 1) skip the single-message focus menu: Copy
      // and Delete are per-message, so the useful gesture is "select all of
      // these", which also expands the stack back into individual bubbles.
      // A failed message is never batch-selectable (its id isn't a real
      // server id) even if selection mode happens to already be active.
      if (selectionMode) {
        if (!isLocalId(m.id)) toggleSelect(m.id);
      } else if (msgs.length > 1) enterSelectionMode(msgs);
      else openActionMenu(m);
    }, LONG_PRESS_MS);

    // Stacks are excluded — a stack has no single addressable message to
    // attach a reply to (the same reason it skips the focus menu above).
    // Mouse pointers skip it too: desktop already has the hover Reply
    // button, and a mouse-drag swipe isn't a gesture users expect there. A
    // failed message can't be replied to either (docs/RECEIPTS.md §5.4).
    swipeGestureRef.current =
      !selectionMode && msgs.length === 1 && e.pointerType !== 'mouse' && !isFailedId(m.id)
        ? { msg: m, mine, startX: e.clientX, startY: e.clientY, engaged: false, travel: 0, pointerId: e.pointerId }
        : null;
  }

  /** Paints one frame of a swipe straight onto the DOM — the block's
   *  `translateX` plus the reveal icon's fade/scale/armed colour — with no
   *  React involvement at all. See `swipingId`'s doc comment for why the drag
   *  is imperative.
   *
   *  Every write is guarded: a block can unmount mid-gesture (the message gets
   *  deleted, an older page re-keys the list), and the icon mounts a frame or
   *  two after `setSwipingId`, so the first move or two legitimately find
   *  nothing there yet. */
  function paintSwipe(id: string, dx: number) {
    const el = messageRefs.current.get(id);
    if (el) el.style.transform = dx ? `translateX(${dx}px)` : '';

    const icon = swipeIconRefs.current.get(id);
    if (!icon) return;
    const progress = Math.min(1, Math.abs(dx) / SWIPE_REPLY_THRESHOLD_PX);
    icon.style.opacity = String(progress);
    icon.style.transform = `scale(${0.7 + 0.3 * progress})`;
    // "Fills in" (muted → accent) once past the fire threshold. Toggled as
    // classes rather than inline colours so the palette stays in the design
    // tokens (PROJECT.md §11 — never hardcoded colours); the icon's own
    // `transition-colors` animates the swap for free.
    const armed = progress >= 1;
    icon.classList.toggle('bg-accent', armed);
    icon.classList.toggle('text-white', armed);
    icon.classList.toggle('bg-surface-sunken', !armed);
    icon.classList.toggle('text-text-muted', !armed);
  }

  function onBubblePointerMove(e: React.PointerEvent) {
    const swipe = swipeGestureRef.current;
    if (swipe) {
      const dx = e.clientX - swipe.startX;
      const dy = e.clientY - swipe.startY;
      if (!swipe.engaged) {
        // Toward-center direction: theirs (left-aligned) swipes right
        // (dx > 0), mine (right-aligned) swipes left (dx < 0) — a swipe the
        // wrong way is left alone entirely (no reply, no visual feedback),
        // same as iMessage.
        const towardCenter = swipe.mine ? dx < 0 : dx > 0;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_REPLY_ENGAGE_PX && towardCenter) {
          swipe.engaged = true;
          clearLongPressTimer();
          // Capture the pointer now that the gesture is committed. The
          // standing rule (docs/archive/MESSAGE_DELETE.md §4) is "do not call
          // setPointerCapture — it would swallow the list's own scrolling",
          // and that rule is about capturing at *pointerdown*, before we know
          // whether this is a scroll. Here the direction test above has
          // already decided it isn't, so scrolling has nothing left to lose.
          //
          // Without capture the gesture strands itself on short bubbles: past
          // the threshold the block rubber-bands (`swipeTravel`) and so lags
          // the finger, and once the finger is outside the block's own box,
          // pointermove/pointerup stop being delivered to it at all — no
          // reply, and the bubble left sitting at its dragged offset until
          // something else re-renders. Capture keeps the whole gesture
          // addressed to this element regardless of where the finger goes.
          try {
            e.currentTarget.setPointerCapture(swipe.pointerId);
          } catch {
            // Pointer already released/invalid — the gesture is over anyway,
            // and the pointerup/cancel path cleans up either way.
          }
          // A snap-back on this same block may still be running — a second
          // swipe landing before it finished keeps the icon mounted, so both
          // nodes can still be carrying the easing it armed. A live drag must
          // track the finger 1:1, never ease, so strip it off both.
          cancelPendingSnapBack();
          const el = messageRefs.current.get(swipe.msg.id);
          if (el) el.style.transition = '';
          const icon = swipeIconRefs.current.get(swipe.msg.id);
          if (icon) icon.style.transition = '';
          setSwipingId(swipe.msg.id);
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > LONG_PRESS_SLOP_PX) {
          // Reads as a vertical scroll instead — hand the gesture back to
          // the list's own scrolling and the (still-running) long-press
          // timer/slop check below, rather than keep re-testing every move.
          swipeGestureRef.current = null;
        }
      }
      if (swipe.engaged) {
        const travel = swipeTravel(Math.abs(dx));
        swipe.travel = swipe.mine ? -travel : travel;
        paintSwipe(swipe.msg.id, swipe.travel);
        return; // engaged swipe owns this gesture — skip the long-press slop check below
      }
    }

    const start = longPressStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearLongPressTimer();
  }

  function cancelPendingSnapBack() {
    if (snapBackTimerRef.current === null) return;
    window.clearTimeout(snapBackTimerRef.current);
    snapBackTimerRef.current = null;
  }

  /** Eases the block (and its reveal icon) back to rest, then tears the
   *  gesture's DOM state down.
   *
   *  `transition: transform` is armed here and cleared again when the
   *  animation ends — never left standing on a block. An unconditional
   *  `transition: transform` on every bubble was assumed to be a harmless
   *  no-op until real Android PWA testing showed it was enough to promote
   *  every bubble onto its own compositor layer, which then ignored the focus
   *  menu's z-index entirely (2026-07-22 — see BACKBONE §15). Driving this
   *  imperatively keeps that blast radius at exactly one element for exactly
   *  the length of one animation. */
  function snapBack(id: string) {
    const el = messageRefs.current.get(id);
    if (el) {
      el.style.transition = `transform ${SWIPE_SNAP_BACK_MS}ms ease-out`;
      el.style.transform = 'translateX(0px)';
    }
    const icon = swipeIconRefs.current.get(id);
    if (icon) {
      icon.style.transition = `opacity ${SWIPE_SNAP_BACK_MS}ms ease-out, transform ${SWIPE_SNAP_BACK_MS}ms ease-out`;
      icon.style.opacity = '0';
      icon.style.transform = 'scale(0.7)';
    }
    cancelPendingSnapBack();
    snapBackTimerRef.current = window.setTimeout(() => {
      snapBackTimerRef.current = null;
      const done = messageRefs.current.get(id);
      if (done) {
        done.style.transition = '';
        done.style.transform = '';
      }
      // Unmounting the icon is the one render the *end* of a gesture costs.
      setSwipingId((cur) => (cur === id ? null : cur));
    }, SWIPE_SNAP_BACK_MS + 50);
  }

  /** Shared tail for pointerup and pointercancel: release the capture taken
   *  at engage, and hand back the gesture that was in flight (already
   *  cleared) so each caller can apply its own policy about firing the
   *  reply. */
  function endSwipeGesture(e: React.PointerEvent) {
    const swipe = swipeGestureRef.current;
    swipeGestureRef.current = null;
    if (swipe?.engaged) {
      try {
        if (e.currentTarget.hasPointerCapture(swipe.pointerId)) e.currentTarget.releasePointerCapture(swipe.pointerId);
      } catch {
        // Already released by the browser (the normal case on pointerup) —
        // nothing to undo.
      }
    }
    return swipe;
  }

  function onBubblePointerUp(e: React.PointerEvent) {
    clearLongPressTimer();
    longPressStartRef.current = null;

    const swipe = endSwipeGesture(e);
    if (!swipe?.engaged) return;
    // A long-press can't have fired mid-swipe (engaging cancels its
    // timer), but the click that follows this pointerup still needs
    // swallowing — otherwise the tap-through would open the viewer/toggle
    // selection right after the drag.
    suppressClickRef.current = true;
    // Read off the ref, never off React state: the last pointermove's paint
    // is already on the DOM, but its render may not have committed, which is
    // the flick-does-nothing defect described on `swipingId`.
    if (Math.abs(swipe.travel) >= SWIPE_REPLY_THRESHOLD_PX) startReply(swipe.msg);
    snapBack(swipe.msg.id);
  }

  function onBubblePointerCancel(e: React.PointerEvent) {
    // Browser-interrupted gesture (e.g. an edge-swipe took over) — abort
    // with no side effects, same posture as MediaViewer's pointer-cancel
    // handlers. The block still has to be put back where it was, though.
    clearLongPressTimer();
    longPressStartRef.current = null;
    const swipe = endSwipeGesture(e);
    if (swipe?.engaged) snapBack(swipe.msg.id);
  }

  /** @param hasMediaTap — true when this block's tap is already owned by
   *  `openViewer`/`openStack` (bare media single blocks, and stacks) — those
   *  fire from the inner `<img>`/stack `onClick`, which runs *before* this
   *  wrapper's `onClick` (target before ancestor) and already runs its own
   *  double-tap-to-react check (see `handleTap`). Without this flag, a tap on
   *  bare media would double-count as two taps (inner + wrapper bubbling). */
  function onBubbleClick(e: React.MouseEvent, msgs: Message[], hasMediaTap: boolean) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const m = msgs[0];
    // Neither a still-sending nor a failed bubble has a normal tap action —
    // failed's only affordance is the dedicated "tap to retry" label inside
    // it, which stops propagation before this handler ever sees the click
    // (docs/RECEIPTS.md §5.4).
    if (!m || isLocalId(m.id)) return;
    // Selection mode disables stacking, so a clickable block is always a
    // single message here.
    if (selectionMode) {
      if (e.shiftKey && selectionAnchorId) {
        selectRange(selectionAnchorId, m.id);
        return;
      }
      toggleSelect(m.id);
      return;
    }
    // Double-tap-to-react on plain text/voice blocks (no media tap already
    // owns this click) — see `handleTap`'s file-header note on the
    // deliberate ~250ms delay.
    if (!hasMediaTap) handleTap(m, () => {});
  }

  function sendDraft() {
    // Edit mode owns the composer's submit action entirely while active —
    // see `submitEdit`. `Composer`'s Enter-to-send/Update-button both funnel
    // through this same `onSend` prop.
    if (editing) {
      void submitEdit();
      return;
    }
    // docs/MEDIA_ATTACHMENTS.md §5.1/D1 — staged attachments own Send now:
    // the composer text becomes the album's caption (or no caption at all),
    // not a separate text message.
    if (attachments.length > 0) {
      void sendAlbum();
      return;
    }
    if (!draft.trim()) return;
    const replyToId = replyingTo?.id;
    const replyPreview = replyingTo ? buildReplyPreview(replyingTo) : undefined;
    sendMessage(chat.id, draft, replyToId, replyPreview);
    setDraft('');
    setReplyingTo(null);
  }

  /** docs/GIFS.md §6 — "picking is sending" (D4): no staging, no caption, no
   *  confirm step. Deliberately does NOT touch `draft`, so a half-typed
   *  message survives a trip through the picker; it does consume `replyingTo`,
   *  because replying with a GIF is a normal thing to want. */
  function handlePickGif(gif: GifSearchItem) {
    sendGif(
      chat.id,
      { slug: gif.slug, width: gif.width, height: gif.height, title: gif.title },
      replyingTo?.id,
      replyingTo ? buildReplyPreview(replyingTo) : undefined,
    );
    setReplyingTo(null);
  }

  /** docs/MEDIA_ATTACHMENTS.md §5.1 — attach button / paste both land here
   *  after `Composer` gathers the raw picked `File`s; validation
   *  (kind/size/`MediaLimits.maxAttachments`) lives once, centrally, via
   *  `stageFiles` (lib/media.ts), shared with `AttachmentSheet`'s own "+"
   *  tile so the two entry points can never drift on what's accepted. */
  function handleAddFiles(files: File[]) {
    const { accepted, error } = stageFiles(files, attachments.length);
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    if (error) setUploadError(error);
  }

  function handleRemoveAttachment(localId: string) {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }

  function handleUpdateAttachmentTags(localId: string, updater: (tags: string[]) => string[]) {
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, tags: updater(a.tags) } : a)));
  }

  /** Replaces staged items with the outcome of an upload/retry round: drops
   *  everything that succeeded (it's a real sent message now) and keeps only
   *  the still-failed ones staged, refreshed with whatever mint info they
   *  should retry against next (docs §5.1 "a failed send keeps the tray").
   *  Items in `attachments` that weren't part of this round (shouldn't
   *  normally happen — `results` always covers the attempted set) pass
   *  through untouched. */
  function settleAttachments(
    results: { localId: string; ok: boolean; mediaId: string; presignedPutUrl: string; requiredContentType: string }[],
  ): number {
    const byId = new Map(results.map((r) => [r.localId, r]));
    setAttachments((prev) =>
      prev.flatMap((a) => {
        const r = byId.get(a.localId);
        if (!r) return [a];
        if (r.ok) return [];
        return [{ ...a, status: 'failed' as const, progress: 0, mediaId: r.mediaId, presignedPutUrl: r.presignedPutUrl, requiredContentType: r.requiredContentType }];
      }),
    );
    return results.filter((r) => !r.ok).length;
  }

  /** Send with attachments staged (docs §5.1/§4.4): one mint call for every
   *  staged item plus the composer's draft as caption and the pending reply,
   *  then serial PUT+complete (lib/media.ts's `uploadAlbum`). The message
   *  itself arrives back over WS — `message.new` for the first item to
   *  complete, `media.ready` for the rest (§4.4) — this function never
   *  hand-inserts it into the query cache. */
  async function sendAlbum() {
    if (sendingAlbumRef.current) return; // see `sendingAlbumRef` — repeated Send taps must not re-send the tray
    sendingAlbumRef.current = true;
    const items = attachments;
    const caption = draft;
    const replyToId = replyingTo?.id;
    const replyToMsg = replyingTo;
    setUploadError('');
    setDraft('');
    setReplyingTo(null);
    setAttachments((prev) => prev.map((a) => ({ ...a, status: 'uploading' as const, progress: 0 })));
    try {
      const outcome = await uploadAlbum(
        chat.id,
        items.map((a) => ({ localId: a.localId, file: a.file, kind: a.kind, mime: a.file.type, tags: a.tags })),
        caption,
        replyToId,
        (index, pct, total) => setUpload({ index: index + 1, total, progress: pct }),
      );
      const failedCount = settleAttachments(outcome.items);
      if (failedCount === 0) {
        failedAlbumMessageIdRef.current = null;
      } else {
        failedAlbumMessageIdRef.current = outcome.messageId;
        setUploadError(
          failedCount === items.length ? 'Upload failed — try again' : `${failedCount} of ${items.length} failed — retry or discard`,
        );
      }
    } catch {
      // The mint call itself failed — nothing was created server-side, so
      // there's nothing to discard, but the user's caption/reply/files must
      // not vanish (docs §5.1: "do not lose the user's files").
      setDraft(caption);
      if (replyToMsg) setReplyingTo(replyToMsg);
      setAttachments((prev) => prev.map((a) => ({ ...a, status: 'failed' as const, progress: 0 })));
      failedAlbumMessageIdRef.current = null;
      setUploadError('Upload failed — try again');
    } finally {
      sendingAlbumRef.current = false;
      setUpload(null);
    }
  }

  /** Retries every currently-failed staged item. Re-PUTs to the still-valid
   *  presigned URL (no re-mint — same message row) unless the server says it
   *  expired (§5.1's 10 min TTL), in which case the still-failing items are
   *  re-minted as a brand-new album and the orphaned old message is
   *  soft-deleted. */
  async function retryAlbum() {
    const retryable = attachments.filter((a) => a.status === 'failed' && a.mediaId && a.presignedPutUrl && a.requiredContentType);
    if (retryable.length === 0) return;
    if (sendingAlbumRef.current) return; // same in-flight guard as `sendAlbum` — Retry is just as tappable twice
    sendingAlbumRef.current = true;
    setUploadError('');
    setAttachments((prev) => prev.map((a) => (retryable.some((f) => f.localId === a.localId) ? { ...a, status: 'uploading' as const, progress: 0 } : a)));
    try {
      let results = await retryAlbumItems(
        retryable.map((a) => ({
          localId: a.localId,
          file: a.file,
          tags: a.tags,
          mediaId: a.mediaId!,
          presignedPutUrl: a.presignedPutUrl!,
          requiredContentType: a.requiredContentType!,
        })),
        (index, pct, total) => setUpload({ index: index + 1, total, progress: pct }),
      );
      const expired = results.filter((r) => r.expired);
      if (expired.length > 0) {
        const oldMessageId = failedAlbumMessageIdRef.current;
        const toRemint = attachments.filter((a) => expired.some((r) => r.localId === a.localId));
        const remint = await uploadAlbum(
          chat.id,
          toRemint.map((a) => ({ localId: a.localId, file: a.file, kind: a.kind, mime: a.file.type, tags: a.tags })),
          undefined,
          undefined,
          (index, pct, total) => setUpload({ index: index + 1, total, progress: pct }),
        );
        if (oldMessageId) void deleteMessages(chat.id, [oldMessageId]).catch(() => {});
        failedAlbumMessageIdRef.current = remint.messageId;
        results = results.filter((r) => !r.expired).concat(remint.items);
      }
      const failedCount = settleAttachments(results);
      if (failedCount === 0) {
        failedAlbumMessageIdRef.current = null;
        setUploadError('');
      } else {
        setUploadError(`${failedCount} failed — retry or discard`);
      }
    } catch {
      setAttachments((prev) => prev.map((a) => (retryable.some((f) => f.localId === a.localId) ? { ...a, status: 'failed' as const, progress: 0 } : a)));
      setUploadError('Retry failed — try again');
    } finally {
      sendingAlbumRef.current = false;
      setUpload(null);
    }
  }

  /** Gives up on every currently-failed staged item, soft-deleting the
   *  orphaned album message they belonged to through the existing delete
   *  route (docs §5.1/§6 "Discard soft-deletes the album message"). */
  function discardAlbum() {
    const messageId = failedAlbumMessageIdRef.current;
    setAttachments((prev) => prev.filter((a) => a.status !== 'failed'));
    setUploadError('');
    failedAlbumMessageIdRef.current = null;
    if (messageId) void deleteMessages(chat.id, [messageId]).catch(() => {});
  }

  /** Hands a finished recording (UI-8e — `Composer`'s state machine) off to
   *  `lib/media.ts`'s `uploadVoice` — voice is completely unchanged by
   *  staging (docs §5.1): push-to-talk still sends immediately and is never
   *  staged. No caption: the mic/recording bar only exists while the
   *  composer's text is empty. */
  function handleRecordingComplete(blob: Blob, mime: string) {
    const replyToId = replyingTo?.id;
    if (replyToId) setReplyingTo(null);
    setUploadError('');
    setUpload({ index: 1, total: 1, progress: 0, label: 'voice message' });
    void uploadVoice(chat.id, blob, mime, replyToId, (pct) => setUpload({ index: 1, total: 1, progress: pct, label: 'voice message' }))
      .then((outcome) => {
        if (outcome.items.some((r) => !r.ok)) setUploadError('Upload failed — try again');
      })
      .catch(() => setUploadError('Upload failed — try again'))
      .finally(() => setUpload(null));
  }

  /** True when a tap on media should be ignored because it belongs to the
   *  selection/long-press gesture instead. Selection mode swallows taps for
   *  select/toggle (opening the full-screen viewer mid-selection would be a
   *  dead end and disrupts the gesture); the suppression flag is the same one
   *  the wrapper's onClick applies, re-checked here because MediaBubble and
   *  MediaStack put their own onClick on the inner <img>/<div>, which fires
   *  BEFORE the wrapper's (target before ancestor) — without this, a
   *  long-press on an image opened the viewer on top of the action sheet.
   *  Deliberately does not reset the flag — onBubbleClick still owns that,
   *  and runs immediately after this. */
  function mediaTapSuppressed(): boolean {
    return selectionMode || suppressClickRef.current;
  }

  function openViewer(m: Message) {
    if (mediaTapSuppressed()) return;
    const media = m.media[0];
    if (media?.status === 'ready' && (media.kind === 'image' || media.kind === 'video')) {
      handleTap(m, () => setViewer({ list: [media], index: 0 }));
    }
  }

  /** docs/MEDIA_ATTACHMENTS.md §5.3 — tap on one of an album's visible
   *  mosaic tiles: opens the viewer straight at that item, stepping through
   *  the *whole* album via prev/next (no grid-sheet detour — the mosaic
   *  already shows what you're picking, unlike a legacy fan). */
  function openAlbumViewer(m: Message, index: number) {
    if (mediaTapSuppressed()) return;
    handleTap(m, () => setViewer({ list: m.media, index }));
  }

  /** The "+N" overflow tile on a 7–10 item album — reuses the same
   *  `MediaGridSheet` a legacy fan's tap opens (see `openStack`/
   *  `gridSheetItems`). */
  function openAlbumOverflow(m: Message) {
    if (mediaTapSuppressed()) return;
    // Routed through `handleTap` like every other media tap: without it the
    // FIRST tap of a double-tap opened the grid sheet, and the second landed
    // on whatever tile was under the finger — so double-tapping "+N" opened
    // an image instead of reacting (owner report, 2026-08-12).
    handleTap(m, () => setGridSheetItems(m.media));
  }

  /** docs/EMBEDS.md §4.4 — tap-action for a bare embed card. Only
   *  'external' exists in Phase 1/2 (the only registered resolver,
   *  Instagram, always sets it); 'read'/'portal' are Phase 3/4 and
   *  intentionally no-op here until those surfaces exist. Same
   *  `handleTap`/double-tap-to-react wrapping as `openViewer`. */
  function openEmbed(m: Message) {
    if (mediaTapSuppressed()) return;
    const embed = m.embed;
    if (!embed) return;
    handleTap(m, () => {
      if (embed.actionType === 'external' && embed.canonicalUrl) {
        window.open(embed.canonicalUrl, '_blank', 'noopener,noreferrer');
      }
    });
  }

  function openStack(msgs: Message[]) {
    if (mediaTapSuppressed()) return;
    const lead = msgs[0];
    if (!lead) return;
    // A double-tap on a stack reacts to its lead (top) message — there's no
    // single "the stack" to attach a reaction to on the wire, same reasoning
    // as excluding stacks from swipe-to-reply/the focus menu above.
    handleTap(lead, () => setGridSheetItems(msgs.flatMap((m) => (m.media[0] ? [m.media[0]] : []))));
  }

  /** Post-MVP double-tap-to-react: delays a bubble tap's normal single-tap
   *  action (`performSingleAction` — opening the viewer, or nothing for a
   *  plain text/voice bubble) by `DOUBLE_TAP_MS`. If a second tap on the same
   *  message arrives before the delay elapses, it's read as a double-tap
   *  instead — the single action is cancelled and `❤️` is toggled. Disabled
   *  entirely in selection mode (callers gate that before calling this).
   *  ⚠️ Deliberate UX cost: media taps now open ~250ms later than an instant
   *  tap — the task explicitly accepts this latency in exchange for double-tap
   *  working "anywhere on a bubble, including media". */
  function handleTap(m: Message, performSingleAction: () => void) {
    const pending = pendingTapRef.current;
    if (pending && pending.id === m.id) {
      window.clearTimeout(pending.timer);
      pendingTapRef.current = null;
      toggleReaction(m, ReactionLimits.quickEmojis[0]);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingTapRef.current = null;
      performSingleAction();
    }, DOUBLE_TAP_MS);
    pendingTapRef.current = { id: m.id, timer };
  }

  function applyReactionToCache(messageId: string, emoji: string, action: 'add' | 'remove') {
    qc.setQueryData<MessagesCache>(['messages', chat.id], (old) =>
      withAllPages(old, (messages) =>
        messages.map((mm) =>
          mm.id === messageId
            ? {
                ...mm,
                reactions:
                  action === 'add'
                    ? applyReactionAdded(mm.reactions, emoji, me.id, me.id)
                    : applyReactionRemoved(mm.reactions, emoji, me.id, me.id),
              }
            : mm,
        ),
      ),
    );
  }

  /** Optimistic reaction toggle (post-MVP) — mirrors how a failed send rolls
   *  its optimistic bubble back. Marks the pending-dedup key *before* the
   *  cache update so the WS echo of this exact call (see `lib/realtime.tsx`)
   *  can never race ahead of it. */
  function toggleReaction(m: Message, emoji: string) {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.mine ?? false;
    const action: 'add' | 'remove' = mine ? 'remove' : 'add';
    const key = reactionPendingKey(m.id, emoji, action);
    notePendingReaction(key);
    applyReactionToCache(m.id, emoji, action);

    const rest = action === 'add' ? addReaction(chat.id, m.id, emoji) : removeReaction(chat.id, m.id, emoji);
    rest.catch(() => {
      // The REST call never succeeded, so no confirming WS frame is coming —
      // drop the pending marker (nothing to dedup against) and undo the
      // optimistic change by applying its inverse.
      clearPendingReaction(key);
      applyReactionToCache(m.id, emoji, action === 'add' ? 'remove' : 'add');
      setActionError('Reaction failed — try again');
    });
  }

  return (
    // Desktop's search panel is a flex sibling of the message column, not an
    // overlay (docs/MESSAGE_SEARCH.md §4.3) — the outer row only matters when
    // it's open; with it closed (or on mobile, where search is a `fixed`
    // overlay instead, unaffected by this row) the single child just fills
    // the width as before.
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {selectionMode ? (
        <header
          className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-3"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
        >
          <button
            onClick={exitSelectionMode}
            aria-label="Cancel selection"
            className="flex shrink-0 items-center text-text-secondary"
            style={{ touchAction: 'manipulation' }}
          >
            <X size={20} />
          </button>
          <div className="flex-1 text-sm font-semibold text-text-primary">{selectedIds.size} selected</div>
          <button
            onClick={handleBulkCopy}
            disabled={!canCopySelection}
            aria-label="Copy selected"
            className="flex shrink-0 items-center text-text-secondary disabled:opacity-40"
            style={{ touchAction: 'manipulation' }}
          >
            <Copy size={18} />
          </button>
          <button
            onClick={() => void handleBulkDelete()}
            disabled={!allSelectedMine}
            aria-label="Delete selected"
            title={!allSelectedMine ? 'Only your own messages can be deleted' : undefined}
            className="flex shrink-0 items-center text-red-600 disabled:text-text-muted disabled:opacity-40 dark:text-red-400"
            style={{ touchAction: 'manipulation' }}
          >
            <Trash2 size={18} />
          </button>
        </header>
      ) : (
        <ScreenHeader
          title={name}
          subtitle={chat.isGroup ? `${chat.members.length} members` : undefined}
          onBack={onBack}
          trailing={
            <>
              <button
                onClick={() => setSearchState((s) => ({ ...s, panelOpen: true }))}
                aria-label="Search messages"
                className="flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400"
                style={{ touchAction: 'manipulation' }}
              >
                <Search size={16} />
              </button>
              <button
                onClick={onOpenGallery}
                aria-label="Gallery"
                className="flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400"
                style={{ touchAction: 'manipulation' }}
              >
                <Images size={16} />
                Gallery
              </button>
              <button
                onClick={() => setStageOpen(true)}
                aria-label="Stage"
                className="flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400"
                style={{ touchAction: 'manipulation' }}
              >
                <Layers size={16} />
                Stage
              </button>
            </>
          }
        />
      )}

      {actionError && (
        <p className="border-b border-border bg-surface-raised px-4 py-2 text-xs text-red-600 dark:text-red-400">
          {actionError}
        </p>
      )}

      {/* `relative` wrapper so the "loading older" strip can hang over the
          scroller instead of sitting inside its flow — see below. `min-h-0`
          is what lets the scroller actually scroll inside this flex column. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Out of flow on purpose (owner report, 2026-08-23): as an in-flow
          first child this strip appeared the moment a fetch started, pushing
          the whole list down a line, and vanished again as the page landed —
          two visible shifts around a prepend that is otherwise seamless.
          `sticky`/in-flow have the same problem; only taking it out of flow
          leaves the scroll position untouched. */}
      {isFetchingNextPage && (
        <div className="pointer-events-none absolute inset-x-0 top-1.5 z-20 flex justify-center">
          <p className="rounded-pill bg-surface-raised px-2.5 py-1 text-xs text-text-muted shadow-sm">
            Loading older messages…
          </p>
        </div>
      )}
      <div
        ref={scrollerRef}
        onScroll={onScrollerScroll}
        className="flex-1 overflow-y-auto px-4 py-3"
        // Browser scroll anchoring fights `prependRef`'s restore: Chrome
        // already shifts `scrollTop` by the height of the prepended page, then
        // the layout effect adds the same delta again, so an older page landed
        // with the reader flung a page further down (owner report,
        // 2026-08-23). Safari has no scroll anchoring at all, so the manual
        // restore has to stay — this just makes Chrome stop double-correcting.
        //
        // `overscroll-behavior-y: contain` stops a pull past the top of the
        // history from *chaining* out to the viewport, where it becomes
        // Chrome's pull-to-refresh and reloads the PWA (owner report). The
        // `overscroll-behavior: none` on html/body in index.css does not cover
        // this: that governs the viewport's own scroller, not what an inner
        // scroll region hands outward when it hits its limit. The exposure is
        // worst in exactly the moment reported — `loadOlder()` fires at
        // `scrollTop < 300` and until that page lands this element is pinned at
        // its limit, so every further pull chains. `contain` rather than `none`
        // so the scroller keeps its own rubber-band feel; only the chain is cut.
        style={{ overflowAnchor: 'none', overscrollBehaviorY: 'contain' }}
      >
        {isLoading && <p className="text-center text-sm text-text-muted">Loading…</p>}
        {!isLoading && messages.length === 0 && (
          <p className="flex items-center justify-center gap-1.5 text-center text-sm text-text-muted">
            Say hi <Hand size={16} />
          </p>
        )}

        {/* Runs are separated by a real gap; bubbles *inside* a run sit 2px
            apart so a burst of messages reads as one connected block, with
            the tail drawn only on the run's last bubble (UI-7). Date/time
            dividers (UI-8b) interleave between runs. */}
        <div ref={contentRef} className="flex flex-col gap-3">
          {timeline.map((item) =>
            item.kind === 'divider' ? (
              <TimelineDivider key={item.id} label={item.label} />
            ) : (
              <RunGroup
                key={item.run.key}
                run={item.run}
                chat={chat}
                me={me}
                introIds={introIds}
                selectedIds={selectedIds}
                highlightId={highlightId}
                selectionMode={selectionMode}
                isMobile={isMobile}
                registerRef={(id, el) => {
                  if (el) messageRefs.current.set(id, el);
                  else messageRefs.current.delete(id);
                }}
                onOpenActions={openActionMenu}
                onOpenViewer={openViewer}
                onOpenAlbumViewer={openAlbumViewer}
                onOpenAlbumOverflow={openAlbumOverflow}
                onOpenEmbed={openEmbed}
                onOpenStack={openStack}
                onReply={startReply}
                onToggleReaction={toggleReaction}
                onJumpToMessage={jumpToMessage}
                swipingId={swipingId}
                registerSwipeIcon={(id, el) => {
                  if (el) swipeIconRefs.current.set(id, el);
                  else swipeIconRefs.current.delete(id);
                }}
                onPointerDownBlock={onBubblePointerDown}
                onPointerMoveBlock={onBubblePointerMove}
                onPointerUpBlock={onBubblePointerUp}
                onPointerCancelBlock={onBubblePointerCancel}
                onClickBlock={onBubbleClick}
                receipts={receiptDerivation}
                onRetryFailed={retrySend}
                gifFavorites={gifFavorites}
              />
            ),
          )}
        </div>
      </div>
      </div>

      {undoIds && (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-raised px-4 py-2.5 text-sm">
          <span className="text-text-secondary">
            {undoIds.length === 1 ? 'Message deleted' : `${undoIds.length} messages deleted`}
          </span>
          <button
            onClick={() => void handleUndo()}
            className="shrink-0 font-semibold text-indigo-600 dark:text-indigo-400"
            style={{ touchAction: 'manipulation' }}
          >
            Undo
          </button>
        </div>
      )}

      {upload && (
        <div className="border-t border-border bg-surface-raised px-4 py-2.5 text-xs text-text-secondary">
          {upload.total > 1 ? `Uploading ${upload.index} of ${upload.total}` : `Uploading ${upload.label ?? 'attachment'}`}
          … {upload.progress}%
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
            <div
              className="h-full rounded-pill bg-accent transition-[width]"
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        </div>
      )}
      {uploadError && (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-raised px-4 py-2 text-xs text-red-600 dark:text-red-400">
          <span>{uploadError}</span>
          {/* docs/MEDIA_ATTACHMENTS.md §5.1 — "a failed send keeps the tray":
              failed items stay staged with a retry affordance right here,
              never silently dropped. */}
          {attachments.some((a) => a.status === 'failed') && (
            <span className="flex shrink-0 gap-3">
              <button onClick={() => void retryAlbum()} className="font-semibold text-indigo-600 dark:text-indigo-400" style={{ touchAction: 'manipulation' }}>
                Retry
              </button>
              <button onClick={discardAlbum} className="font-semibold text-red-600 dark:text-red-400" style={{ touchAction: 'manipulation' }}>
                Discard
              </button>
            </span>
          )}
        </div>
      )}

      <TypingLine typers={typers} chat={chat} />

      {editing ? (
        <EditingBar message={editing} onCancel={cancelEdit} />
      ) : (
        replyingTo && <ReplyPreviewBar message={replyingTo} chat={chat} meId={me.id} onCancel={() => setReplyingTo(null)} />
      )}

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={sendDraft}
        attachments={attachments}
        onAddFiles={handleAddFiles}
        onRemoveAttachment={handleRemoveAttachment}
        onOpenAttachment={setAttachmentSheetFor}
        onInputFocus={handleComposerFocus}
        uploading={!!upload}
        onRecordingComplete={handleRecordingComplete}
        onError={setUploadError}
        isMobile={isMobile}
        gifsEnabled={me.gifsEnabled}
        onPickGif={handlePickGif}
        editing={!!editing}
      />

      {attachmentSheetFor && (
        <AttachmentSheet
          attachments={attachments}
          focusedId={attachmentSheetFor}
          chatId={chat.id}
          onClose={() => setAttachmentSheetFor(null)}
          onUpdateTags={handleUpdateAttachmentTags}
          onAddFiles={handleAddFiles}
        />
      )}

      {gridSheetItems && (
        <MediaGridSheet
          items={gridSheetItems.map((media) => ({ media, thumbUrl: media.thumbUrl ?? media.url ?? undefined }))}
          onClose={() => setGridSheetItems(null)}
          onPick={(index) => setViewer({ list: gridSheetItems, index })}
        />
      )}

      {viewerMedia && (
        <MediaViewer
          media={viewerMedia}
          chatId={chat.id}
          onClose={() => setViewer(null)}
          // Prev/next only exist when the viewer was opened from a stack —
          // a lone bubble has nothing to step through.
          onPrev={viewer && viewer.index > 0 ? () => setViewer({ ...viewer, index: viewer.index - 1 }) : undefined}
          onNext={
            viewer && viewer.index < viewer.list.length - 1
              ? () => setViewer({ ...viewer, index: viewer.index + 1 })
              : undefined
          }
          tags={viewerTags.data?.tags ?? []}
          onAddTag={(nameRaw) => void addTag(viewerMedia.id, nameRaw).then(() => void viewerTags.refetch())}
          onRemoveTag={(tagId) => void removeTag(viewerMedia.id, tagId).then(() => void viewerTags.refetch())}
          // docs/GALLERY_FILMSTRIP.md §5.3 — an album (or a legacy fan's grid
          // sheet) is a real list worth striping; a lone chat photo is a
          // one-item list and `MediaFilmstrip` renders nothing for it. No
          // lazy-load props: everything here is already loaded.
          items={viewer ? viewer.list.map((m) => ({ id: m.id, thumbUrl: m.thumbUrl, sensitivity: m.sensitivity })) : []}
          index={viewer?.index ?? 0}
          onSelect={(i) => viewer && setViewer({ ...viewer, index: i })}
        />
      )}

      {actionMenuFor && (
        <MessageFocusMenu
          key={actionMenuFor.message.id}
          message={actionMenuFor.message}
          rect={actionMenuFor.rect}
          sourceEl={actionMenuFor.sourceEl}
          me={me}
          onClose={() => setActionMenuFor(null)}
          onReply={(m) => {
            setActionMenuFor(null);
            startReply(m);
          }}
          onReact={(m, emoji) => {
            setActionMenuFor(null);
            toggleReaction(m, emoji);
          }}
          onCopy={handleMenuCopy}
          onSelect={(m) => enterSelectionMode([m])}
          onDelete={(m) => void handleMenuDelete(m)}
          onEdit={(m) => {
            setActionMenuFor(null);
            startEdit(m);
          }}
          onDiscard={(m) => {
            setActionMenuFor(null);
            discardFailed(m.id);
          }}
          favorited={menuGifState?.favorited}
          onFavorite={
            menuGifState
              ? (m) => {
                  setActionMenuFor(null);
                  gifFavorites.toggle(m);
                }
              : undefined
          }
        />
      )}
      </div>

      {!isMobile && searchState.panelOpen && (
        <MessageSearchPanel
          chatId={chat.id}
          members={chat.members}
          searchState={searchState}
          onChangeSearchState={setSearchState}
          onClose={() => setSearchState((s) => ({ ...s, panelOpen: false }))}
          onJumpToMessage={jumpFromSearchResult}
        />
      )}

      {isMobile && searchState.panelOpen && (
        <MessageSearchOverlay
          chatId={chat.id}
          members={chat.members}
          searchState={searchState}
          onChangeSearchState={setSearchState}
          onClose={() => setSearchState((s) => ({ ...s, panelOpen: false }))}
          onJumpToMessage={jumpFromSearchResult}
        />
      )}

      {/* Stage (docs/EMBEDS.md §6.2) — same desktop-panel-vs-mobile-overlay
          split as search above, deliberately mutually exclusive with search
          in practice (a user only opens one header action at a time) but not
          enforced as such: nothing breaks if both happen to be open. */}
      {!isMobile && stageOpen && <StagePanel chatId={chat.id} onClose={() => setStageOpen(false)} />}
      {isMobile && stageOpen && <StageOverlay chatId={chat.id} onClose={() => setStageOpen(false)} />}
    </div>
  );
}

/** Reply preview bar between the upload/error banners and `<Composer>` —
 *  shows what the next send will reply to, with a cancel (X) button. Body
 *  text gets a short truncated snippet; bare media falls back to the same
 *  label used for the outgoing `ReplyPreview` (`buildReplyPreview`, above). */
function ReplyPreviewBar({
  message,
  chat,
  meId,
  onCancel,
}: {
  message: Message;
  chat: ChatSummary;
  meId: string;
  onCancel: () => void;
}) {
  const senderName =
    message.senderId === meId ? 'You' : (chat.members.find((mem) => mem.id === message.senderId)?.displayName ?? 'Unknown');
  const preview = message.body ? message.body : mediaReplyLabel(message);
  return (
    <div
      className="flex items-start gap-2 border-t border-border bg-surface-raised px-4 py-2"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="w-1 shrink-0 self-stretch rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-accent">{senderName}</p>
        <p className="truncate text-xs text-text-secondary">{preview}</p>
      </div>
      <button
        onClick={onCancel}
        aria-label="Cancel reply"
        className="shrink-0 text-text-muted"
        style={{ touchAction: 'manipulation' }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Edit bar between the upload/error banners and `<Composer>`
 *  (docs/MESSAGE_EDIT.md §4.2/4.3) — same slot/pattern as `ReplyPreviewBar`
 *  above (a separate component rather than a generalization of it: the
 *  content differs enough — no sender attribution, just "Editing message" +
 *  the original body — that sharing one component would need more branching
 *  than it'd save). */
function EditingBar({ message, onCancel }: { message: Message; onCancel: () => void }) {
  return (
    <div
      className="flex items-start gap-2 border-t border-border bg-surface-raised px-4 py-2"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="w-1 shrink-0 self-stretch rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-accent">Editing message</p>
        <p className="truncate text-xs text-text-secondary">{message.body}</p>
      </div>
      <button
        onClick={onCancel}
        aria-label="Cancel edit"
        className="shrink-0 text-text-muted"
        style={{ touchAction: 'manipulation' }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Centered muted date/time label between runs (UI-8b request D) — "4:23 PM"
 *  for a same-day gap, a date ("Yesterday" / weekday / "MMM D") at a
 *  calendar-day boundary. Sentence case, not uppercase (a judgment call —
 *  the reference showed an uppercase treatment; this repo's other
 *  micro-copy, e.g. the bottom-sheet's "Copy"/"Select"/"Delete", is
 *  sentence-case throughout, so this follows that instead of introducing a
 *  one-off ALL-CAPS style). */
function TimelineDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-1">
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}

/**
 * One run's column of blocks — same sender, grouped by `groupMessages`
 * (docs/archive/UI_REVAMP.md UI-7). Factored out of `ChatView`'s render when UI-8b
 * added the interleaved timeline (dividers now sit between these, so the
 * per-run JSX needed a name to key/map over rather than living inline in a
 * single `runs.map`).
 */
function RunGroup({
  run,
  chat,
  me,
  introIds,
  selectedIds,
  highlightId,
  selectionMode,
  isMobile,
  registerRef,
  onOpenActions,
  onOpenViewer,
  onOpenAlbumViewer,
  onOpenAlbumOverflow,
  onOpenEmbed,
  onOpenStack,
  onReply,
  onToggleReaction,
  onJumpToMessage,
  swipingId,
  registerSwipeIcon,
  onPointerDownBlock,
  onPointerMoveBlock,
  onPointerUpBlock,
  onPointerCancelBlock,
  onClickBlock,
  receipts,
  onRetryFailed,
  gifFavorites,
}: {
  run: MessageRun;
  chat: ChatSummary;
  me: MeResponse;
  introIds: Set<string>;
  selectedIds: Set<string>;
  highlightId: string | null;
  selectionMode: boolean;
  isMobile: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  onOpenActions: (m: Message) => void;
  onOpenViewer: (m: Message) => void;
  /** docs/MEDIA_ATTACHMENTS.md §5.3 — tap on one of an album's visible
   *  mosaic tiles, `ChatView.openAlbumViewer`. */
  onOpenAlbumViewer: (m: Message, index: number) => void;
  /** The "+N" overflow tile, `ChatView.openAlbumOverflow`. */
  onOpenAlbumOverflow: (m: Message) => void;
  /** docs/EMBEDS.md §4.4 — the embed analogue of `onOpenViewer`, wired the
   *  same way (`ChatView.openEmbed`). */
  onOpenEmbed: (m: Message) => void;
  onOpenStack: (msgs: Message[]) => void;
  /** Post-MVP: sets `ChatView`'s `replyingTo` — wired into the desktop hover
   *  bar's Reply button here. */
  onReply: (m: Message) => void;
  /** Post-MVP: `ChatView.toggleReaction` — wired into reaction pills. */
  onToggleReaction: (m: Message, emoji: string) => void;
  /** Post-MVP: scroll+highlight a quoted message's original — see
   *  `ChatView.jumpToMessage`. */
  onJumpToMessage: (id: string) => void;
  /** Post-MVP: which block (if any) is mid swipe-to-reply and how far, so
   *  only that one block's `MessageBlockRow` applies a live translateX. */
  /** The one block (by lead message id) with a swipe-to-reply gesture on it,
   *  or null — see `ChatView.swipingId`'s doc comment for why the live offset
   *  is not state. */
  swipingId: string | null;
  registerSwipeIcon: (id: string, el: HTMLDivElement | null) => void;
  onPointerDownBlock: (e: React.PointerEvent, msgs: Message[], mine: boolean) => void;
  onPointerMoveBlock: (e: React.PointerEvent) => void;
  onPointerUpBlock: (e: React.PointerEvent) => void;
  onPointerCancelBlock: (e: React.PointerEvent) => void;
  onClickBlock: (e: React.MouseEvent, msgs: Message[], hasMediaTap: boolean) => void;
  /** docs/RECEIPTS.md §3/§5.4 — resolved per-block below (own messages
   *  only). */
  receipts: ReceiptDerivation;
  onRetryFailed: (failedId: string) => void;
  /** docs/GIF_FAVORITES.md §8.1 — one object rather than an
   *  onFavorite/favorited pair, so this already-wide prop chain grows by one. */
  gifFavorites: GifFavoriteApi;
}) {
  const mine = run.senderId === me.id;
  const senderName = chat.members.find((mem) => mem.id === run.senderId)?.displayName ?? 'Unknown';

  return (
    <div className={'flex max-w-[78%] flex-col gap-[2px] ' + (mine ? 'items-end self-end' : 'items-start self-start')}>
      {chat.isGroup && !mine && <p className="px-1 pb-0.5 text-xs font-semibold text-text-secondary">{senderName}</p>}
      {run.blocks.map((block, bi) => {
        // Receipts only ever render on my own messages (docs/RECEIPTS.md §1)
        // — a stack resolves against every message it contains (not just its
        // first), since the "newest of mine" a member's watermark clamps to
        // can be any item inside it.
        const blockIds = mine ? blockMessages(block).map((mm) => mm.id) : [];
        const blockSeenAvatars = blockIds.flatMap((id) => receipts.seenAvatars.get(id) ?? []);
        const blockStatus = mine && receipts.status && blockIds.includes(receipts.status.messageId) ? receipts.status : null;

        return (
          <MessageBlockRow
            key={blockMessages(block)[0]!.id}
            block={block}
            chat={chat}
            mine={mine}
            isRunHead={bi === 0}
            isRunTail={bi === run.blocks.length - 1}
            intro={blockMessages(block).some((m) => introIds.has(m.id))}
            selectedIds={selectedIds}
            highlightId={highlightId}
            selectionMode={selectionMode}
            // Hover bar (UI-8c) is desktop-only, single-message blocks only
            // (a stack has no addressable single-message action — see the
            // stack doc comment in lib/messageGroups.ts), and hidden entirely
            // during multi-select (docs/archive/UI8_CHAT_INSTAGRAM.md §4 cross-cutting
            // rule — selection mode owns bubble taps instead).
            showActionsButton={!isMobile && !selectionMode && block.kind === 'single'}
            registerRef={registerRef}
            onOpenActions={onOpenActions}
            onOpenViewer={onOpenViewer}
            onOpenAlbumViewer={onOpenAlbumViewer}
            onOpenAlbumOverflow={onOpenAlbumOverflow}
            onOpenEmbed={onOpenEmbed}
            onOpenStack={onOpenStack}
            onReply={onReply}
            onToggleReaction={onToggleReaction}
            onJumpToMessage={onJumpToMessage}
            swiping={swipingId === blockMessages(block)[0]!.id}
            registerSwipeIcon={registerSwipeIcon}
            onPointerDownBlock={onPointerDownBlock}
            onPointerMoveBlock={onPointerMoveBlock}
            onPointerUpBlock={onPointerUpBlock}
            onPointerCancelBlock={onPointerCancelBlock}
            onClickBlock={onClickBlock}
            seenAvatars={blockSeenAvatars}
            status={blockStatus}
            onRetryFailed={onRetryFailed}
            gifFavorites={gifFavorites}
          />
        );
      })}
    </div>
  );
}

/**
 * One block within a run (docs/archive/UI_REVAMP.md UI-7) — either a single message
 * or a fanned stack of adjacent bare photos/videos.
 *
 * Corner rounding follows the block's position within its run (UI-8b
 * request B — "cleaner run corners"), on the *sender's* side only (right for
 * `mine`, left for others; the opposite side always stays fully
 * `rounded-lg`):
 *  - **head** (first block): top rounded (nothing sits above it), bottom
 *    tightened (a connector into the next block).
 *  - **middle**: both corners tightened.
 *  - **tail** (last block): top tightened, bottom tightened — the same
 *    small nub corner runs always had.
 *  A single-message run is both head and tail simultaneously, which
 *  resolves to exactly the pre-UI-8b behavior (top rounded, bottom
 *  tightened) — no special case needed. In other words: the sender-side
 *  bottom corner is *always* tightened (either as an inner connector or the
 *  run's tail nub — same 4px value either way), and the sender-side top
 *  corner is tightened for every block except the run's head.
 *
 * Two rules do the rest of the visual work here, unchanged since UI-7:
 *  - **Photos and videos get no bubble at all.** They're drawn bare,
 *    Instagram-style; a caption (if any) becomes its own small bubble
 *    underneath rather than a padded strip inside a container around the
 *    image. Voice is the exception — it stays in a bubble and inherits its
 *    color via `currentColor`.
 *  - The whole block is one pointer target (long-press/selection), so a
 *    stack's long-press can select all of the messages it covers at once.
 */
function MessageBlockRow({
  block,
  chat,
  mine,
  isRunHead,
  isRunTail: _isRunTail,
  intro,
  selectedIds,
  highlightId,
  selectionMode,
  showActionsButton,
  registerRef,
  onOpenActions,
  onOpenViewer,
  onOpenAlbumViewer,
  onOpenAlbumOverflow,
  onOpenEmbed,
  onOpenStack,
  onReply,
  onToggleReaction,
  onJumpToMessage,
  swiping,
  registerSwipeIcon,
  onPointerDownBlock,
  onPointerMoveBlock,
  onPointerUpBlock,
  onPointerCancelBlock,
  onClickBlock,
  seenAvatars,
  status,
  onRetryFailed,
  gifFavorites,
}: {
  block: MessageBlock;
  chat: ChatSummary;
  mine: boolean;
  isRunHead: boolean;
  /** Kept for callers' documentation/future use (see the corner-rounding
   *  doc above — every block's bottom sender-side corner is tightened
   *  regardless of tail-ness, so this isn't read directly here), not
   *  because the position concept doesn't matter. */
  isRunTail: boolean;
  /** UI-8a — plays the bubble-in animation once, on first render as "new". */
  intro: boolean;
  selectedIds: Set<string>;
  highlightId: string | null;
  selectionMode: boolean;
  showActionsButton: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  onOpenActions: (m: Message) => void;
  onOpenViewer: (m: Message) => void;
  onOpenAlbumViewer: (m: Message, index: number) => void;
  onOpenAlbumOverflow: (m: Message) => void;
  onOpenEmbed: (m: Message) => void;
  onOpenStack: (msgs: Message[]) => void;
  onReply: (m: Message) => void;
  onToggleReaction: (m: Message, emoji: string) => void;
  onJumpToMessage: (id: string) => void;
  /** True while this block is the one under a swipe-to-reply gesture, which
   *  is what mounts the reveal icon below. The live *offset* is painted
   *  straight onto the DOM by `ChatView.paintSwipe` and never arrives as a
   *  prop — see `ChatView.swipingId` for why. */
  swiping: boolean;
  /** Hands the reveal icon's node up to `ChatView`, the same way `registerRef`
   *  hands up the block's, so `paintSwipe` can drive its fade/scale. */
  registerSwipeIcon: (id: string, el: HTMLDivElement | null) => void;
  onPointerDownBlock: (e: React.PointerEvent, msgs: Message[], mine: boolean) => void;
  onPointerMoveBlock: (e: React.PointerEvent) => void;
  onPointerUpBlock: (e: React.PointerEvent) => void;
  onPointerCancelBlock: (e: React.PointerEvent) => void;
  onClickBlock: (e: React.MouseEvent, msgs: Message[], hasMediaTap: boolean) => void;
  /** docs/RECEIPTS.md §3/§5.4 — resolved by `RunGroup` across every message
   *  this block covers; empty/null on anyone else's messages. */
  seenAvatars: PublicUser[];
  status: { messageId: string; kind: 'sent' | 'delivered' } | null;
  onRetryFailed: (failedId: string) => void;
  gifFavorites: GifFavoriteApi;
}) {
  const msgs = blockMessages(block);
  const m = msgs[0]!;
  const isStack = block.kind === 'stack';
  // `pending` gates the "still sending" opacity + hides the desktop hover
  // actions row — deliberately NOT `isLocalId`: a `failed:` message needs
  // that hover row's "More" button to stay reachable (docs/RECEIPTS.md
  // §5.4's Discard-only focus menu), and dimming it like an in-flight send
  // would read as "still trying" instead of "this one didn't go through".
  const pending = isPendingId(m.id);
  const failed = !isStack && isFailedId(m.id);
  const selected = msgs.some((mm) => selectedIds.has(mm.id));
  const highlighted = msgs.some((mm) => mm.id === highlightId);

  // docs/MEDIA_ATTACHMENTS.md §5.3/D2 — a message now carries an ARRAY of
  // media (0, 1, or 2+ = an album). `singleMedia` is set only for the
  // exactly-one-item case; `isAlbum` for 2+.
  const singleMedia = !isStack && m.media.length === 1 ? m.media[0]! : null;
  const isAlbum = !isStack && m.media.length > 1;
  const isVoice = singleMedia?.kind === 'voice';
  const hasBody = !!m.body;
  // Embeds keep their exact pre-existing behavior — always bare, with a
  // separate caption bubble below when there's a body (docs/EMBEDS.md §4.4,
  // out of scope for the media captioned-container redesign below).
  const embedBare = !isStack && m.embed !== null;
  // A single non-voice media item with NO caption stays bare, unchanged
  // (§5.3 "uncaptioned single media: unchanged"). WITH a caption it becomes
  // the new merged container (`captionedMedia`) instead — deliberately
  // excluded from `bare` and from the classic text-bubble path below, since
  // today's "bare media + a separate small caption bubble underneath" is
  // exactly the "two objects" look D3 replaces.
  const bareMedia = !isStack && singleMedia !== null && singleMedia.kind !== 'voice' && !hasBody;
  const captionedMedia = !isStack && singleMedia !== null && singleMedia.kind !== 'voice' && hasBody;
  const bare = bareMedia || embedBare;
  // The classic text/voice bubble — not for albums (their own `AlbumCard`
  // carries the caption strip) and not for captioned single media (its own
  // merged container carries it); otherwise unchanged: voice always gets a
  // bubble (even captionless), plain text always does, and an embed's
  // caption still rides in a bubble underneath it exactly as before.
  const showBubble = !isStack && !isAlbum && !captionedMedia && (!bare || hasBody);
  // A stack has no single addressable message to quote (see the same
  // exclusion on the swipe/focus-menu reply affordances above). Bare media,
  // an album, and captioned media all render their quote as its own
  // standalone card above the media/card (no bubble to sit inline inside).
  const quote = !isStack && m.replyTo ? m.replyTo : null;
  const standaloneQuote = bare || isAlbum || captionedMedia;
  // Bare media, an album, captioned media, and stacks all already own their
  // tap via `onOpenViewer`/`openAlbumViewer`/`onOpenStack` (each does its own
  // double-tap-to-react check) — the wrapper's `onClick` skips redoing it for
  // those so one physical tap doesn't get read as two (see
  // `ChatView.onBubbleClick`'s doc comment).
  const hasMediaTap = isStack || bare || isAlbum || captionedMedia;
  // A stack has no single addressable message for a pill row either — same
  // exclusion as the quote above.
  const reactions = !isStack ? m.reactions : [];

  // docs/GIF_FAVORITES.md §8.1 / D-F5 — the star joins the existing hover bar
  // instead of overlaying the GIF's corner, so a GIF bubble keeps exactly one
  // hover affordance. Null (and therefore no star) for every message that
  // isn't a ready inline GIF.
  const gifFavoriteState = gifFavorites.stateFor(m);
  const actionsButton = showActionsButton && !pending && (
    <MessageActions
      onMore={() => onOpenActions(m)}
      onReply={() => onReply(m)}
      onReact={() => onOpenActions(m)}
      onlyMore={failed}
      favorited={gifFavoriteState?.favorited}
      onFavorite={gifFavoriteState ? () => gifFavorites.toggle(m) : undefined}
    />
  );

  // docs/MESSAGE_EDIT.md §4.5 — small muted "edited" label beside the bubble
  // on the side facing screen center (owner feedback, 2026-07-22, twice
  // revised: below-the-bubble added vertical height; then row-level inline
  // centered against bubble+reaction-pills together instead of the bubble
  // alone; then bubble-centered, which the owner revised to bottom-hugging).
  // Absolutely positioned inside a `relative` wrapper (the bubble div for
  // `showBubble`; a dedicated `relative` wrapper around `AlbumCard`/the
  // captioned-media container otherwise, docs/MEDIA_ATTACHMENTS.md §5.3),
  // hanging out past its edge and hugging its bottom (`bottom-0.5` keeps it
  // just off the rounded corner) — adds no layout size anywhere, and rides
  // along with swipe-to-reply translation for free. An edited message always
  // has a non-empty body, so it always lands in exactly one of those three
  // slots — and never a stack (stacks can't be edited, see the doc above).
  const editedLabel = !isStack && m.editedAt && (
    <span
      className={
        'pointer-events-none absolute bottom-0.5 whitespace-nowrap text-[10px] text-text-muted ' +
        (mine ? 'right-full mr-1.5' : 'left-full ml-1.5')
      }
      title={formatSendTime(m.editedAt)}
    >
      edited
    </span>
  );

  return (
    <div className={'group relative flex items-center gap-1 ' + (mine ? 'justify-end' : 'justify-start')}>
      {mine && actionsButton}
      {/* Swipe-to-reply reveal icon — fades/scales in with drag progress and
          "fills in" (muted → accent) once past the fire threshold. Sits in
          the gutter behind the block's resting position (the side opposite
          the drag direction, matching iMessage), so it never affects layout. */}
      {swiping && (
        <div
          ref={(el) => {
            registerSwipeIcon(m.id, el);
          }}
          className={
            // `inset-y-0` + `my-auto` centers a fixed-height absolutely
            // positioned box regardless of whether this wrapper's height is
            // "definite" for percentage purposes — `top-1/2` + `-translate-y-1/2`
            // was resolving `top: 50%` against the wrong box (an auto-height
            // flex container), landing the icon well above the bubble's true
            // center instead of centered on it (including bare media, which
            // has no bubble padding to hide the miss).
            //
            // Mounts at rest (opacity 0, the muted palette) and is then driven
            // entirely by `ChatView.paintSwipe`, which writes opacity/scale and
            // toggles the armed colour classes. Nothing here re-renders during
            // the drag, so no value on this element may come from a prop that
            // changes with travel.
            'pointer-events-none absolute inset-y-0 z-0 my-auto grid h-8 w-8 place-items-center rounded-pill ' +
            'bg-surface-sunken text-text-muted transition-colors ' +
            (mine ? 'right-0' : 'left-0')
          }
          style={{ opacity: 0, transform: 'scale(0.7)' }}
        >
          <ReplyIcon size={16} />
        </div>
      )}
      <div
        ref={(el) => {
          // Every message the block covers points at the same element, so
          // jump-to-message can scroll to a photo inside a stack.
          for (const mm of msgs) registerRef(mm.id, el);
        }}
        onPointerDown={(e) => onPointerDownBlock(e, msgs, mine)}
        onPointerMove={onPointerMoveBlock}
        onPointerUp={onPointerUpBlock}
        onPointerCancel={onPointerCancelBlock}
        onClick={(e) => onClickBlock(e, msgs, hasMediaTap)}
        className={
          'relative z-10 flex min-w-0 max-w-full flex-col gap-[2px] rounded-md ' +
          (mine ? 'items-end ' : 'items-start ') +
          (highlighted ? 'ring-2 ring-amber-400 ' : '') +
          (selected ? 'ring-2 ring-indigo-500 ' : '') +
          (pending && bare ? 'opacity-60 ' : '') +
          (intro ? 'animate-bubble-in ' : '')
        }
        style={{
          touchAction: 'manipulation',
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          // NOTE: `transform` and `transition` are deliberately absent here,
          // and must stay absent. Swipe-to-reply writes both straight onto
          // this node (`ChatView.paintSwipe` / `snapBack`) so a drag costs no
          // re-renders — and React only clears style properties it set itself,
          // so listing either one here would make any unrelated re-render
          // mid-gesture (an arriving message, a receipt landing) wipe the
          // offset out from under the finger.
          //
          // Keeping `transition` off the React path also preserves the
          // property that made it correct before: it exists on exactly one
          // block, for exactly the length of one snap-back. An unconditional
          // `transition: transform` on every bubble was assumed to be a
          // harmless no-op until real Android PWA testing showed it was enough
          // to promote every bubble onto its own compositor layer, which then
          // ignored the focus menu's z-index entirely (2026-07-22 — see
          // BACKBONE §15).
        }}
      >
        {/* Bare media, an album, and captioned media all share this
            standalone quote slot just above the card — none of them have a
            bubble to render it inline inside (docs/MEDIA_ATTACHMENTS.md
            §5.3). */}
        {quote && standaloneQuote && <QuotedBlock replyTo={quote} chat={chat} mine={mine} standalone onJump={onJumpToMessage} />}
        {isStack && <MediaStack messages={msgs} onOpen={() => onOpenStack(msgs)} />}
        {bare &&
          (m.embed ? (
            <EmbedCard message={m} onOpen={() => onOpenEmbed(m)} interactive={!selectionMode} />
          ) : (
            <MediaBubble media={singleMedia!} onOpen={() => onOpenViewer(m)} interactive={!selectionMode} />
          ))}
        {/* docs §5.3 — an album's mosaic card, with its own caption strip
            appended when the message has a body. Wrapped in its own
            `relative` div so `editedLabel` (computed once, below) can anchor
            to this card's own bottom edge, same as every other slot. */}
        {isAlbum && (
          <div className="relative">
            <AlbumCard
              media={m.media}
              body={m.body}
              mine={mine}
              isRunHead={isRunHead}
              interactive={!selectionMode}
              onOpenViewer={(index) => onOpenAlbumViewer(m, index)}
              onCaptionClick={(e) => {
                e.stopPropagation();
                onClickBlock(e, msgs, false);
              }}
              onOpenOverflow={() => onOpenAlbumOverflow(m)}
            />
            {editedLabel}
          </div>
        )}
        {/* docs §5.3 D3 — captioned single media: ONE container (media flush
            to the top/sides, caption strip below in the bubble fill), not a
            bare photo with a separate bubble hanging under it. Container
            radius = the radius bare media uses today (`rounded-md`), with
            the same run-position corner tightening the classic bubble uses
            moved onto this container instead. */}
        {captionedMedia && (
          <div className="relative">
            <div
              className={
                'overflow-hidden rounded-md ' +
                (isRunHead ? '' : mine ? 'rounded-tr-[4px] ' : 'rounded-tl-[4px] ') +
                (mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]')
              }
            >
              {/* The image loses its own radius here (`rounded={false}`) —
                  this container's `overflow-hidden` clips it instead, which
                  is what makes the photo + caption read as one object. */}
              <MediaBubble media={singleMedia!} onOpen={() => onOpenViewer(m)} interactive={!selectionMode} rounded={false} />
              {/* The caption strip is NOT a media tap — routing its clicks
                  back through `onClickBlock` with `hasMediaTap: false` gives
                  it the same double-tap-to-react and selection-toggle
                  behavior a plain text bubble has. Without this the strip was
                  inert, because the block wrapper skips its own tap handling
                  whenever the block owns a media tap (owner report,
                  2026-08-12). `stopPropagation` keeps the wrapper from also
                  firing, which would toggle selection twice. */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onClickBlock(e, msgs, false);
                }}
                className={'px-3.5 py-2 text-sm ' + (mine ? 'bg-accent text-white' : 'bg-surface-sunken text-text-primary')}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            </div>
            {editedLabel}
          </div>
        )}
        {showBubble && (
          <div
            className={
              'relative min-w-0 max-w-full rounded-lg text-sm ' +
              (isVoice ? 'px-2 py-1.5 ' : 'px-3.5 py-2 ') +
              // Run-position corner rounding (UI-8b) — see the file-level
              // doc comment above for the head/middle/tail derivation.
              (isRunHead ? '' : mine ? 'rounded-tr-[4px] ' : 'rounded-tl-[4px] ') +
              (mine ? 'rounded-br-[4px] ' : 'rounded-bl-[4px] ') +
              (mine
                ? 'bg-accent text-white ' + (pending ? 'opacity-60 ' : '')
                : 'bg-surface-sunken text-text-primary ')
            }
          >
            {/* Not standalone, so this is a text and/or voice bubble — the
                quote renders inline, above whatever the bubble already
                holds. */}
            {quote && <QuotedBlock replyTo={quote} chat={chat} mine={mine} standalone={false} onJump={onJumpToMessage} />}
            {isVoice && singleMedia && (
              <MediaBubble media={singleMedia} onOpen={() => onOpenViewer(m)} interactive={!selectionMode} />
            )}
            {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
            {editedLabel}
          </div>
        )}

        {/* Reaction pills (post-MVP) — a row that grazes the bubble's bottom
            edge, aligned to the sender's side. Placed *inside* this flex-col
            so it stacks as an extra row after the media/bubble rather than
            fighting the run-corner layout above.

            This overlapped the bubble once before and was reverted: a blanket
            negative margin put the pills at the block's outer edge, which on
            bare media (no bubble padding to absorb it) is live image content,
            not a corner. The overlap is back because it's what the owner
            wants, but constrained two ways so it lands on the corner nub
            instead of the picture:
              - `REACTION_OVERLAP_PX` (6) is a graze, not a half-overlap — a
                ~22px pill still clears the bubble by ~16px.
              - `REACTION_EDGE_INSET_PX` (10) pulls the row in from the
                sender's edge, so the overlapping sliver sits over the
                tightened run corner rather than the middle of the frame.
            The matching `paddingBottom` gives the height back: without it the
            negative margin shortens the block and the next run creeps up,
            changing vertical rhythm everywhere reactions happen to exist. */}
        {reactions.length > 0 && (
          <div
            className={'z-10 flex flex-wrap gap-1 ' + (mine ? 'justify-end' : 'justify-start')}
            style={{
              marginTop: -REACTION_PULL_UP_PX,
              paddingBottom: REACTION_PULL_UP_PX,
              marginRight: mine ? REACTION_EDGE_INSET_PX : undefined,
              marginLeft: mine ? undefined : REACTION_EDGE_INSET_PX,
            }}
          >
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleReaction(m, r.emoji);
                }}
                aria-pressed={r.mine}
                // Opaque, and the same neutral as an incoming bubble on BOTH
                // sides of the chat (owner revision 2026-08-24) — a translucent
                // accent fill read as a smudge once the row started overlapping
                // the bubble instead of clearing it. "Did I react" survives as a
                // tint on the shadow rather than a solid accent border, so the
                // two states differ without either of them growing a hard edge.
                className={
                  'flex items-center gap-1 rounded-pill bg-surface-sunken px-2 py-0.5 text-xs ' +
                  'text-text-secondary transition-shadow ' +
                  (r.mine ? 'shadow-reaction-mine' : 'shadow-reaction')
                }
                style={{ touchAction: 'manipulation' }}
              >
                <span>{r.emoji}</span>
                {/* A lone reactor is already implied by the pill existing, so
                    the count only appears once it says something the pill
                    doesn't — i.e. from 2 up. Deliberately NOT conditioned on
                    DM-vs-group: a 2-member chat simply never reaches 3, so the
                    same rule covers both and PROJECT.md §15's "never
                    special-case DMs" stays intact. */}
                {r.count > 1 && <span className="tabular-nums">{r.count}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Delivery status / seen avatars / failed-send (docs/RECEIPTS.md §1/
            §5.4) — own messages only, same below-block slot as the reaction
            pills above. Mutually exclusive by construction: `seenAvatars`
            and `status` are derived (lib/receipts.ts) so a message never has
            both, and a `failed:` message never has either (it's excluded
            from the derivation entirely — nothing server-side to report). */}
        {mine && failed && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetryFailed(m.id);
            }}
            className="mt-0.5 text-left text-[10px] text-red-600 dark:text-red-400"
            style={{ touchAction: 'manipulation' }}
          >
            Failed to send — tap to retry
          </button>
        )}
        {/* 2-member chats: the only possible seer is the one other person,
            so an avatar identifying them is redundant — plain "Seen" reads
            better (owner revision 2026-07-23). Keyed on member count, not
            `isGroup` — the same presentation-only precedent as DM display
            names (chatDisplayName), so the "never special-case DMs"
            invariant (PROJECT.md §15) stays untouched. */}
        {mine && !failed && seenAvatars.length > 0 && chat.members.length <= 2 && (
          <span className="mt-0.5 text-[10px] text-text-muted">Seen</span>
        )}
        {mine && !failed && seenAvatars.length > 0 && chat.members.length > 2 && (
          <div className="mt-0.5 flex items-center gap-0.5">
            {seenAvatars.slice(0, 3).map((u) => (
              <div
                key={u.id}
                title={u.displayName}
                className="grid h-4 w-4 place-items-center rounded-pill bg-accent text-[8px] font-semibold text-white ring-1 ring-surface"
              >
                {u.displayName.charAt(0).toUpperCase()}
              </div>
            ))}
            {seenAvatars.length > 3 && <span className="text-[10px] text-text-muted">+{seenAvatars.length - 3}</span>}
          </div>
        )}
        {mine && !failed && seenAvatars.length === 0 && status && (
          <span className="mt-0.5 text-[10px] text-text-muted">{status.kind === 'delivered' ? 'Delivered' : 'Sent'}</span>
        )}
      </div>
      {!mine && actionsButton}
    </div>
  );
}

/** The small quoted-original block a reply renders above its content
 *  (docs/archive/UI8_CHAT_INSTAGRAM.md-style "reply strip"). Two visual modes:
 *  - **embedded** (`standalone=false`) — sits inline atop a bubble's
 *    content, tinted to read as part of that bubble (translucent white on
 *    the accent-filled `mine` bubble, a faint tint on the sunken "theirs"
 *    bubble).
 *  - **standalone** (`standalone=true`) — bare media has no bubble to sit
 *    inside, so this renders as its own small card directly above the media.
 *  Tapping jumps to the original via `onJump` (`ChatView.jumpToMessage`);
 *  disabled when the original was deleted, since there's nothing to jump to. */
function QuotedBlock({
  replyTo,
  chat,
  mine,
  standalone,
  onJump,
}: {
  replyTo: NonNullable<Message['replyTo']>;
  chat: ChatSummary;
  mine: boolean;
  standalone: boolean;
  onJump: (id: string) => void;
}) {
  const senderName = chat.members.find((mem) => mem.id === replyTo.senderId)?.displayName ?? 'Unknown';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!replyTo.deleted) onJump(replyTo.id);
      }}
      disabled={replyTo.deleted}
      className={
        'mb-1 flex max-w-full items-start gap-1.5 rounded-sm border-l-2 px-2 py-1 text-left text-xs ' +
        (standalone
          ? 'border-accent bg-surface-sunken text-text-secondary'
          : mine
            ? 'border-white/50 bg-white/10 text-white/90'
            : 'border-accent/70 bg-black/[0.04] text-text-secondary dark:bg-white/[0.06]')
      }
      style={{ touchAction: 'manipulation' }}
    >
      {/* `line-clamp-2 break-words`, never `truncate`: `truncate` implies
          `white-space: nowrap`, which makes this block's min-content width the
          whole preview string. Ancestors sized to fit their content then
          reported that as their minimum and the bubble ran off the side of the
          screen (owner report, 2026-08-23). Wrapping keeps min-content down to
          one word, and the clamp caps a long quote at two lines. */}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{senderName}</p>
        <p className={'line-clamp-2 break-words ' + (replyTo.deleted ? 'italic opacity-80' : '')}>
          {replyTo.deleted ? 'Original deleted' : replyTo.preview}
        </p>
      </div>
    </button>
  );
}

/**
 * "Alex is typing…" (docs/TYPING_INDICATORS.md §3).
 *
 * ⚠️ Fixed height whether or not anyone is typing. The alternative — render
 * nothing when idle — makes the message list jump by a line every time someone
 * starts or stops, right under the reader's thumb. That is the same rule the
 * edited-indicator work settled on, for the same reason.
 *
 * Names come from `chat.members`, already in the client cache; a typing frame
 * never triggers a fetch.
 */
function TypingLine({ typers, chat }: { typers: string[]; chat: ChatSummary }) {
  const names = typers
    .map((id) => chat.members.find((m) => m.id === id)?.displayName)
    .filter((n): n is string => Boolean(n));

  let text = '';
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else if (names.length > 2) text = `${names.length} people are typing…`;

  return (
    <div
      className="h-4 shrink-0 truncate px-4 text-xs text-text-secondary"
      aria-live="polite"
    >
      {text}
    </div>
  );
}
