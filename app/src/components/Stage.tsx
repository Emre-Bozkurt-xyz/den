import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Eye,
  FileText,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  X,
} from 'lucide-react';
import { StageLimits, type StageDoc, type VaultPickerDoc } from '@den/shared';
import {
  useAddStageDoc,
  useRemoveStageDoc,
  useRenderedStageDoc,
  useStage,
  useStagePicker,
  useStagePortal,
} from '../hooks/useStage';
import { useBackHandler } from '../lib/backStack';
import { formatDateLabel } from '../lib/datetime';
import { useElementWidth } from '../hooks/useElementWidth';
import { albumColumnCount } from '../lib/masonry';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { hideBrokenStageImages, sortStageDocs } from '../lib/stage';
import { StageDocPreview } from './StageDocPreview';

/**
 * The per-chat Stage (docs/EMBEDS.md §6.2/§6.2.1) — a persistent, gallery-
 * parity grid of the chat's Vault docs, opened from `ChatView`'s header.
 * Reuses the exact mobile/desktop split `MessageSearchPanel.tsx` established:
 * mobile = full-screen overlay registered on `backStack`, desktop = a
 * right-side panel that's a flex sibling of the message column, not an
 * overlay. `StageOverlay`/`StagePanel` are the two chrome wrappers; all the
 * actual state and behavior lives in the shared `StageBody`.
 */

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const PICKER_DEBOUNCE_MS = 300;

type PortalTarget = { docId: string; title: string; initialUrl?: string };
type ReadTarget = { vaultDocumentId: string; title: string };

/** Shared body: header + grid + add flow + remove confirm. `variant` only
 *  changes the outer chrome around this (mirrors `MessageSearchPanel`'s
 *  `SearchBody`). */
