import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Sensitivity } from '@den/shared';

/**
 * The one blur treatment for sensitive media (docs/MEDIA_ATTACHMENTS.md
 * §5.4). Every surface that can show an `nsfw`/`spoiler` item renders through
 * this — chat bubbles, album mosaic tiles, the stack grid sheet, the
 * full-screen viewer, gallery tiles and the composer's attachment tray — so
 * the blur radius, the pill and the reveal affordance can never drift apart
 * between screens.
 *
 * ⚠️ This is cosmetic, NOT a security control (plan D10). The real thumbnail
 * bytes are delivered to every member of the chat and can be pulled out of
 * devtools. Making it real would mean generating a degraded thumbnail at
 * processing time, which cannot work retroactively — you can't un-generate a
 * thumb when someone tags a year-old photo. Do not describe this to users as
 * anything stronger than "hidden until tapped".
 *
 * Interaction rule, uniform everywhere: **first tap reveals, second tap
 * opens.** A blurred item never jumps straight into the viewer, so the
 * overlay swallows the tap that reveals it and the underlying media's own
 * onClick only ever sees taps after the reveal.
 */

const LABEL: Record<Sensitivity, string> = {
  nsfw: 'NSFW',
  spoiler: 'Spoiler',
};

export function SensitiveOverlay({
  sensitivity,
  blurred,
  onReveal,
  children,
  /** Small tiles (mosaic tiles, gallery grid, tray thumbs) show the icon
   *  alone — the pill's text doesn't fit and turns into a smudge. */
  compact = false,
  /** Matches the host's clipping so the blur can't bleed past a rounded
   *  corner. The wrapper is `overflow-hidden` regardless; this only sets the
   *  radius. */
  className = '',
  /** False = blur and label, but no reveal affordance: the tap belongs to the
   *  host. Used by gallery album covers, where tapping opens the album and
   *  "revealing" a decorative cover would be meaningless (the grid inside
   *  does its own per-item reveal). */
  interactive = true,
}: {
  sensitivity: Sensitivity | null;
  blurred: boolean;
  onReveal: () => void;
  children: ReactNode;
  compact?: boolean;
  className?: string;
  interactive?: boolean;
}) {
  // Not sensitive at all: render the media untouched, with no extra wrapper
  // element in the tree — this component must be free to wrap everything
  // unconditionally without perturbing layout for ordinary media.
  if (sensitivity === null) return <>{children}</>;

  return (
    <div className={'relative overflow-hidden ' + className}>
      <div
        // `scale` hides the transparent fringe a large blur radius pulls in
        // from outside the element's edges. ⚠️ iOS: `filter: blur()` over
        // several images in a scrolling list is a known perf risk on older
        // iPhones (PROJECT.md §12 device gate) — if it janks, the fallback is
        // a solid tint plus a tiny blur rather than dropping the feature.
        style={{
          filter: blurred ? 'blur(24px)' : undefined,
          transform: blurred ? 'scale(1.06)' : undefined,
          transition: 'filter 200ms ease-out',
        }}
      >
        {children}
      </div>

      {blurred && (
        // Deliberately a div with `role="button"`, NOT a <button>. Several
        // hosts are themselves buttons (gallery grid tiles, the stack grid
        // sheet's tiles), and a <button> inside a <button> is invalid HTML —
        // React builds it via createElement so nothing gets dropped, but the
        // nesting is still wrong and would bite anyone who later renders this
        // markup through an HTML parser or adds jsx-a11y. Fixing it here once
        // is better than restructuring every call site's tap wiring.
        <div
          {...(interactive ? { role: 'button', tabIndex: 0 } : { 'aria-hidden': true })}
          onClick={(e) => {
            if (!interactive) return;
            // Swallow the tap: the host's own onClick (open the viewer, open
            // the stack sheet) must not also fire on the reveal tap.
            e.stopPropagation();
            e.preventDefault();
            onReveal();
          }}
          onKeyDown={(e) => {
            if (!interactive) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.stopPropagation();
            e.preventDefault();
            onReveal();
          }}
          aria-label={interactive ? `${LABEL[sensitivity]} — tap to reveal` : undefined}
          className={
            'absolute inset-0 grid place-items-center bg-black/25 ' +
            (interactive ? 'cursor-pointer' : 'pointer-events-none')
          }
          style={{ touchAction: 'manipulation' }}
        >
          <span
            className={
              'flex items-center gap-1.5 rounded-pill bg-black/70 font-semibold text-white ' +
              (compact ? 'p-2' : 'px-3 py-1.5 text-xs')
            }
          >
            <EyeOff size={compact ? 16 : 14} />
            {!compact && (
              <>
                {LABEL[sensitivity]}
                {interactive && <span className="font-normal text-white/70">· tap to reveal</span>}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
