# UI Revamp Plan

> **Status:** Planning — not started.
> **Relationship to BACKBONE.md:** This doc plans the execution of BACKBONE §9 ("Frontend / UI — Instagram-flavored"), which was written MVP-first and mobile-only. It does not change scope, schema, API, or WS contracts — this is presentation-layer only. When work here lands, §9 gets rewritten to match reality and a Decision Log entry gets added, same as every other stage.
> **Trigger:** All of Stages 0-5 (MVP feature set) are functionally built. Per standing user feedback, UI polish was deliberately deferred until features were complete and workable — that point has been reached.

---

## 1. Goals & guardrails

**Goal:** every screen feels like one coherent app — Instagram-flavored per BACKBONE §9 — and works well as a genuine desktop layout, not just a stretched mobile view, without regressing any iOS/PWA behavior already built.

**Non-goals (hard guardrails, per CLAUDE.md):**
- No new features. Nothing in this doc adds anything to BACKBONE §2. If a UI idea implies new functionality (read receipts, reactions, message replies, etc.) it goes in §13 Icebox, not here.
- No auth/data-model/API/WS changes. This is styling, layout, and interaction polish on top of what already exists.
- No third-party CDN assets, fonts, or analytics (CLAUDE.md hard invariant 10). The one new dependency below is npm-bundled at build time, not a runtime CDN fetch — confirmed with the user as an acceptable exception to "prefer asking before adding a dependency."
- Stages below ship in order, each independently shippable/testable, same discipline as BACKBONE §14. Don't start UI-3 while UI-2 is unverified.
- Real-device testing (Samsung + iPhone) remains gated on hardware access, same as every prior stage — each UI stage gets a desktop self-test + a note that the device pass is still pending, not a false "done."

**New dependency:**
| Package | Why | Note |
|---|---|---|
| `lucide-react` | Consistent icon set, replaces ad-hoc emoji (📎🎤🖼️■✕▶) that render inconsistently across platforms/fonts. Tree-shaken into the client bundle at build time — no CDN, no runtime fetch. Same library used by the reference app (Mosaic). | Add to `app/package.json` in UI-1. |

---

## 2. Current-state audit

Read every screen (`AuthScreen`, `ChatList`, `ChatView`, `FriendsScreen`, `NewGroupScreen`, `Profile`, `GalleryScreen`, `ChatGallery`, `MediaViewer`, `MediaBubble`, `App.tsx`) plus `index.css`. Findings:

