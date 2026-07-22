import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Hand, Images, Reply as ReplyIcon, Trash2, X } from 'lucide-react';
import type { ChatSummary, MediaInfo, MeResponse, Message, ReplyPreview } from '@den/shared';
import { flattenMessages, useMessages } from '../hooks/useMessages';
import { chatDisplayName, deleteMessages, markRead, restoreMessages } from '../lib/chats';
import { kindForMime, uploadMedia } from '../lib/media';
import { clearChatNotifications } from '../lib/push';
import { blockMessages, buildTimeline, groupMessages, type MessageBlock, type MessageRun } from '../lib/messageGroups';
import { addTag, removeTag } from '../lib/tags';
import { useRealtime } from '../lib/realtime';
import { useIsMobile } from '../hooks/useIsMobile';
import { useIntroIds } from '../hooks/useIntroIds';
import { useMediaTags } from '../hooks/useMediaTags';
import { useBackHandler } from '../lib/backStack';
import { Composer } from './Composer';
import { MediaBubble } from './MediaBubble';
import { MediaGridSheet, MediaStack } from './MediaStack';
import { MediaViewer } from './MediaViewer';
import { MessageActions } from './MessageActions';
import { MessageFocusMenu } from './MessageFocusMenu';
import { ScreenHeader } from './ScreenHeader';

/** `index`/`total` are 1-based positions within one multi-file pick — each
 *  file is still its own upload and its own message (UI-7). */
type UploadState = { kind: 'image' | 'video' | 'voice'; progress: number; index: number; total: number } | null;

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

// Swipe-to-reply gesture thresholds (mobile) — grouped here for later
// real-device tuning, same convention as Composer.tsx's gesture constants.
const SWIPE_REPLY_ENGAGE_PX = 12; // px of horizontal travel before we commit to a horizontal swipe over a vertical scroll/long-press
const SWIPE_REPLY_MAX_PX = 72; // clamp — how far the block can visually travel
const SWIPE_REPLY_THRESHOLD_PX = 56; // release past this to fire the reply
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

/** Builds the `ReplyPreview` carried on an outgoing reply — a short text
 *  snippet for text messages, a media label otherwise. Mirrors the server's
 *  own preview shape (`ReplyPreview.preview`, "<=120 chars") without a
 *  second round-trip. */
