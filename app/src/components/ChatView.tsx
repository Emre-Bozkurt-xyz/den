import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Copy, Hand, Images, Mic, MoreVertical, Paperclip, Square, Trash2, X } from 'lucide-react';
import type { ChatSummary, MediaInfo, MeResponse, Message } from '@den/shared';
import { flattenMessages, useMessages } from '../hooks/useMessages';
import { chatDisplayName, deleteMessages, markRead, restoreMessages } from '../lib/chats';
import { kindForMime, uploadMedia } from '../lib/media';
import { useRealtime } from '../lib/realtime';
import { useIsMobile } from '../hooks/useIsMobile';
import { MediaBubble } from './MediaBubble';
import { MediaViewer } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';

type UploadState = { kind: 'image' | 'video' | 'voice'; progress: number } | null;

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const UNDO_TOAST_MS = 10_000;

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
  const [viewerMedia, setViewerMedia] = useState<MediaInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const jumpedRef = useRef(false);
  const name = chatDisplayName(chat, me.id);

  // Multi-select + deletion (Stage 6 / §2 item 11, docs/MESSAGE_DELETE.md §4).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  // The message the action sheet (Copy/Select/Delete) is currently open for.
  const [actionMenuFor, setActionMenuFor] = useState<Message | null>(null);
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
  const lastMessageId = messages[messages.length - 1]?.id;
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

  function enterSelectionMode(m: Message) {
    setSelectionMode(true);
    setSelectedIds(new Set([m.id]));
    setSelectionAnchorId(m.id);
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

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  // Long-press → action menu (or, if already selecting, a direct toggle —
  // see docs/MESSAGE_DELETE.md §4's "long-press when already in selection
  // mode"). Never selectable/actionable while still an optimistic pending
  // bubble — there's nothing to delete server-side yet.
  function onBubblePointerDown(e: React.PointerEvent, m: Message) {
    // Clear any stale suppression from a previous interaction whose click
    // never arrived (long-press fired, then the pointer lifted off the
    // bubble — no click event, so onBubbleClick never got to reset it).
    // Without this, that next tap would be silently swallowed.
    suppressClickRef.current = false;
    if (m.id.startsWith('pending:')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      if (selectionMode) toggleSelect(m.id);
      else setActionMenuFor(m);
    }, LONG_PRESS_MS);
  }

  function onBubblePointerMove(e: React.PointerEvent) {
    const start = longPressStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearLongPressTimer();
  }

  function onBubblePointerUp() {
    clearLongPressTimer();
    longPressStartRef.current = null;
  }

  function onBubblePointerCancel() {
    // Browser-interrupted gesture (e.g. an edge-swipe took over) — abort
    // with no side effects, same posture as MediaViewer's pointer-cancel handlers.
    clearLongPressTimer();
    longPressStartRef.current = null;
  }

  function onBubbleClick(e: React.MouseEvent, m: Message) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (m.id.startsWith('pending:') || !selectionMode) return;
    if (e.shiftKey && selectionAnchorId) {
      selectRange(selectionAnchorId, m.id);
      return;
    }
    toggleSelect(m.id);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    sendMessage(chat.id, draft);
    setDraft('');
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again
    if (!file) return;
    const kind = kindForMime(file.type);
    if (!kind || kind === 'voice') {
      setUploadError('Pick an image or video');
      return;
    }
    await runUpload(file, kind, file.type);
  }

  async function runUpload(file: Blob, kind: 'image' | 'video' | 'voice', mime: string) {
    setUploadError('');
    setUpload({ kind, progress: 0 });
    try {
      await uploadMedia(chat.id, file, kind, mime, draft, (pct) => setUpload({ kind, progress: pct }));
      setDraft('');
    } catch {
      setUploadError('Upload failed — try again');
    } finally {
      setUpload(null);
    }
  }

  async function startRecording() {
    setUploadError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream); // platform picks its native container; server normalizes to m4a
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        void runUpload(blob, 'voice', blob.type);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setUploadError('Microphone access failed');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
  }

  function openViewer(m: Message) {
    // Selection mode swallows taps on the bubble for select/toggle instead —
    // opening the full-screen viewer mid-selection would be a dead end (no
    // action menu inside it) and disrupts the selection gesture.
    if (selectionMode) return;
    // Same suppression the wrapper's onClick applies, checked again here
    // because MediaBubble puts its own onClick on the inner <img>/<div>:
    // that inner handler fires BEFORE the wrapper's (target before ancestor),
    // so without this a long-press on an image opened the full-screen viewer
    // on top of the action sheet. Deliberately does not reset the flag —
    // onBubbleClick still owns that, and runs immediately after this.
    if (suppressClickRef.current) return;
    if (m.media?.status === 'ready' && (m.media.kind === 'image' || m.media.kind === 'video')) {
      setViewerMedia(m.media);
    }
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

        <div className="flex flex-col gap-1.5">
          {messages.map((m) => {
            const mine = m.senderId === me.id;
            const pending = m.id.startsWith('pending:');
            const selected = selectedIds.has(m.id);
            const actionsButton = !isMobile && !pending && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActionMenuFor(m);
                }}
                aria-label="Message actions"
                className="shrink-0 self-start rounded-pill p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-sunken group-hover:opacity-100"
                style={{ touchAction: 'manipulation' }}
              >
                <MoreVertical size={14} />
              </button>
            );
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) messageRefs.current.set(m.id, el);
                  else messageRefs.current.delete(m.id);
                }}
                className={'group flex items-center gap-1 ' + (mine ? 'justify-end' : 'justify-start')}
              >
                {mine && actionsButton}
                <div
                  onPointerDown={(e) => onBubblePointerDown(e, m)}
                  onPointerMove={onBubblePointerMove}
                  onPointerUp={onBubblePointerUp}
                  onPointerCancel={onBubblePointerCancel}
                  onClick={(e) => onBubbleClick(e, m)}
                  className={
                    // Instagram-style bubble: rounded on 3 corners, a tighter
                    // "tail" corner on the side that points at the sender.
                    (m.media
                      ? 'max-w-[75%] rounded-lg p-1.5 text-sm '
                      : 'max-w-[75%] rounded-lg px-3.5 py-2 text-sm ') +
                    (mine ? 'rounded-br-sm ' : 'rounded-bl-sm ') +
                    (highlightId === m.id ? 'ring-2 ring-amber-400 ' : '') +
                    (selected ? 'ring-2 ring-indigo-500 ' : '') +
                    (mine
                      ? 'bg-accent text-white ' + (pending ? 'opacity-60' : '')
                      : 'bg-surface-sunken text-text-primary')
                  }
                  style={{
                    touchAction: 'manipulation',
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                  }}
                >
                  {chat.isGroup && !mine && (
                    <p className="mb-0.5 px-2 pt-1 text-xs font-semibold opacity-70">
                      {chat.members.find((mem) => mem.id === m.senderId)?.displayName ?? 'Unknown'}
                    </p>
                  )}
                  {m.media && <MediaBubble message={m} onOpen={() => openViewer(m)} />}
                  {m.body && (
                    <p className={'whitespace-pre-wrap break-words ' + (m.media ? 'px-2 pt-1.5 pb-0.5' : '')}>{m.body}</p>
                  )}
                </div>
                {!mine && actionsButton}
              </div>
            );
          })}
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
          Uploading {upload.kind}… {upload.progress}%
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

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-border bg-surface-raised p-3"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
      >
        <input ref={fileInputRef} type="file" accept="image/*,video/*" hidden onChange={(e) => void handleFilePicked(e)} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!!upload || recording}
          aria-label="Attach photo or video"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-border text-text-secondary transition-colors hover:bg-surface-sunken active:bg-surface-sunken disabled:opacity-40"
          style={{ touchAction: 'manipulation' }}
        >
          <Paperclip size={18} />
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          className="h-11 min-w-0 flex-1 rounded-pill border border-border bg-surface px-4 text-base text-text-primary outline-none transition-colors focus:border-accent"
        />
        {draft.trim() ? (
          <button
            type="submit"
            className="flex h-11 shrink-0 items-center rounded-pill bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:bg-accent-hover"
            style={{ touchAction: 'manipulation' }}
          >
            Send
          </button>
        ) : (
          <button
            type="button"
            onClick={() => (recording ? stopRecording() : void startRecording())}
            disabled={!!upload}
            aria-label={recording ? 'Stop recording' : 'Record voice message'}
            className={
              'grid h-11 w-11 shrink-0 place-items-center rounded-pill text-white transition-colors disabled:opacity-40 ' +
              (recording ? 'bg-rose-600 hover:bg-rose-700 active:bg-rose-700' : 'bg-accent hover:bg-accent-hover active:bg-accent-hover')
            }
            style={{ touchAction: 'manipulation' }}
          >
            {recording ? <Square size={18} /> : <Mic size={18} />}
          </button>
        )}
      </form>

      {viewerMedia && <MediaViewer media={viewerMedia} onClose={() => setViewerMedia(null)} />}

      {actionMenuFor && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40"
          onClick={() => setActionMenuFor(null)}
          style={{ touchAction: 'manipulation' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-lg bg-surface-raised"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex flex-col divide-y divide-border">
              {actionMenuFor.body && (
                <button
                  onClick={() => handleMenuCopy(actionMenuFor)}
                  className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary"
                  style={{ touchAction: 'manipulation' }}
                >
                  <Copy size={16} />
                  Copy
                </button>
              )}
              <button
                onClick={() => enterSelectionMode(actionMenuFor)}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary"
                style={{ touchAction: 'manipulation' }}
              >
                <CheckSquare size={16} />
                Select
              </button>
              {actionMenuFor.senderId === me.id && (
                <button
                  onClick={() => void handleMenuDelete(actionMenuFor)}
                  className="flex items-center gap-3 px-4 py-3 text-left text-sm text-red-600 dark:text-red-400"
                  style={{ touchAction: 'manipulation' }}
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              )}
            </div>
            <button
              onClick={() => setActionMenuFor(null)}
              className="w-full border-t border-border px-4 py-3 text-center text-sm font-semibold text-text-secondary"
              style={{ touchAction: 'manipulation' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
