import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, EyeOff, Play, Plus } from 'lucide-react';
import { isSensitiveTag, normalizeTagName, type Sensitivity, type Tag } from '@den/shared';
import type { StagedAttachment } from '../lib/media';
import { commonTags } from '../lib/tags';
import { useBackHandler } from '../lib/backStack';
import { useIsMobile } from '../hooks/useIsMobile';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { TagEditor } from './MediaViewer';

/**
 * Opens when a composer tray thumbnail is tapped (docs/MEDIA_ATTACHMENTS.md
 * §5.2) — ~80% a copy of `ChatGallery.tsx`'s `MobileTagSheet` (bottom sheet
 * shell + filmstrip + `TagEditor`), with a focused preview and the two
 * sensitivity toggles added. Tags staged here are client-only (D7) until
 * Send, when they ride each item's `complete` call.
 */

const SENSITIVE_LABEL: Record<Sensitivity, string> = { nsfw: 'NSFW', spoiler: 'Spoiler' };

type ToggleState = 'on' | 'off' | 'mixed';

function toggleStateOf(items: StagedAttachment[], tagName: Sensitivity): ToggleState {
  if (items.length === 0) return 'off';
  const flags = items.map((i) => i.tags.includes(tagName));
  if (flags.every(Boolean)) return 'on';
  if (flags.every((f) => !f)) return 'off';
  return 'mixed';
}

