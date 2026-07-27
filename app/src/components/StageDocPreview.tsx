import { useEffect, useRef } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import type { StageDoc } from '@den/shared';
import { useRenderedStageDoc } from '../hooks/useStage';
import { useInView } from '../hooks/useInView';
import { hideBrokenStageImages } from '../lib/stage';

/**
 * The Stage's "paper thumbnail" (docs/EMBEDS.md §6.2.1) — ported from
 * Vault's own live doc-card technique: the-vault's
 * `WorkspaceDocumentPreviewCard.tsx` + `.vault-doc-preview*` (see the
 * `.stage-doc-preview*` rules in index.css for the ported CSS and the
 * fuller port note).
 *
 * Crucial detail confirmed against Vault's source: `WorkspaceDocumentPreviewCard`
 * passes the FULL markdown into its preview — the "top slice" look comes
 * entirely from the CSS box (`aspect-ratio: 4/3` + `overflow: hidden` +
 * scale), not from truncating the string first. This ports the same
 * approach: the full `RenderedDocResponse.html` is dropped in untouched, so
 * there's no risk of slicing mid-tag and handing the browser unbalanced
 * markup. Fetched lazily via `useInView` — a Stage with dozens of docs fires
 * a `/rendered` request per card only as it scrolls into view, not on mount.
 *
 * ⚠️ Private Vault images inside `html` will not load for Den's viewers
 * (docs/EMBEDS.md §7.1 item 5, expected) — `hideBrokenStageImages` collapses
 * the failed `<img>` instead of leaving the browser's broken-image icon.
 */
export function StageDocPreview({ chatId, doc }: { chatId: string; doc: StageDoc }) {
  const [inViewRef, inView] = useInView<HTMLDivElement>();
  const { data, isLoading } = useRenderedStageDoc(chatId, doc.vaultDocumentId, inView);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !data) return;
    return hideBrokenStageImages(el);
  }, [data]);

  return (
    <div ref={inViewRef} className="stage-doc-preview">
      <div className="stage-doc-preview-edge" />
      {data ? (
        <div
          ref={contentRef}
          className="stage-doc-preview-content stage-doc-content"
          // Server-relayed, Vault-sanitized HTML (RenderedDocResponse.html,
          // docs/EMBEDS.md §6.1/§7 Contract B) — never fetched client-side
          // from Vault directly, never user-authored. Den doesn't
          // reimplement Vault's renderer (locked principle, §1); this is the
          // one place its sanitized output gets painted.
          dangerouslySetInnerHTML={{ __html: data.html }}
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-text-muted">
          {isLoading ? <Loader2 size={18} className="animate-spin" /> : <FileText size={22} />}
        </div>
      )}
      <div className="stage-doc-preview-fade" />
    </div>
  );
}