function buildReplyPreview(m: Message): ReplyPreview {
  const preview = m.body ? m.body.slice(0, 120) : m.media ? MEDIA_REPLY_LABEL[m.media.kind] : '';
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
   *  survives either kind of remount. See docs/UI_REVAMP.md §8. */
  initialDraft: string;
  onDraftChange: (draft: string) => void;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(chat.id);
  const { sendMessage } = useRealtime();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [draft, setDraftState] = useState(initialDraft);
  // Every write mirrors into AuthedApp's per-chat cache (see prop doc above)
  // in addition to updating local state for this render.
  function setDraft(value: string) {
    setDraftState(value);
    onDraftChange(value);
  }
  const [upload, setUpload] = useState<UploadState>(null);
  const [uploadError, setUploadError] = useState('');
  const [viewer, setViewer] = useState<ViewerState>(null);
  // Messages of the stack whose grid sheet is open (UI-7). Held as messages,
  // not media, so picking a tile can seed the viewer in stack order.
  const [stackSheet, setStackSheet] = useState<Message[] | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const jumpedRef = useRef(false);
  const name = chatDisplayName(chat, me.id);

  // Post-MVP: the message the composer is currently replying to (the reply
  // bar above `<Composer>` renders from this), null when not replying.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // Live swipe-to-reply drag state — which block (by its lead message id) is
  // currently being dragged and how far, so `MessageBlockRow` can apply a
  // live `translateX` to exactly that block. Only one gesture can be active
  // at a time (a single pointer), so this is a single slot, not a map.
  const [swipeState, setSwipeState] = useState<{ id: string; dx: number } | null>(null);
  // Per-gesture bookkeeping for the currently pressed block, set at
  // pointerdown and read/mutated on pointermove — a plain ref (like
  // Composer's `gestureRef`) since it doesn't itself need to trigger a
  // render; `swipeState` above is what drives the visual frame.
  const swipeGestureRef = useRef<{ msg: Message; mine: boolean; startX: number; startY: number; engaged: boolean } | null>(
    null,
  );

  // Multi-select + deletion (Stage 6 / §2 item 11, docs/MESSAGE_DELETE.md §4).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  // System back gesture / browser back cancels selection mode (matches the X
  // in the selection header) before it would unwind the chat → chat list.
  // Registered after AuthedApp's view handler, so LIFO exits selection first.
  useBackHandler(selectionMode, () => exitSelectionMode());
  // The message the focus menu (UI-8d — Copy/Select/Delete + send time) is
  // currently open for, plus what was captured at open time for the lift
  // animation. Was `Message | null` pre-UI-8, when this drove a plain
  // bottom-sheet with no shared-element animation to feed.
  const [actionMenuFor, setActionMenuFor] = useState<ActionMenuState>(null);
  const [actionError, setActionError] = useState('');
  const [undoIds, setUndoIds] = useState<string[] | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  // Long-press bookkeeping: a plain 500ms timer with move-slop cancellation
  // (docs/MESSAGE_DELETE.md §4 — deliberately NOT setPointerCapture, which
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
  const viewerMedia = viewer ? (viewer.list[viewer.index] ?? null) : null;
  // Tags for whatever the viewer is showing. Per the UI-7 decision, tagging
  // stays a viewing-time action (never part of the send path) — this just
  // makes the existing gallery TagEditor reachable straight from a chat
  // bubble instead of only via the gallery screen.
  const viewerTags = useMediaTags(viewerMedia?.id ?? null);
  const selectedMessages = messages.filter((m) => selectedIds.has(m.id));
  const allSelectedMine = selectedMessages.length > 0 && selectedMessages.every((m) => m.senderId === me.id);
  const canCopySelection = selectedMessages.some((m) => m.body);

  // Mark the newest message read once it's loaded/changes — cheap and matches
  // "open the chat = you've seen it" (BACKBONE §5 last_read_message_id).
  useEffect(() => {
    if (lastMessageId && !lastMessageId.startsWith('pending:')) {
      void markRead(chat.id, lastMessageId).then(() => qc.invalidateQueries({ queryKey: ['chats'] }));
    }
  }, [chat.id, lastMessageId, qc]);

  // Clear this chat's already-shown notifications when it becomes the active
  // chat — on mount/chat switch, and again if the tab/PWA regains visibility
  // while it's still open (returning to an already-open chat).
  useEffect(() => {
    clearChatNotifications(chat.id);
    const onVisible = () => {
      if (document.visibilityState === 'visible') clearChatNotifications(chat.id);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [chat.id]);

  useEffect(() => {
    if (!jumpToMessageId) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.id, messages.length, jumpToMessageId]);

  // Keyset pagination is newest-first, so an older target message may not be
  // in the first page yet — keep paging back until it shows up (or we run
  // out of history). Runs once per jump target.
  useEffect(() => {
    if (!jumpToMessageId || jumpedRef.current) return;
    const found = messages.some((m) => m.id === jumpToMessageId);
    if (found) {
      jumpedRef.current = true;
      messageRefs.current.get(jumpToMessageId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightId(jumpToMessageId);
      setTimeout(() => setHighlightId(null), 2000);
    } else if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [jumpToMessageId, messages, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Undo toast is purely client-side (~10s, docs/MESSAGE_DELETE.md §4) — make
  // sure navigating away from this chat can't leave a stray timer firing
  // setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  }

  /** Takes a list, not a single message, because long-pressing a fanned stack
   *  selects every message it covers — a stack is a drawing of N messages,
   *  never an addressable unit of its own (docs/UI_REVAMP.md UI-7). Entering
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
    setSelectedIds(new Set(ids.slice(lo, hi + 1).filter((id) => !id.startsWith('pending:'))));
  }

  function showUndoToast(ids: string[]) {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    // A second delete while a toast is live replaces it, it doesn't stack —
    // the earlier deletion is still undoable via the API, just not via this
    // toast anymore (docs/MESSAGE_DELETE.md §4).
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
   *  through one place. */
  function startReply(m: Message) {
    setReplyingTo(m);
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

  // Long-press → focus menu (or, if already selecting, a direct toggle — see
  // docs/MESSAGE_DELETE.md §4's "long-press when already in selection mode").
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
    if (!m || m.id.startsWith('pending:')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      // Stacks (msgs.length > 1) skip the single-message focus menu: Copy
      // and Delete are per-message, so the useful gesture is "select all of
      // these", which also expands the stack back into individual bubbles.
      if (selectionMode) toggleSelect(m.id);
      else if (msgs.length > 1) enterSelectionMode(msgs);
      else openActionMenu(m);
    }, LONG_PRESS_MS);

    // Stacks are excluded — a stack has no single addressable message to
    // attach a reply to (the same reason it skips the focus menu above).
    // Mouse pointers skip it too: desktop already has the hover Reply
    // button, and a mouse-drag swipe isn't a gesture users expect there.
    swipeGestureRef.current =
      !selectionMode && msgs.length === 1 && e.pointerType !== 'mouse'
        ? { msg: m, mine, startX: e.clientX, startY: e.clientY, engaged: false }
        : null;
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
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > LONG_PRESS_SLOP_PX) {
          // Reads as a vertical scroll instead — hand the gesture back to
          // the list's own scrolling and the (still-running) long-press
          // timer/slop check below, rather than keep re-testing every move.
          swipeGestureRef.current = null;
        }
      }
      if (swipe.engaged) {
        const travel = swipeTravel(Math.abs(dx));
        setSwipeState({ id: swipe.msg.id, dx: swipe.mine ? -travel : travel });
        return; // engaged swipe owns this gesture — skip the long-press slop check below
      }
    }

    const start = longPressStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearLongPressTimer();
  }

  function onBubblePointerUp() {
    clearLongPressTimer();
    longPressStartRef.current = null;

    const swipe = swipeGestureRef.current;
    swipeGestureRef.current = null;
    if (swipe?.engaged) {
      // A long-press can't have fired mid-swipe (engaging cancels its
      // timer), but the click that follows this pointerup still needs
      // swallowing — otherwise the tap-through would open the viewer/toggle
      // selection right after the drag.
      suppressClickRef.current = true;
      const travel = swipeState && swipeState.id === swipe.msg.id ? Math.abs(swipeState.dx) : 0;
      if (travel >= SWIPE_REPLY_THRESHOLD_PX) startReply(swipe.msg);
    }
    setSwipeState(null);
  }

  function onBubblePointerCancel() {
    // Browser-interrupted gesture (e.g. an edge-swipe took over) — abort
    // with no side effects, same posture as MediaViewer's pointer-cancel handlers.
    clearLongPressTimer();
    longPressStartRef.current = null;
    swipeGestureRef.current = null;
    setSwipeState(null);
  }

  function onBubbleClick(e: React.MouseEvent, msgs: Message[]) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // Selection mode disables stacking, so a clickable block is always a
    // single message here.
    const m = msgs[0];
    if (!m || m.id.startsWith('pending:') || !selectionMode) return;
    if (e.shiftKey && selectionAnchorId) {
      selectRange(selectionAnchorId, m.id);
      return;
    }
    toggleSelect(m.id);
  }

  function sendDraft() {
    if (!draft.trim()) return;
    const replyToId = replyingTo?.id;
    const replyPreview = replyingTo ? buildReplyPreview(replyingTo) : undefined;
    sendMessage(chat.id, draft, replyToId, replyPreview);
    setDraft('');
    setReplyingTo(null);
  }

  /** Multi-pick (UI-7): each file is uploaded separately and becomes its own
   *  message — no batching exists on the wire. Consecutive ones simply *draw*
   *  as a fanned stack (lib/messageGroups.ts). Uploads run sequentially, not
   *  in parallel: the media pipeline is per-item anyway and a serial queue
   *  keeps the progress bar honest and phone radios/CPU from being hammered
   *  by N concurrent PUTs. */
  async function handleFilesPicked(picked: File[]) {
    if (picked.length === 0) return;

    const files = picked.flatMap((file) => {
      const kind = kindForMime(file.type);
      return kind === 'image' || kind === 'video' ? [{ file, kind }] : [];
    });
    if (files.length === 0) {
      setUploadError('Pick an image or video');
      return;
    }
    if (files.length < picked.length) setUploadError('Skipped files that were not an image or video');

    // Like the caption, a pending reply applies to the first uploaded item
    // only — cleared up front (optimistic, matching how `sendDraft` clears
    // the draft immediately rather than waiting on the upload to finish).
    const replyToId = replyingTo?.id;
    if (replyToId) setReplyingTo(null);

    let failed = 0;
    for (const [i, { file, kind }] of files.entries()) {
      // The composer's text rides along as a caption on the first item only —
      // repeating it on every message of a batch would read as spam.
      const ok = await runUpload(file, kind, file.type, i === 0 ? draft : '', i + 1, files.length, i === 0 ? replyToId : undefined);
      if (!ok) failed++;
    }
    if (failed > 0) {
      setUploadError(failed === files.length ? 'Upload failed — try again' : `${failed} of ${files.length} uploads failed`);
    }
  }

  async function runUpload(
    file: Blob,
    kind: 'image' | 'video' | 'voice',
    mime: string,
    caption: string,
    index = 1,
    total = 1,
    replyToId?: string,
  ): Promise<boolean> {
    if (index === 1) setUploadError('');
    setUpload({ kind, progress: 0, index, total });
    try {
      await uploadMedia(
        chat.id,
        file,
        kind,
        mime,
        caption,
        (pct) => setUpload({ kind, progress: pct, index, total }),
        replyToId,
      );
      if (caption) setDraft('');
      return true;
    } catch {
      return false;
    } finally {
      setUpload(null);
    }
  }

  /** Hands a finished recording (UI-8e — `Composer`'s state machine) off to
   *  the same `runUpload` path every other media kind already uses; this
   *  function is the entire bridge between the two, so the actual
   *  upload/transcode flow is not duplicated or rewritten. No caption: the
   *  mic/recording bar only exists while the composer's text is empty. */
  function handleRecordingComplete(blob: Blob, mime: string) {
    const replyToId = replyingTo?.id;
    if (replyToId) setReplyingTo(null);
    void runUpload(blob, 'voice', mime, '', 1, 1, replyToId).then((ok) => {
      if (!ok) setUploadError('Upload failed — try again');
    });
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
    if (m.media?.status === 'ready' && (m.media.kind === 'image' || m.media.kind === 'video')) {
      setViewer({ list: [m.media], index: 0 });
    }
  }

  function openStack(msgs: Message[]) {
    if (mediaTapSuppressed()) return;
    setStackSheet(msgs);
  }

  return (
    <div className="flex h-full flex-col">
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
            <button
              onClick={onOpenGallery}
              aria-label="Gallery"
              className="flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400"
              style={{ touchAction: 'manipulation' }}
            >
              <Images size={16} />
              Gallery
            </button>
          }
        />
      )}

      {actionError && (
        <p className="border-b border-border bg-surface-raised px-4 py-2 text-xs text-red-600 dark:text-red-400">
          {actionError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {hasNextPage && (
          <div className="mb-3 flex justify-center">
            <button
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="rounded-sm border border-border px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-sunken active:bg-surface-sunken disabled:opacity-60"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}

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
        <div className="flex flex-col gap-3">
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
                onOpenStack={openStack}
                onReply={startReply}
                onJumpToMessage={jumpToMessage}
                swipeState={swipeState}
                onPointerDownBlock={onBubblePointerDown}
                onPointerMoveBlock={onBubblePointerMove}
                onPointerUpBlock={onBubblePointerUp}
                onPointerCancelBlock={onBubblePointerCancel}
                onClickBlock={onBubbleClick}
              />
            ),
          )}
        </div>
        <div ref={bottomRef} />
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
          Uploading {upload.kind}
          {upload.total > 1 ? ` ${upload.index} of ${upload.total}` : ''}… {upload.progress}%
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
            <div
              className="h-full rounded-pill bg-accent transition-[width]"
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        </div>
      )}
      {uploadError && (
        <p className="border-t border-border bg-surface-raised px-4 py-2 text-xs text-red-600 dark:text-red-400">
          {uploadError}
        </p>
      )}

      {replyingTo && (
        <ReplyPreviewBar message={replyingTo} chat={chat} meId={me.id} onCancel={() => setReplyingTo(null)} />
      )}

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={sendDraft}
        onPickFiles={(files) => void handleFilesPicked(files)}
        uploading={!!upload}
        onRecordingComplete={handleRecordingComplete}
        onRecordingError={setUploadError}
        isMobile={isMobile}
      />

      {stackSheet && (
        <MediaGridSheet
          messages={stackSheet}
          onClose={() => setStackSheet(null)}
          onPick={(index) => {
            const list = stackSheet.flatMap((m) => (m.media ? [m.media] : []));
            setViewer({ list, index });
          }}
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
          onCopy={handleMenuCopy}
          onSelect={(m) => enterSelectionMode([m])}
          onDelete={(m) => void handleMenuDelete(m)}
        />
      )}
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
  const preview = message.body ? message.body : message.media ? MEDIA_REPLY_LABEL[message.media.kind] : '';
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
 * (docs/UI_REVAMP.md UI-7). Factored out of `ChatView`'s render when UI-8b
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
  onOpenStack,
  onReply,
  onJumpToMessage,
  swipeState,
  onPointerDownBlock,
  onPointerMoveBlock,
  onPointerUpBlock,
  onPointerCancelBlock,
  onClickBlock,
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
  onOpenStack: (msgs: Message[]) => void;
  /** Post-MVP: sets `ChatView`'s `replyingTo` — wired into the desktop hover
   *  bar's Reply button here. */
  onReply: (m: Message) => void;
  /** Post-MVP: scroll+highlight a quoted message's original — see
   *  `ChatView.jumpToMessage`. */
  onJumpToMessage: (id: string) => void;
  /** Post-MVP: which block (if any) is mid swipe-to-reply and how far, so
   *  only that one block's `MessageBlockRow` applies a live translateX. */
  swipeState: { id: string; dx: number } | null;
  onPointerDownBlock: (e: React.PointerEvent, msgs: Message[], mine: boolean) => void;
  onPointerMoveBlock: (e: React.PointerEvent) => void;
  onPointerUpBlock: () => void;
  onPointerCancelBlock: () => void;
  onClickBlock: (e: React.MouseEvent, msgs: Message[]) => void;
}) {
  const mine = run.senderId === me.id;
  const senderName = chat.members.find((mem) => mem.id === run.senderId)?.displayName ?? 'Unknown';

  return (
    <div className={'flex max-w-[78%] flex-col gap-[2px] ' + (mine ? 'items-end self-end' : 'items-start self-start')}>
      {chat.isGroup && !mine && <p className="px-1 pb-0.5 text-xs font-semibold text-text-secondary">{senderName}</p>}
      {run.blocks.map((block, bi) => (
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
          // during multi-select (docs/UI8_CHAT_INSTAGRAM.md §4 cross-cutting
          // rule — selection mode owns bubble taps instead).
          showActionsButton={!isMobile && !selectionMode && block.kind === 'single'}
          registerRef={registerRef}
          onOpenActions={onOpenActions}
          onOpenViewer={onOpenViewer}
          onOpenStack={onOpenStack}
          onReply={onReply}
          onJumpToMessage={onJumpToMessage}
          swipeDx={swipeState?.id === blockMessages(block)[0]!.id ? swipeState.dx : 0}
          onPointerDownBlock={onPointerDownBlock}
          onPointerMoveBlock={onPointerMoveBlock}
          onPointerUpBlock={onPointerUpBlock}
          onPointerCancelBlock={onPointerCancelBlock}
          onClickBlock={onClickBlock}
        />
      ))}
    </div>
  );
}