function StageBody({
  variant,
  chatId,
  onClose,
}: {
  variant: 'mobile' | 'desktop';
  chatId: string;
  onClose: () => void;
}) {
  const stageQuery = useStage(chatId);
  const addMutation = useAddStageDoc(chatId);
  const removeMutation = useRemoveStageDoc(chatId);
  const [error, setError] = useState('');

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [pickerQueryInput, setPickerQueryInput] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [removeTarget, setRemoveTarget] = useState<StageDoc | null>(null);
  const [portalTarget, setPortalTarget] = useState<PortalTarget | null>(null);
  const [readTarget, setReadTarget] = useState<ReadTarget | null>(null);

  // Debounced picker search (docs/EMBEDS.md §6.2.1 "Debounce the search
  // input"), same shape as TagSearchInput's 150ms debounce, slightly longer
  // since this hits Vault through Den's server rather than a local table.
  useEffect(() => {
    const t = setTimeout(() => setPickerQuery(pickerQueryInput), PICKER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [pickerQueryInput]);

  const data = stageQuery.data;
  const sortedDocs = useMemo(() => (data ? sortStageDocs(data.docs) : []), [data]);

  const picker = useStagePicker(chatId, pickerQuery, pickerOpen && !!data?.viewerLinked);

  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const columnCount = albumColumnCount(gridWidth);

  function openAddMenu() {
    setAddMenuOpen((v) => !v);
  }

  function openPicker() {
    setAddMenuOpen(false);
    setNewTitle('');
    setPickerQueryInput('');
    setPickerQuery('');
    setPickerOpen(true);
  }

  function handleCreateBlank() {
    const title = newTitle.trim().slice(0, StageLimits.maxTitleLength) || 'Untitled';
    addMutation.mutate(
      { title },
      {
        onSuccess: (res) => {
          setPickerOpen(false);
          // The create response's own portalUrl IS the fresh single-use
          // session — open the portal directly with it (owner decision:
          // "you made it to write in it") rather than minting a second one.
          if (res.portalUrl) setPortalTarget({ docId: res.doc.id, title: res.doc.title, initialUrl: res.portalUrl });
        },
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not create the doc.'),
      },
    );
  }

  function handleClone(pick: VaultPickerDoc) {
    addMutation.mutate(
      { sourceDocumentId: pick.id },
      {
        // Clone returns to the grid (no portal) — "the content already
        // exists; no reason to force an editor" (docs/EMBEDS.md §6.2.1).
        onSuccess: () => setPickerOpen(false),
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not add that doc.'),
      },
    );
  }

  function handleConfirmRemove() {
    if (!removeTarget) return;
    const id = removeTarget.id;
    removeMutation.mutate(id, {
      onSuccess: () => setRemoveTarget(null),
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Could not remove that doc.');
        setRemoveTarget(null);
      },
    });
  }

  function handleOpenDoc(doc: StageDoc) {
    if (doc.canEdit) setPortalTarget({ docId: doc.id, title: doc.title });
    else setReadTarget({ vaultDocumentId: doc.vaultDocumentId, title: doc.title });
  }

  return (
    <>
      <header
        className="flex items-center gap-2 border-b border-border px-3 py-3"
        style={variant === 'mobile' ? { paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' } : undefined}
      >
        {variant === 'mobile' && (
          <button
            onClick={onClose}
            aria-label="Close Stage"
            className="flex shrink-0 items-center text-text-secondary"
            style={{ touchAction: 'manipulation' }}
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">Stage</span>
        {variant === 'desktop' && (
          <button
            onClick={onClose}
            aria-label="Close Stage"
            className="flex shrink-0 items-center text-text-secondary"
            style={{ touchAction: 'manipulation' }}
          >
            <X size={18} />
          </button>
        )}
      </header>

      {error && (
        <p className="border-b border-border bg-surface-raised px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {stageQuery.isLoading && <p className="p-4 text-center text-sm text-text-muted">Loading…</p>}

        {data && (
          <div className="p-3">
            <div ref={gridRef} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
              {data.writable && (
                <div className="relative">
                  <AddCardTile onClick={openAddMenu} />
                  {addMenuOpen && (
                    <>
                      <button
                        aria-label="Close menu"
                        className="fixed inset-0 z-10 cursor-default"
                        onClick={() => setAddMenuOpen(false)}
                      />
                      <div className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg">
                        <button
                          onClick={openPicker}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-sunken"
                          style={{ touchAction: 'manipulation' }}
                        >
                          <FileText size={14} className="text-text-muted" />
                          Vault doc
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {sortedDocs.map((doc) => (
                <StageDocCard
                  key={doc.id}
                  chatId={chatId}
                  doc={doc}
                  writable={data.writable}
                  onOpen={() => handleOpenDoc(doc)}
                  onRemove={() => setRemoveTarget(doc)}
                />
              ))}
            </div>

            {sortedDocs.length === 0 && (
              <p className="pt-4 text-center text-xs text-text-muted">
                {data.writable ? "Keep docs your chat shares here." : "No docs in this chat's Stage yet."}
              </p>
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" style={{ touchAction: 'manipulation' }}>
          <div className="flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-strong">
            <div className="flex items-center gap-2 border-b border-border px-3 py-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">Add a Vault doc</span>
              <button
                onClick={() => setPickerOpen(false)}
                aria-label="Close"
                className="flex shrink-0 items-center text-text-secondary"
                style={{ touchAction: 'manipulation' }}
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-border p-3">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={StageLimits.maxTitleLength}
                placeholder="Untitled"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
                style={{ touchAction: 'manipulation' }}
              />
              <button
                onClick={handleCreateBlank}
                disabled={addMutation.isPending}
                className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                style={{ touchAction: 'manipulation' }}
              >
                <Plus size={14} />
                New blank doc
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {!data?.viewerLinked ? (
                <p className="p-4 text-center text-sm text-text-muted">
                  Connect your Vault account in Profile to browse and add your own docs here.
                </p>
              ) : (
                <>
                  <div className="border-b border-border p-3">
                    <input
                      type="text"
                      value={pickerQueryInput}
                      onChange={(e) => setPickerQueryInput(e.target.value)}
                      maxLength={StageLimits.maxPickerQueryLength}
                      placeholder="Search your Vault docs"
                      className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
                      style={{ touchAction: 'manipulation' }}
                    />
                  </div>
                  {picker.isLoading && <p className="p-4 text-center text-sm text-text-muted">Searching…</p>}
                  {!picker.isLoading && (picker.data?.length ?? 0) === 0 && (
                    <p className="p-4 text-center text-sm text-text-muted">No docs found.</p>
                  )}
                  {picker.data?.map((pick) => (
                    <button
                      key={pick.id}
                      onClick={() => handleClone(pick)}
                      disabled={addMutation.isPending}
                      className="flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left hover:bg-surface-sunken disabled:opacity-50"
                      style={{ touchAction: 'manipulation' }}
                    >
                      <span className="truncate text-sm text-text-primary">{pick.title}</span>
                      {pick.folderPath && <span className="truncate text-xs text-text-muted">{pick.folderPath}</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {removeTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" style={{ touchAction: 'manipulation' }}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface-raised p-4 shadow-strong">
            <h2 className="text-sm font-semibold text-text-primary">Remove from Stage?</h2>
            {/* Load-bearing wording (docs/EMBEDS.md §6.2.1): removal is
                shared-wiki, and must never read as "delete the Vault doc" —
                the chat's group keeps owning it either way. */}
            <p className="mt-2 text-sm text-text-secondary">
              This only removes “{removeTarget.title || 'this doc'}” from this chat's Stage. The Vault document
              itself is not deleted — your group keeps owning it, and anyone with the link can still open it in
              Vault.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRemoveTarget(null)}
                className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRemove}
                disabled={removeMutation.isPending}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-red-500"
                style={{ touchAction: 'manipulation' }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {readTarget && (
        <StageReadView
          chatId={chatId}
          vaultDocumentId={readTarget.vaultDocumentId}
          title={readTarget.title}
          onClose={() => setReadTarget(null)}
        />
      )}

      {portalTarget && (
        <StagePortalOverlay
          chatId={chatId}
          docId={portalTarget.docId}
          title={portalTarget.title}
          initialUrl={portalTarget.initialUrl}
          onClose={() => setPortalTarget(null)}
        />
      )}
    </>
  );
}

function AddCardTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Add to Stage"
      // `h-full` makes the tile match its row's tallest card rather than
      // shrink-wrapping the icon: a doc card is the 4/3 preview PLUS a text
      // block, so without this the add-tile sits noticeably short of it.
      className="flex h-full flex-col overflow-hidden rounded-xl border-2 border-dashed border-border text-text-muted hover:bg-surface-sunken hover:text-text-secondary"
      style={{ touchAction: 'manipulation' }}
    >
      {/* `grow` (not `flex-1`) on purpose — flex-1 zeroes the basis, which
          would collapse this box when the Stage is empty and there is no
          sibling card to stretch against. Growing from the aspect-ratio
          basis keeps a sensible size in both cases. */}
      <div className="grid aspect-[4/3] w-full grow place-items-center">
        <Plus size={28} />
      </div>
      <div className="p-2.5 text-center text-xs font-medium">Add a doc</div>
    </button>
  );
}

function AccessHint({ canEdit }: { canEdit: boolean }) {
  return canEdit ? (
    <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-text-muted">
      <Pencil size={10} />
      Edit
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-text-muted">
      <Eye size={10} />
      View
    </span>
  );
}

/** One Stage grid tile: the paper thumbnail + title/owner/date, an
 *  overflow ("⋮") menu, and long-press as an alternate path to the same menu
 *  (docs/EMBEDS.md §6.2.1 "card overflow/long-press"). Long-press timing
 *  mirrors `ChatGallery`'s tile handlers (same constants). */
function StageDocCard({
  chatId,
  doc,
  writable,
  onOpen,
  onRemove,
}: {
  chatId: string;
  doc: StageDoc;
  writable: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!writable) return;
    suppressClickRef.current = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = longPressStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearLongPressTimer();
  }

  function onPointerUpOrCancel() {
    clearLongPressTimer();
    longPressStartRef.current = null;
  }

  function onClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen();
  }

  return (
    <div className="relative">
      <button
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUpOrCancel}
        onPointerCancel={onPointerUpOrCancel}
        onContextMenu={suppressTouchContextMenu}
        className="media-preview block w-full overflow-hidden rounded-xl border border-border bg-surface-raised text-left animate-gallery-tile-in gallery-tile"
        style={{ touchAction: 'manipulation' }}
      >
        <StageDocPreview chatId={chatId} doc={doc} />
        <div className="flex flex-col gap-1 p-2.5">
          <div className="flex items-start justify-between gap-1.5">
            <p className="line-clamp-1 flex-1 text-sm font-semibold text-text-primary">{doc.title || 'Untitled'}</p>
            <AccessHint canEdit={doc.canEdit} />
          </div>
          {doc.ownerName && <p className="truncate text-xs text-text-muted">{doc.ownerName}</p>}
          {/* No snippet here by design: the paper thumbnail above already
              shows the document's opening content, so repeating it as raw
              markdown text was redundant and noisy. `snippet` stays on the
              DTO — the clone picker still uses it, where there is no
              thumbnail to convey the same thing. */}
          <p className="text-[11px] text-text-muted">
            {doc.updatedAt ? formatDateLabel(doc.updatedAt) : `Added ${formatDateLabel(doc.addedAt)}`}
          </p>
        </div>
      </button>

      {writable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Doc options"
          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-pill bg-black/50 text-white"
          style={{ touchAction: 'manipulation' }}
        >
          <MoreVertical size={14} />
        </button>
      )}

      {menuOpen && (
        <>
          <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-1.5 top-8 z-20 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg">
            <button
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
              className="whitespace-nowrap px-3 py-2 text-left text-sm text-red-600 hover:bg-surface-sunken dark:text-red-400"
              style={{ touchAction: 'manipulation' }}
            >
              Remove from Stage
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The read view (docs/EMBEDS.md §6.1/§6.2.1): a Den-chrome overlay over the
 *  sanitized rendered HTML, for viewers without portal access (`canEdit ===
 *  false`). Server-relayed — never calls Vault directly. */
function StageReadView({
  chatId,
  vaultDocumentId,
  title,
  onClose,
}: {
  chatId: string;
  vaultDocumentId: string;
  title: string;
  onClose: () => void;
}) {
  useBackHandler(true, onClose);
  const { data, isLoading, isError } = useRenderedStageDoc(chatId, vaultDocumentId, true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !data) return;
    return hideBrokenStageImages(el);
  }, [data]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header
        className="flex items-center gap-2 border-b border-border px-3 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex shrink-0 items-center text-text-secondary"
          style={{ touchAction: 'manipulation' }}
        >
          <ArrowLeft size={20} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{data?.title ?? title}</span>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && <p className="text-center text-sm text-text-muted">Loading…</p>}
        {isError && (
          // docs/EMBEDS.md §6.1 — degrade to a plain notice, never a broken
          // half-render, when the render API is unavailable.
          <p className="text-center text-sm text-text-muted">Couldn't load this doc right now.</p>
        )}
        {data && <div ref={contentRef} className="stage-doc-content" dangerouslySetInnerHTML={{ __html: data.html }} />}
      </div>
    </div>
  );
}

/** The live portal (docs/EMBEDS.md §6.4): mounts Vault's own editor iframe.
 *  Mints a fresh single-use session on every open unless one was just
 *  minted by a create-blank call (`initialUrl`) — NEVER caches or reuses a
 *  `portalUrl` across opens (shared/src/vault.ts). Exactly one portal
 *  mounts at a time, only while this overlay is open. */
function StagePortalOverlay({
  chatId,
  docId,
  title,
  initialUrl,
  onClose,
}: {
  chatId: string;
  docId: string;
  title: string;
  initialUrl?: string;
  onClose: () => void;
}) {
  useBackHandler(true, onClose);
  const portalMutation = useStagePortal(chatId);
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const [error, setError] = useState('');
  const mintedRef = useRef(!!initialUrl);

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    portalMutation.mutate(docId, {
      onSuccess: (res) => setUrl(res.portalUrl),
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not open the editor.'),
    });
    // Mint-once-per-mount is intentional (see mintedRef above, and
    // `mintedRef.current = true` before the call) — this effect is keyed
    // only on `docId` so it never re-fires from the mutation's own pending/
    // success state changing, which would otherwise burn a second single-use
    // token.
  }, [docId]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header
        className="flex items-center gap-2 border-b border-border px-3 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex shrink-0 items-center text-text-secondary"
          style={{ touchAction: 'manipulation' }}
        >
          <ArrowLeft size={20} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</span>
      </header>
      <div className="flex-1">
        {url ? (
          // The Vault portal iframe — the ONE deliberate, logged cross-origin
          // frame exception (CLAUDE.md hard invariant 10 / docs/EMBEDS.md §2):
          // first-party, origin-sandboxed, allow-listed to vault.ems-place.com
          // only, no tracking. ⚠️ iOS: this iframe's own focused input sits
          // outside Den's `useKeyboardInset` composer-pinning — real-device
          // keyboard/focus/scroll verification is still outstanding
          // (docs/EMBEDS.md §6.5).
          <iframe src={url} title={`Vault editor — ${title}`} className="h-full w-full border-0" />
        ) : error ? (
          <p className="p-4 text-center text-sm text-text-muted">{error}</p>
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Opening editor…
          </div>
        )}
      </div>
    </div>
  );
}

/** Mobile: full-screen overlay, registered on the back stack — identical
 *  chrome tier to `MessageSearchOverlay` (z-40, below MediaViewer's z-50). */
export function StageOverlay({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  useBackHandler(true, onClose);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <StageBody variant="mobile" chatId={chatId} onClose={onClose} />
    </div>
  );
}

/** Desktop: a flex sibling of the message column, not an overlay — same
 *  ~360-380px right-side-panel posture as `MessageSearchPanel`. */
export function StagePanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-surface-raised">
      <StageBody variant="desktop" chatId={chatId} onClose={onClose} />
    </div>
  );
}