- **No desktop layout exists.** Every screen is `min-h-[100dvh] flex-col` with no max-width wrapper (`AuthScreen` is the sole exception, capped at `max-w-sm`). On a wide viewport the whole app is one giant full-bleed column.
- **Zero design tokens.** `index.css` is just `@import 'tailwindcss'` with no `@theme` block. Every component independently hardcodes `indigo-600` / `neutral-*` / `black/10` utility strings. No single place to retheme from, and small inconsistencies have already crept in (e.g. spacing/radius values vary screen to screen).
- **Icons are emoji**, not a real icon set — inconsistent rendering risk across platforms (relevant per CLAUDE.md's platform-reality section).
- **Navigation is a single discriminated-union `View` in `App.tsx`** (`{ name: 'chats' } | { name: 'chat', chat, jumpToMessageId? } | ...`), one view rendered at a time, no router. This is fine for mobile but can't express "list pane + open chat pane visible simultaneously" as-is — it needs to grow, not be replaced.
- **Gallery is a fixed 3-column square grid** (`ChatGallery.tsx`), tiles force-cropped via `aspect-square` + `object-cover` — portrait/landscape media all get mangled to the same shape. `GalleryScreen.tsx` (top-level albums) has the same issue.
- **`MediaViewer` has no gestures** — prev/next are click-only arrow buttons; no swipe, pinch-zoom, or drag-to-close. Confirmed acceptable to add hand-rolled Pointer Events gestures (see UI-6).
- Every screen's header/back-button/spacing pattern is copy-pasted per-component rather than shared — a source of the "pages aren't coherent with each other" feeling.

---

## 3. Reference points taken from Mosaic (`C:\Things\Projects\mosaic\web`)

Investigated for design/implementation patterns only — Mosaic is a booru browser with different requirements (floating draggable windows, related-post side panels), so only the *techniques* below transfer, not the specific UI:

1. **Design tokens as CSS custom properties**, `:root`/`[data-theme]` scoped, light+dark parallel palettes, `color-mix()` for translucent surfaces. One file (`global.css`) is what makes dozens of components look coherent — most surfaces just reuse 4-5 tokens (`--bg-surface`, `--glass-border`, `--shadow-soft`, `--radius-md`).
2. **One JS breakpoint hook drives structural component swaps; CSS media queries at the same pixel value drive cosmetic-only sizing.** `useIsMobile()` (`matchMedia`, includes a `pointer:coarse` clause for landscape phones) — components branch their *component tree* on this, not just their styling.
3. **Masonry gallery**: predicts item height from width/height metadata before the image loads (no pop-in), packs each item into whichever column is currently shortest (real Pinterest-style packing, not CSS `column-count`, which breaks reading order), ~40 lines of layout code. Windowing/virtualization only kicks in past 120 items — irrelevant at Den's friend-group media volume, skip it.
4. **Full-screen viewer gestures**: ~180 lines of raw Pointer Events, no library. Swipe threshold is distance-OR-velocity (fast short flick counts even under the distance threshold); pinch-zoom tracks two pointer IDs in a `Map`; double-tap uses a manual timing+distance window; `setPointerCapture` so drags that leave the media element's bounds don't drop the gesture.
5. **lucide-react** everywhere, sized via a `size` prop, colored via `currentColor` so icon color follows button/text state rather than being set individually.

Not porting: floating/resizable/draggable windows, multi-panel related-post system, panel masonry, windowing/virtualization — all overkill for Den's scale and out of scope for a friend-circle chat app.

---

## 4. Target architecture

### 4.1 Design tokens

New file `app/src/index.css` gets a Tailwind v4 `@theme` block (or a parallel `tokens.css` imported before it — decide at implementation time) defining, at minimum:

- Surface colors: `--surface`, `--surface-raised`, `--surface-sunken` (light + dark)
- Text colors: `--text-primary`, `--text-secondary`, `--text-muted`
- Border: `--border` (replaces ad-hoc `black/10` / `white/10`)
- Accent: keep `indigo-600` as the brand accent (already used everywhere, no reason to churn it) but name it `--accent` / `--accent-hover` so it's changeable in one place
- Radius scale: `--radius-sm` (8px) / `--radius-md` (12px) / `--radius-lg` (16px) / `--radius-pill` (999px) — replacing today's inconsistent `rounded-lg`/`rounded-xl`/`rounded-2xl` mix
- Shadow: `--shadow-soft`, `--shadow-strong` (mostly for the floating media viewer / dropdowns)

Existing Tailwind `dark:` (`prefers-color-scheme`) stays as the mechanism — no manual theme toggle is in MVP scope, this is just formalizing the palette, not adding a light/dark switch UI.

### 4.2 Responsive shell

New hook `app/src/hooks/useIsMobile.ts`:
```ts
const MOBILE_MAX_WIDTH = 768; // keep in sync with the CSS media query below
```
(768 rather than Mosaic's 720 — Tailwind's own `md:` breakpoint is 768, so component *and* CSS-utility breakpoints line up instead of introducing a second magic number.)

`App.tsx`'s `AuthedApp` restructures around this:
- **Mobile (`isMobile === true`, current behavior preserved):** single view at a time, bottom tab bar (Chats/Gallery/Profile), exactly what exists today.
- **Desktop (`isMobile === false`):** left icon rail (replaces bottom tabs) + content area. For the Chats tab specifically, content area becomes **two panes**: conversation list (fixed width, ~360px) on the left, active chat on the right. This requires `View` to grow an optional "what's open in the right pane while list is visible" concept for desktop — simplest approach: keep `View` as-is for mobile navigation semantics, and on desktop keep `chats`-mode always rendering `ChatList` in the left pane regardless of `view.name`, with the right pane rendering `ChatView`/empty-state based on `view`. Gallery and Profile tabs stay single-pane (no natural second pane) on both layouts.
- Friends/NewGroup screens: on mobile these push over the whole screen (current behavior). On desktop these render as a centered modal/sheet over the shell rather than replacing the list pane — avoids losing the open chat when you go add a friend.

### 4.3 Navigation model change (the one real structural risk in this plan)

Today `AuthedApp` renders exactly one `View` full-screen. Moving to dual-pane means the chat list and the open chat must be able to render *simultaneously* on desktop. Plan: keep the existing `View` union as the single source of truth for "what's active," but let the render logic consult `isMobile` to decide whether that translates to "replace everything" (mobile) or "fill the right pane, keep the list mounted" (desktop). No new state shape needed — this is a render-logic change in `AuthedApp`, not a data model change. Flag this as the part most likely to surface edge cases (e.g. gallery-from-chat navigation, jump-to-message) — budget real testing time here.

---

## 5. Staged build order

Same discipline as BACKBONE §14: ship in order, each stage self-testable and independently shippable, checkpoint before starting the next.

**UI-1 — Foundations (tokens + icons):**
- [ ] Design tokens file/`@theme` block (§4.1).
- [ ] Add `lucide-react`; replace every emoji usage (`ChatView` attach/mic/stop, `ChatView`/`MediaBubble` play glyph, `MediaViewer` close/arrows, `ChatGallery`/`GalleryScreen` gallery glyphs) with icon components.
- [ ] Unify header pattern (back button, title, safe-area padding) into one shared `<ScreenHeader>` component used by every screen that currently hand-rolls it (`ChatList`, `ChatView`, `FriendsScreen`, `NewGroupScreen`, `ChatGallery`).
- [ ] Normalize radius/spacing usage across all screens to the new token scale.
- No layout/behavior changes in this stage — pure visual/consistency pass. Lowest risk, do it first.

**UI-2 — Responsive shell:**
- [ ] `useIsMobile()` hook.
- [ ] Desktop icon rail (replaces bottom tabs above the breakpoint).
- [ ] Dual-pane Chats view (list + active chat) on desktop, per §4.2/§4.3.
- [ ] Friends/NewGroup as centered overlay on desktop vs full-screen push on mobile.
- [ ] Verify: resize a real browser window across the breakpoint repeatedly with an open chat, confirm no state loss (draft text, scroll position, upload-in-progress).

**UI-3 — Chat screens (Instagram DM feel):**
- [ ] `ChatList`: avatar treatment, unread-badge polish, hover/active states for desktop (mouse) vs tap states for mobile.
- [ ] `ChatView`: bubble spacing/tails, composer restyle with new icons, upload-progress bar restyle.
- [ ] `MediaBubble`: replace emoji labels, restyle processing/failed states with tokens.

**UI-4 — Auth, Friends, Profile, New Group:**
- [ ] `AuthScreen`: restyle within new tokens, works as a centered card on both mobile and desktop (already closest to correct).
- [ ] `FriendsScreen`, `NewGroupScreen`, `Profile`: token/icon pass, desktop centered-card treatment consistent with the overlay behavior from UI-2.

**UI-5 — Gallery masonry:**
- [ ] Hand-rolled masonry layout (shortest-column packing, predicted aspect ratio from already-known media dimensions — `MediaInfo` likely already carries width/height from the sharp/ffprobe pipeline; confirm and wire through if not) replacing `ChatGallery`'s fixed 3-col grid and `GalleryScreen`'s fixed 2-col album grid.
- [ ] No virtualization/windowing — not needed at this scale (§3.3).
- [ ] Voice rows stay a separate list below the grid, unchanged in kind (per BACKBONE §9, voice is never a thumbnail).

**UI-6 — Media viewer polish:**
- [ ] Hand-rolled swipe (prev/next + swipe-down-to-close) and pinch/double-tap zoom via Pointer Events, mirroring Mosaic's thresholds (§3.4).
- [ ] Keep desktop arrow-button nav in addition to swipe (no reason to remove it — mouse users benefit from both).
- [ ] Tag editor visual pass (tokens/icons), behavior unchanged.

**After UI-6:** update BACKBONE §9 to describe the shipped shell/gallery/viewer, add a Decision Log entry, and do the same desktop-browser self-test pass used for every prior stage (a real device pass stays gated on hardware, as always — flag it, don't fake it).

---

## 6. Testing approach per stage

No browser automation is available in this environment (established in a prior session). Verification per stage:
1. Self-review the running dev server (`npm run dev`) at multiple viewport widths via browser devtools resize, both light/dark.
2. Ask the user to click through the stage's screens on their desktop browser and report back, same pattern used for Stages 3-5.
3. Real Samsung/iPhone pass stays a standing gate, noted per stage, not resolved until hardware is available — consistent with every prior stage's Decision Log entries.

---

## 7. Open risks

- **UI-2's dual-pane restructure is the one piece with real logic risk** (not just styling) — it touches `App.tsx`'s navigation, which also drives jump-to-message and gallery-to-chat flows built in Stage 4. Test those flows specifically after UI-2, not just "does it look right."
- **Masonry (UI-5) needs real media width/height at layout time.** Confirmed already present — `MediaInfo` (`shared/src/api.ts:195-196`) carries `width`/`height` (nullable) from the Stage 3 sharp/ffprobe pipeline. No prerequisite work; just use them directly for aspect-ratio prediction, with the same `4/3` fallback Mosaic uses for the rare `null` case (e.g. a still-processing item).
- **iOS-specific risk carried forward, not new:** swipe gestures in UI-6 must not fight Safari's own edge-swipe-back gesture or the PWA's `overscroll-behavior: none`. No way to verify without the device pass.