/**
 * One block within a run (docs/UI_REVAMP.md UI-7) — either a single message
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
  onOpenStack,
  onReply,
  onJumpToMessage,
  swipeDx,
  onPointerDownBlock,
  onPointerMoveBlock,
  onPointerUpBlock,
  onPointerCancelBlock,
  onClickBlock,
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
  onOpenStack: (msgs: Message[]) => void;
  onReply: (m: Message) => void;
  onJumpToMessage: (id: string) => void;
  /** Live swipe-to-reply travel for *this* block only (0 unless it's the one
   *  currently being dragged — see `RunGroup`'s `swipeState` lookup). Signed:
   *  negative for `mine` (dragged left), positive for others (dragged right). */
  swipeDx: number;
  onPointerDownBlock: (e: React.PointerEvent, msgs: Message[], mine: boolean) => void;
  onPointerMoveBlock: (e: React.PointerEvent) => void;
  onPointerUpBlock: () => void;
  onPointerCancelBlock: () => void;
  onClickBlock: (e: React.MouseEvent, msgs: Message[]) => void;
}) {
  const msgs = blockMessages(block);
  const m = msgs[0]!;
  const isStack = block.kind === 'stack';
  const pending = m.id.startsWith('pending:');
  const selected = msgs.some((mm) => selectedIds.has(mm.id));
  const highlighted = msgs.some((mm) => mm.id === highlightId);

  // Photos/videos (including their processing/failed placeholders, which are
  // already self-contained cards) render without a bubble behind them.
  const bare = !isStack && m.media !== null && m.media.kind !== 'voice';
  const showBubble = !isStack && (!bare || !!m.body);
  const isVoice = m.media?.kind === 'voice';
  // A stack has no single addressable message to quote (see the same
  // exclusion on the swipe/focus-menu reply affordances above).
  const quote = !isStack && m.replyTo ? m.replyTo : null;

  const actionsButton = showActionsButton && !pending && (
    <MessageActions onMore={() => onOpenActions(m)} onReply={() => onReply(m)} />
  );

  const swipeProgress = Math.min(1, Math.abs(swipeDx) / SWIPE_REPLY_THRESHOLD_PX);
  const swipeArmed = swipeProgress >= 1;

  return (
    <div className={'group relative flex items-center gap-1 ' + (mine ? 'justify-end' : 'justify-start')}>
      {mine && actionsButton}
      {/* Swipe-to-reply reveal icon — fades/scales in with drag progress and
          "fills in" (muted → accent) once past the fire threshold. Sits in
          the gutter behind the block's resting position (the side opposite
          the drag direction, matching iMessage), so it never affects layout. */}
      {swipeProgress > 0 && (
        <div
          className={
            'pointer-events-none absolute top-1/2 z-0 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-pill transition-colors ' +
            (mine ? 'right-0' : 'left-0') +
            (swipeArmed ? ' bg-accent text-white' : ' bg-surface-sunken text-text-muted')
          }
          style={{ opacity: swipeProgress, transform: `translateY(-50%) scale(${0.7 + 0.3 * swipeProgress})` }}
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
        onClick={(e) => onClickBlock(e, msgs)}
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
          transform: swipeDx ? `translateX(${swipeDx}px)` : undefined,
          transition: swipeDx ? undefined : 'transform 150ms ease-out', // only snap-back animates; live drag tracks the pointer 1:1
        }}
      >
        {/* Bare media's quote sits just above the media itself, as its own
            small standalone card — there's no bubble to render it inside. */}
        {quote && bare && <QuotedBlock replyTo={quote} chat={chat} mine={mine} standalone onJump={onJumpToMessage} />}
        {isStack && <MediaStack messages={msgs} onOpen={() => onOpenStack(msgs)} />}
        {bare && <MediaBubble message={m} onOpen={() => onOpenViewer(m)} interactive={!selectionMode} />}
        {showBubble && (
          <div
            className={
              'max-w-full rounded-lg text-sm ' +
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
            {/* Not `bare`, so this is a text and/or voice bubble — the quote
                renders inline, above whatever the bubble already holds. */}
            {quote && !bare && <QuotedBlock replyTo={quote} chat={chat} mine={mine} standalone={false} onJump={onJumpToMessage} />}
            {!bare && m.media && (
              <MediaBubble message={m} onOpen={() => onOpenViewer(m)} interactive={!selectionMode} />
            )}
            {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
          </div>
        )}
      </div>
      {!mine && actionsButton}
    </div>
  );
}

/** The small quoted-original block a reply renders above its content
 *  (docs/UI8_CHAT_INSTAGRAM.md-style "reply strip"). Two visual modes:
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
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{senderName}</p>
        <p className={'truncate ' + (replyTo.deleted ? 'italic opacity-80' : '')}>
          {replyTo.deleted ? 'Original deleted' : replyTo.preview}
        </p>
      </div>
    </button>
  );
}
