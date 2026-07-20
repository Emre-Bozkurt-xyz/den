import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Hand, Images, Mic, Paperclip, Square } from 'lucide-react';
import type { ChatSummary, MediaInfo, MeResponse, Message } from '@den/shared';
import { flattenMessages, useMessages } from '../hooks/useMessages';
import { chatDisplayName, markRead } from '../lib/chats';
import { kindForMime, uploadMedia } from '../lib/media';
import { useRealtime } from '../lib/realtime';
import { MediaBubble } from './MediaBubble';
import { MediaViewer } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';

type UploadState = { kind: 'image' | 'video' | 'voice'; progress: number } | null;

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

  const messages = flattenMessages(data?.pages);
  const lastMessageId = messages[messages.length - 1]?.id;

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
    if (m.media?.status === 'ready' && (m.media.kind === 'image' || m.media.kind === 'video')) {
      setViewerMedia(m.media);
    }
  }

  return (
    <div className="flex h-full flex-col">
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
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) messageRefs.current.set(m.id, el);
                  else messageRefs.current.delete(m.id);
                }}
                className={'flex ' + (mine ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={
                    // Instagram-style bubble: rounded on 3 corners, a tighter
                    // "tail" corner on the side that points at the sender.
                    (m.media
                      ? 'max-w-[75%] rounded-lg p-1.5 text-sm '
                      : 'max-w-[75%] rounded-lg px-3.5 py-2 text-sm ') +
                    (mine ? 'rounded-br-sm ' : 'rounded-bl-sm ') +
                    (highlightId === m.id ? 'ring-2 ring-amber-400 ' : '') +
                    (mine
                      ? 'bg-accent text-white ' + (pending ? 'opacity-60' : '')
                      : 'bg-surface-sunken text-text-primary')
                  }
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
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>

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
    </div>
  );
}