export function AttachmentSheet({
  attachments,
  focusedId,
  chatId,
  onClose,
  onUpdateTags,
  onAddFiles,
}: {
  attachments: StagedAttachment[];
  focusedId: string;
  chatId: string;
  onClose: () => void;
  onUpdateTags: (localId: string, updater: (tags: string[]) => string[]) => void;
  /** Same "+" flow as the tray's own add button (`Composer`) — validation
   *  (`stageFiles`) lives once, centrally, in `ChatView`. */
  onAddFiles: (files: File[]) => void;
}) {
  const isMobile = useIsMobile();
  useBackHandler(true, onClose, { escape: true });

  const [focused, setFocused] = useState(focusedId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set([focusedId]));
  const [peeking, setPeeking] = useState(false);
  /** What the toggles AND the tag field below act on. Replaces the original
   *  "Select multiple" button + a separate "Apply to all" checkbox that sat
   *  inside the toggles row — which read as if it scoped only the toggles and
   *  not the tag field (owner report, 2026-08-12). One control, stated once,
   *  above everything it governs. */
  const [scope, setScope] = useState<'one' | 'all' | 'custom'>('one');
  const multiSelect = scope === 'custom';

  // The dedicated preview/keyboard fight (docs §5.2: "opening the sheet
  // dismisses the keyboard, they otherwise fight over the same 70dvh").
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  // The focused item's own reveal peek never carries over to the next item.
  useEffect(() => {
    setPeeking(false);
  }, [focused]);

  // A tray item can disappear out from under the sheet (removed via the
  // tray's ✕ while this is open) — fall back sensibly instead of crashing on
  // a missing lookup.
  useEffect(() => {
    if (!attachments.some((a) => a.localId === focused)) {
      const fallback = attachments[0]?.localId;
      if (fallback) setFocused(fallback);
      else onClose();
    }
  }, [attachments, focused, onClose]);

  const focusedIndex = attachments.findIndex((a) => a.localId === focused);
  const focusedItem = focusedIndex >= 0 ? attachments[focusedIndex]! : null;
  const selectedItems = attachments.filter((a) => selectedIds.has(a.localId));
  const targetItems = scope === 'custom' ? selectedItems : scope === 'all' ? attachments : focusedItem ? [focusedItem] : [];

  function setSensitive(tagName: Sensitivity, turnOn: boolean) {
    for (const item of targetItems) {
      onUpdateTags(item.localId, (tags) => {
        const has = tags.includes(tagName);
        if (turnOn && !has) return [...tags, tagName];
        if (!turnOn && has) return tags.filter((t) => t !== tagName);
        return tags;
      });
    }
  }

  function toggleSensitive(tagName: Sensitivity) {
    setSensitive(tagName, toggleStateOf(targetItems, tagName) !== 'on');
  }

  function chooseScope(next: 'one' | 'all' | 'custom') {
    if (next === 'custom') setSelectedIds(new Set(focused ? [focused] : []));
    setScope(next);
  }

  function toggleSelected(localId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(localId)) next.delete(localId);
      else next.add(localId);
      return next;
    });
  }

  function handleAddFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) onAddFiles(files);
  }

  const freeTagLists = targetItems.map((item) =>
    item.tags.filter((t) => !isSensitiveTag(t)).map((name): Tag => ({ id: name, name, usageCount: 0 })),
  );
  const freeTags = commonTags(freeTagLists);

  function handleAddTag(nameRaw: string) {
    const normalized = normalizeTagName(nameRaw);
    if (!normalized) return;
    // Typing `nsfw`/`spoiler` by hand is the same act as flipping the toggle
    // above, so route it there instead of dropping it. It used to return
    // silently, which read as the tag field being broken (owner report,
    // 2026-08-12). The toggle switching on IS the feedback — these two
    // controls are one piece of state, not two.
    if (isSensitiveTag(normalized)) {
      setSensitive(normalized, true);
      return;
    }
    for (const item of targetItems) {
      onUpdateTags(item.localId, (tags) => (tags.includes(normalized) ? tags : [...tags, normalized]));
    }
  }

  function handleRemoveTag(tagId: string) {
    for (const item of targetItems) {
      onUpdateTags(item.localId, (tags) => tags.filter((t) => t !== tagId));
    }
  }

  const nsfwState = toggleStateOf(targetItems, 'nsfw');
  const spoilerState = toggleStateOf(targetItems, 'spoiler');
  const focusedSensitivity: Sensitivity | null = focusedItem
    ? focusedItem.tags.includes('nsfw')
      ? 'nsfw'
      : focusedItem.tags.includes('spoiler')
        ? 'spoiler'
        : null
    : null;
  const focusedBlurred = focusedSensitivity !== null && !peeking;

  const content = (
    <div
      className={
        isMobile
          ? 'fixed inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-border bg-surface-raised shadow-strong'
          : 'w-full max-w-[420px] rounded-md border border-border bg-surface-raised shadow-strong'
      }
      style={
        isMobile
          ? // `zIndex` is NOT decorative here — see the mobile return below.
            { paddingBottom: 'env(safe-area-inset-bottom)', maxHeight: '70dvh', zIndex: 100 }
          : undefined
      }
      onClick={(e) => e.stopPropagation()}
    >
      <input type="file" accept="image/*,video/*" multiple hidden id="attachment-sheet-add-input" onChange={handleAddFiles} />

      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex-1 text-sm font-semibold text-text-primary">
          {`Attachment ${Math.max(focusedIndex, 0) + 1} of ${attachments.length}`}
        </span>
        <button
          onClick={onClose}
          className="rounded-pill bg-accent px-3 py-1 text-xs font-semibold text-white"
          style={{ touchAction: 'manipulation' }}
        >
          Done
        </button>
      </div>

      {/* Focused preview / multi-select summary */}
      <div className="flex items-center justify-center gap-3 border-b border-border p-3" style={{ minHeight: '30dvh' }}>
        {/* The preview always shows the FOCUSED item, even while the scope is
            "All"/"Choose…" — it's the visual context for which attachment the
            filmstrip highlight is on. What's being edited is stated in words
            by the scope row below, so this no longer collapses to a bare
            "N selected" and lose the picture. */}
        {focusedItem ? (
          <div className="relative overflow-hidden rounded-md" style={{ maxHeight: '30dvh' }}>
            <div style={{ filter: focusedBlurred ? 'blur(24px)' : undefined, transition: 'filter 200ms ease-out' }}>
              {focusedItem.kind === 'image' ? (
                <img src={focusedItem.previewUrl ?? undefined} alt="" className="max-h-[30dvh] max-w-full object-contain" />
              ) : (
                <video src={focusedItem.previewUrl ?? undefined} preload="metadata" muted className="max-h-[30dvh] max-w-full object-contain" />
              )}
            </div>
            {focusedSensitivity && (
              <button
                type="button"
                onClick={() => setPeeking((v) => !v)}
                aria-label={peeking ? 'Hide preview' : 'Peek — does not unmark'}
                className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-pill bg-black/60 text-white"
                style={{ touchAction: 'manipulation' }}
              >
                {peeking ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* Filmstrip */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex flex-1 gap-1.5 overflow-x-auto">
          {attachments.map((item) => {
            const selected = selectedIds.has(item.localId);
            return (
              <button
                key={item.localId}
                onClick={() => (multiSelect ? toggleSelected(item.localId) : setFocused(item.localId))}
                onContextMenu={suppressTouchContextMenu}
                className={
                  'media-preview relative h-11 w-11 shrink-0 overflow-hidden rounded-sm border bg-surface-sunken ' +
                  (!multiSelect && item.localId === focused ? 'border-accent ring-2 ring-accent' : 'border-border')
                }
                style={{ touchAction: 'manipulation' }}
              >
                {item.kind === 'image' ? (
                  <img src={item.previewUrl ?? undefined} alt="" className="h-full w-full object-cover" />
                ) : (
                  <>
                    <video src={item.previewUrl ?? undefined} preload="metadata" muted className="h-full w-full object-cover" />
                    <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/10">
                      <Play size={12} fill="white" className="text-white" />
                    </span>
                  </>
                )}
                {item.tags.some((t) => isSensitiveTag(t)) && (
                  <span className="absolute left-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white">
                    <EyeOff size={9} />
                  </span>
                )}
                {multiSelect && (
                  <span
                    className={
                      'absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-pill ' +
                      (selected ? 'bg-accent text-white' : 'bg-black/50 text-white/70')
                    }
                  >
                    {selected && <Check size={10} />}
                  </span>
                )}
              </button>
            );
          })}
          <label
            htmlFor="attachment-sheet-add-input"
            className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-sm border border-dashed border-border text-text-muted"
            style={{ touchAction: 'manipulation' }}
          >
            <Plus size={16} />
          </label>
        </div>
      </div>

      {/* Scope — governs BOTH the toggles and the tag field below, which is
          why it sits above them both with an explicit sentence rather than
          riding along in the toggles row as a checkbox. */}
      {attachments.length > 1 && (
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="mr-0.5 text-xs font-medium text-text-secondary">Apply to</span>
            <ScopeButton active={scope === 'one'} onClick={() => chooseScope('one')}>
              This one
            </ScopeButton>
            <ScopeButton active={scope === 'all'} onClick={() => chooseScope('all')}>
              All {attachments.length}
            </ScopeButton>
            <ScopeButton active={scope === 'custom'} onClick={() => chooseScope('custom')}>
              Choose…
            </ScopeButton>
          </div>
          <p className="mt-1.5 text-[11px] text-text-muted">
            {scope === 'one'
              ? 'Marks and tags below affect the highlighted attachment.'
              : scope === 'all'
                ? `Marks and tags below affect all ${attachments.length} attachments.`
                : `Marks and tags below affect the ${selectedItems.length} checked attachment${selectedItems.length === 1 ? '' : 's'}.`}
          </p>
        </div>
      )}

      {/* Sensitivity toggles */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <SensitiveToggleButton label={SENSITIVE_LABEL.nsfw} state={nsfwState} onClick={() => toggleSensitive('nsfw')} />
        <SensitiveToggleButton label={SENSITIVE_LABEL.spoiler} state={spoilerState} onClick={() => toggleSensitive('spoiler')} />
      </div>

      {/* Tags. Typing `nsfw`/`spoiler` here flips the matching toggle above
          rather than adding a chip — see `handleAddTag`. */}
      <div className="p-3">
        <TagEditor chatId={chatId} tags={freeTags} onAddTag={handleAddTag} onRemoveTag={handleRemoveTag} tone="surface" />
      </div>
    </div>
  );

  // Mobile: portalled to <body> with an EXPLICIT zIndex, for exactly the
  // reason PROJECT.md §11 records as a hard-won lesson (and that
  // MessageFocusMenu already had to be fixed for): a `position: fixed`
  // element with `z-index: auto` paints at its PARENT's layer, not above the
  // page. This sheet renders from inside the chat's composer subtree, so
  // message blocks — which carry `relative z-10` — were painting over it and
  // the sheet was invisible behind the message list.
  //
  // Deliberately no backdrop element on mobile: the sheet is opaque
  // (`bg-surface-raised`) and the chat stays usable behind it, which is the
  // behaviour it was built with. Only the stacking is being fixed here.
  if (isMobile) return createPortal(content, document.body);

  // Desktop: centered modal, portalled with an EXPLICIT zIndex on the
  // outermost wrapper (PROJECT.md §11's stacking-context lesson — a
  // `position: fixed` element with `z-index: auto` paints at its parent's
  // layer and loses to any positioned sibling, regardless of this subtree's
  // own z-index values).
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 p-4" style={{ zIndex: 100 }} onClick={onClose}>
      {content}
    </div>,
    document.body,
  );
}

function ScopeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'rounded-pill px-2.5 py-1 text-xs font-medium transition-colors ' +
        (active ? 'bg-accent text-white' : 'bg-surface-sunken text-text-secondary hover:bg-border')
      }
      style={{ touchAction: 'manipulation' }}
    >
      {children}
    </button>
  );
}

function SensitiveToggleButton({ label, state, onClick }: { label: string; state: ToggleState; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'rounded-pill border px-3 py-1.5 text-xs font-semibold transition-colors ' +
        (state === 'on'
          ? 'border-accent bg-accent text-white'
          : state === 'mixed'
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-border bg-surface-sunken text-text-secondary')
      }
      style={{ touchAction: 'manipulation' }}
    >
      {label}
      {state === 'mixed' && ' —'}
    </button>
  );
}
