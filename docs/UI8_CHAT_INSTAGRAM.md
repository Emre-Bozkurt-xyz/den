# UI-8 — Chat: Instagram-flavored interaction pass

> **Status:** Planned — not started. Handoff spec for an implementing agent.
> **Relationship to the plan of record:** This is a follow-up stage to `docs/UI_REVAMP.md` (which took Stages UI-1…UI-7). Treat it as **UI-8** in that doc's §5 build order. Same guardrails as every stage there. When it lands, fold a short UI-8 summary into `UI_REVAMP.md §5`, update `BACKBONE.md §9`, and add a `BACKBONE.md §15` Decision Log entry — same discipline as prior stages.
> **Source:** Direct user feedback after living with the UI-7 chat screen, plus two reference screenshots (Instagram DM mobile; desktop hover action bar).

---

## 0. Guardrails (do not violate — these are why the repo is disciplined)

- **Presentation only.** No schema, API, or WS contract changes. No new BACKBONE §2 features. (One exception is explicitly *not* granted here: replies and reactions stay Icebox — see §2, request G.)
- **No third-party runtime JS / CDN / fonts** (CLAUDE.md hard invariant #10). **No animation library.** All animation is hand-rolled CSS transitions/`@keyframes` + raw Pointer Events, matching the existing `MediaViewer` gesture code. *If* the shared-element focus menu (request F) proves genuinely intractable by hand, `motion` (framer-motion, npm-bundled not CDN) is the sanctioned fallback — but stop and confirm with the user before adding it; do not reach for it first.
- **Server is truth, client is a cache** (invariant #3). None of this persists anything new client-side.
- **Design tokens only** (`app/src/index.css` `@theme`): `surface`/`surface-raised`/`surface-sunken`, `text-primary`/`text-secondary`/`text-muted`, `border`, `accent`/`accent-hover`, `rounded-sm/md/lg/pill`, `shadow-soft/strong`. Accent-text-on-dark and error colors stay literal (`text-indigo-600 dark:text-indigo-400`, `text-red-600 dark:text-red-400`) — established precedent, there is no token for them.
- **Ships in order**, each sub-stage independently verifiable. Don't start UI-8d before UI-8c is checked.
- **TypeScript strict**, no `any` without a justifying comment. `npm run typecheck && npm run lint && npm run test` must pass before any sub-stage is "done".
- **iOS is load-bearing but undevvable here.** Dev device is Android; most users are iPhone. Every iOS-divergent thing (MediaRecorder container, AudioContext gesture rule, `backdrop-filter` support, `100dvh`, safe areas, touch gestures vs Safari edge-swipe) gets flagged onto the standing device-test gate, never silently called done.

---

## 1. Current state (what exists, so you refactor rather than rebuild)

- **`app/src/components/ChatView.tsx`** (~886 lines) — owns the message list, the composer `<form>`, multi-select/delete, the long-press→bottom-sheet action menu, upload, and inline `startRecording`/`stopRecording` (a plain Mic⇄Square toggle). Also holds `MessageBlockRow` (the per-block renderer) at the bottom of the file.
- **`app/src/lib/messageGroups.ts`** — `groupMessages()` builds **runs** (same sender, ≤`RUN_WINDOW_MS`=5min) of **blocks** (single message, or a fanned stack of adjacent bare photos/videos). `MessageBlockRow` currently knows only `isRunTail` (last block in run) and tightens one corner on that block. Nothing knows about run *head*/*middle* position, and there are **no date/time dividers**.
- **`app/src/components/VoiceMessage.tsx` + `app/src/lib/waveform.ts`** — custom voice player; RMS peaks decoded client-side via `OfflineAudioContext`, deterministic placeholder before first play. **Reuse `toPeaks`/bar-rendering ideas for the live recording waveform** (request C), but note the recording waveform is *live* (AnalyserNode), not decoded-from-file.
- **`app/src/hooks/useIsMobile.ts`** — `useIsMobile()`, 768px, drives *structural* branching (mobile gestures vs desktop click). Use it to gate the recording gestures and hover bar.
- **`app/src/App.tsx`** — renders `ChatView` on both mobile (full-screen) and desktop (right pane), each `key={chat.id}`. Per-chat draft cache lives here. The desktop overlay pattern (`fixed inset-0 z-50 … bg-black/40`) at line ~258 is the reference for how this repo does full-screen overlays — mirror it for the focus menu portal.
- **`app/src/lib/realtime.tsx`** — `sendMessage` inserts an optimistic `pending:<reqId>` bubble immediately, reconciled on the `message.new` WS frame. **This is the hook point for the send animation** (request A): the optimistic bubble is the "new" element to animate.
- **`shared/src/api.ts`** — `Message { id, chatId, senderId, kind, body, createdAt, media }`. `createdAt` is ISO 8601 — the only timestamp you need for dividers and the action-menu time.

---

## 2. The seven requests → mapped

| # | Request | Sub-stage |
|---|---|---|
| A | Message send is animated (subtle, not flashy) | **UI-8a** |
| B | Bubbles in a run connect cleaner (flat corners on sender side for non-tail bubbles) | **UI-8b** |
| C | Recording morphs the composer into a live-waveform recording bar; hold-to-record / slide-up-to-lock / slide-left-to-cancel on mobile, button transitions on desktop | **UI-8e** |
| D | Time-of-day / date partitions in the message list | **UI-8b** (ships with the grouping refactor) |
| E | Action menu shows the message's send time | **UI-8c** |
| F | Action menu = iMessage "focus" effect: bubble lifts/highlights, bg slightly blurs, action bar drops from it; covers ~55–60% with clean margins; opens from the three-dots on desktop | **UI-8d** |
| G | Desktop hover shows a small action bar next to the bubble — three-dots **+ reply + react-emoji** (reply/react are visual-only placeholders) | **UI-8c** |

Recommended build order: **8a → 8b → 8c → 8d → 8e**. (A and B are self-contained and low-risk; C/D grouping is a refactor everything else reads; the focus menu D depends on the action bar C; recording E is the largest and most iOS-sensitive, do it last.)

---

## UI-8a — Send animation

**Goal:** a new outgoing (and freshly-arrived incoming) bubble eases in — small scale-up + slide-up + fade, ~150–200ms, one spring-ish `cubic-bezier`. Nothing bouncy or long. History (already-present messages on chat open) must **not** animate.

**Approach (hand-rolled, no library):**
- Add a `@keyframes bubble-in` to `index.css` (translateY(6px)+scale(0.96)+opacity 0 → rest) and a `.animate-bubble-in` utility with `animation: bubble-in 180ms cubic-bezier(0.22,1,0.36,1)`.
- In `ChatView`, keep a `useRef<Set<string>>` of already-seen message ids. **Seed it on first render** with every id currently in `messages` (so the initial page doesn't animate). On each render, any id not in the set is "new" → pass an `intro` flag down to `MessageBlockRow`, which adds `.animate-bubble-in`. Add the id to the set after.
  - The optimistic `pending:<reqId>` bubble animates on insert; when it's replaced by the real id, that real id should be treated as already-seen (map the reqId→realid, or simpler: when a pending id disappears and a real one appears in the same position, don't re-animate — seed the real id into the set inside the same pass). Get this right or every send double-animates.
- `prefers-reduced-motion`: wrap the keyframe usage so reduced-motion users get an instant appear (`@media (prefers-reduced-motion: reduce)` → `animation: none`).

**iOS flag:** `transform`/`opacity` keyframes are GPU-cheap and safe on Safari; nothing special, but verify no scroll-anchor jump on the installed PWA when the bubble grows into place (the list auto-scrolls to `bottomRef`).

**Verify:** send a message (animates), reload the chat (history does not animate), receive a message from the other side (animates once).

---

## UI-8b — Run corner refinement + date/time dividers

Two things ship together because both are edits to `messageGroups.ts` + `MessageBlockRow`.

### B1 — Cleaner run corners (request B)
Instagram bubbles have no tail; ours keep a small tail on the run's last bubble (a deliberate Den choice — **keep the tail**), but the *inner* corners of a run should flatten on the sender's side so a burst reads as one connected column.

- Extend the block renderer to know its **position in the run**: `isRunHead` (first block), `isRunTail` (last block), else middle. `groupMessages` already has the run's block array — derive position at render in `ChatView` (you already map `run.blocks.map((block, bi) => …)`; pass `isRunHead={bi===0}` alongside the existing `isRunTail`).
- Corner rules on the **sender's side** (right for `mine`, left for others); the opposite side stays fully `rounded-lg`:
  - **Head:** sender-side **top** corner rounded, sender-side **bottom** tightened (`rounded-br-[4px]`/`rounded-bl-[4px]`).
  - **Middle:** both sender-side corners tightened.
  - **Tail:** sender-side **top** tightened, sender-side **bottom** is the existing tail corner. (Single-bubble run = head *and* tail = current behavior: only the tail corner, rest rounded. Preserve that exactly.)
- This is bubble-only. Bare media (photos/videos) and stacks are unaffected — they already render without a bubble.

### B2 — Date/time dividers (request D)
Instagram shows a centered muted label: a **date** when the calendar day changes ("Yesterday", "Monday", "July 12"), and a **time** ("4:23 PM") when there's a large gap within the same day.

- Add to `messageGroups.ts` a pure function that, given the ordered runs (oldest→newest as rendered), returns a flat render list interleaving `{ kind:'divider', label, id }` and `{ kind:'run', run }`. Insert a divider **before** a run when either: (a) its first message's calendar day differs from the previous run's last message day → **date label**; or (b) same day but gap > `DIVIDER_GAP_MS` (spec `60*60*1000` = 1h) → **time label**. Always emit a date divider before the very first run.
  - Date formatting: "Today" omitted (top of a same-day chat needs no "Today" header — match Instagram, which shows a time not "Today"); use "Yesterday", weekday name within the last 7 days, else `MMM D` (and `MMM D, YYYY` if a different year). Use `Intl.DateTimeFormat`, no date library.
- Render the divider as a centered `text-xs text-text-muted` row with comfortable vertical margin (`my-4`), matching the "YESTERDAY 4:23 PM" treatment in the reference (uppercase optional — pick one and note it).
- **Keyset pagination note:** messages load newest-first in pages and are flattened; dividers are computed over the currently-loaded flattened list. When "Load older messages" prepends a page, the divider set recomputes naturally (it's derived, not stored) — just make the function total over whatever's loaded.

**Verify:** a chat spanning multiple days shows date headers at each day boundary and a time label after a long same-day gap; a rapid burst shows none inside it. Run corners: a 3-message run has head/middle/tail corners; a lone message is unchanged.

---

## UI-8c — Action bar (hover, desktop) + action-menu time + reply/react placeholders

**Goal:** replace the single hovering three-dots button (currently `MoreVertical` only, desktop, in `MessageBlockRow`) with a small horizontal **action bar** that appears next to the bubble on hover, matching reference images #3/#4: `[⋮ more] [↩ reply] [🙂 react]`.

- Extract a `MessageActions` concept. The hover bar is desktop-only (`!isMobile`), positioned on the outside of the bubble (left of `mine`, right of others), vertically aligned, `opacity-0 group-hover:opacity-100` like today. Buttons, all `lucide-react`:
  - **More** (`MoreVertical`) → opens the focus menu (UI-8d). Keep the existing `onOpenActions(m)` wire, just repoint it at the new menu.
  - **Reply** (`Reply` / `CornerUpLeft`) → **visual-only placeholder.** No-op, or a subtle transient "Coming soon" affordance. `aria-label="Reply (coming soon)"`, `title` likewise. **Must not** create any reply state, quoted-message UI, or send-path change.
  - **React** (`Smile`) → **visual-only placeholder**, same treatment.
- **Scope note (do this):** add a line to `BACKBONE.md §13 Icebox` under replies/reactions: *"UI affordances (hover action bar + focus-menu buttons) exist as of UI-8 but are inert; wiring pending when the feature is built."* This keeps the dead affordances honest and discoverable.

**Action-menu send time (request E):** the menu (both the current bottom sheet and the new focus menu) gets a header line showing the message's send time, formatted from `message.createdAt` — full time, and date if not today (e.g. "4:23 PM" or "Jul 12, 4:23 PM"). Reuse the same `Intl` formatter helper from UI-8b (factor it into a small `lib/datetime.ts` so dividers, the menu, and any future use share one implementation).

**Verify:** desktop hover shows the 3-icon bar beside the bubble; reply/react are inert with correct a11y labels; the menu header shows the right time.

---

## UI-8d — Focus menu (iMessage-style lift + blur)

**Goal:** replace the bottom-sheet action menu (`actionMenuFor` block at the end of `ChatView`) with a focus effect: the tapped/clicked bubble is **highlighted/lifted**, the rest of the screen is **slightly blurred + dimmed**, and the action list **drops from the bubble**. The overlay covers ~**55–60%** of the screen with clean margins (never edge-to-edge). On desktop it opens from the three-dots (UI-8c "More"); on mobile from long-press (existing `onBubblePointerDown` → `setActionMenuFor`).

**Approach (hand-rolled portal, no library):**
- New component `MessageFocusMenu` rendered in a portal (or the existing top-level overlay slot pattern from `App.tsx:258`). It receives the target `Message` **and the bubble's `DOMRect`** — capture it via the existing `messageRefs` map (`messageRefs.current.get(id)?.getBoundingClientRect()`) at the moment the menu opens; store rect in the `actionMenuFor` state (change it from `Message | null` to `{ message, rect } | null`).
- Layers:
  1. **Backdrop:** `fixed inset-0`, `backdrop-filter: blur(4px)` + `bg-black/30`, click-to-dismiss. Fade in ~150ms.
  2. **Lifted bubble:** a **clone** of the bubble content, positioned `fixed` at the captured rect, then transitioned to its focused resting position (a subtle scale-up ~1.03 and, if the menu would overflow the viewport bottom, nudged up so bubble+menu fit). Animate `transform` from identity → resting. The real bubble underneath stays put (hidden behind the backdrop blur).
  3. **Action list:** drops in just below (or above, if near the bottom) the lifted bubble — the send-time header (UI-8c) + Copy / Select / Delete (existing actions, same handlers) + the reply/react placeholders if you want them here too. Constrain width to a comfortable panel (`max-w-xs`/`~60%`), rounded-md, `shadow-strong`, `bg-surface-raised`. Slide/scale in ~150ms after the bubble settles (small stagger).
- Dismiss on backdrop click, Escape (desktop), or action selection. Reverse the transition on close (or just fade — pick one; note it).
- Keep every existing action handler (`handleMenuCopy`, `enterSelectionMode`, `handleMenuDelete`) — only the *presentation* changes. Delete still only shows for `senderId === me.id`; Copy only when `body`.

**iOS flags (important):**
- `backdrop-filter` is supported on iOS Safari 16.4+ (our floor) but is a known perf/quirk area in installed PWAs — **flag for device test**; provide a graceful fallback (if `backdrop-filter` unsupported, fall back to a heavier `bg-black/50` dim, no blur).
- The lifted-bubble clone must not capture the mic/scroll; it's display-only. Verify long-press → menu doesn't fight the list scroll (the existing long-press slop logic already handles this — don't regress it).
- Safe areas: the panel must respect `env(safe-area-inset-bottom)` when it lands near the bottom.

**Verify:** desktop three-dots and mobile long-press both open the focus menu; background blurs+dims; bubble lifts; menu never exceeds ~60% / never goes edge-to-edge; all three existing actions work; Escape/backdrop dismiss.

**Fallback trigger:** if the shared-element lift (capturing rect + animating a clone to rest without visible jank) turns into a rabbit hole, **stop and raise `motion` with the user** rather than shipping something janky — this is the one piece where the library was pre-approved as a fallback.

---

## UI-8e — Recording UX (composer → live-waveform recording bar)

**Biggest and most iOS-sensitive sub-stage. Extract the composer out of `ChatView` first** (it's already 886 lines): new `Composer.tsx` owning text input + attach + mic/send + the recording state machine, and a `RecordingBar.tsx` for the active-recording UI. `ChatView` passes `onSend`, `onPickFiles`, upload/recording callbacks down. This keeps the state machine testable and `ChatView` readable.

**Goal:** pressing the mic morphs the whole composer into a recording bar with a **live** waveform of the incoming audio + elapsed timer. Gestures (mobile only):
- **Hold to record:** pointerdown on mic starts recording; release ends+sends (push-to-talk).
- **Slide up to lock:** dragging up past a threshold locks hands-free recording (release no longer sends); bar then shows a stop button to finish+send.
- **Slide left to cancel:** dragging left to a stop/trash target (square stop icon at the far left, per the reference) cancels and discards.
- **Desktop:** no gestures — click mic to start (bar transitions in), with explicit **stop/send** and **cancel** buttons. Same visual bar, click-driven.

**State machine** (`type RecState = 'idle' | 'requesting' | 'recording' | 'locked' | 'cancelling'`):
- `idle → requesting` on mic press (call `getUserMedia`); `requesting → recording` on stream grant (or back to `idle` + error on deny).
- `recording → idle(send)` on release (unlocked) or stop button; `recording → locked` on slide-up; `recording → idle(discard)` on slide-left-cancel.
- `locked → idle(send)` on stop; `locked → idle(discard)` on cancel.
- Reuse the existing `MediaRecorder` capture + `runUpload(blob,'voice',…)` from `ChatView` — **don't rewrite the upload/transcode path.** Only the trigger UI changes.

**Live waveform:** tap the same `MediaStream` with a Web Audio `AnalyserNode` (`createMediaStreamSource` → `AnalyserNode`, read `getByteTimeDomainData`/`getByteFrequencyData` in a rAF loop) to drive a scrolling/rolling bar display. Mirror `VoiceMessage`'s centered-bars visual language (draw in `currentColor`, centered/mirrored). This is **live** levels, not decoded peaks — distinct from `lib/waveform.ts`, but visually consistent.

**Transition animation:** the composer→bar swap is a cross-fade + width morph (text input collapses, waveform+timer+cancel-affordance expand), ~200ms, hand-rolled CSS. Desktop and mobile share the transition; only the gesture layer differs.

**Gestures:** raw Pointer Events on the mic button, same pattern as `MediaViewer` (`setPointerCapture`, track dx/dy from pointerdown origin, thresholds as named constants grouped at the top for later real-device tuning). Slide-up-lock threshold ~ -80px dy; slide-left-cancel ~ -120px dx to the stop target. Provide visual feedback that follows the finger (a lock chevron that fills as you approach the lock threshold; the bar sliding toward the cancel target).

**iOS flags (all must go on the device-test gate):**
- `getUserMedia` requires the installed PWA + a user gesture — starting on the mic **pointerdown** satisfies the gesture; **do not** start it behind an `await` that loses the gesture association.
- `AudioContext` for the AnalyserNode needs a user gesture + may need `resume()` on iOS — create/resume it inside the pointerdown handler.
- `MediaRecorder` yields `audio/mp4` on iOS Safari and `audio/webm;codecs=opus` on Chrome — **both already handled** by the server transcode; don't add format branching (invariant, CLAUDE.md "Voice").
- Pointer-drag gestures must not fight Safari's edge-swipe-back or the PWA's `overscroll-behavior: none` — same standing risk as UI-6.
- These gesture thresholds are convention-based defaults; note them as untuned pending the Samsung/iPhone pass, exactly like UI-6 did.

**Verify (desktop first, then flag device):** desktop click-to-record transitions the bar in, shows a live waveform + timer, stop sends, cancel discards. Empty-composer-only mic (existing rule: mic only shows when the composer is empty) preserved. Error paths (mic denied) surface the existing `uploadError`.

---

## 3. New/changed files (summary for the implementer)

- `app/src/index.css` — `@keyframes bubble-in` + reduced-motion guard (8a); any shared transition utilities.
- `app/src/lib/datetime.ts` — **new.** Shared `Intl`-based formatters: divider labels, action-menu send time. (8b/8c)
- `app/src/lib/messageGroups.ts` — run-position awareness + divider interleaving function. (8b)
- `app/src/components/ChatView.tsx` — wire intro-animation set (8a), run head/tail props + divider rendering (8b), repoint action trigger, `actionMenuFor` state carries the rect (8c/8d), delegate composer.
- `app/src/components/MessageActions.tsx` (or similar) — **new.** Desktop hover bar (⋮ / reply / react). (8c)
- `app/src/components/MessageFocusMenu.tsx` — **new.** Portal focus menu with lift + blur. (8d)
- `app/src/components/Composer.tsx` + `app/src/components/RecordingBar.tsx` — **new.** Extracted composer + recording state machine + live waveform. (8e)
- `docs/UI_REVAMP.md §5`, `docs/BACKBONE.md §9` + §13 + §15 — doc updates on completion.

## 4. Cross-cutting

- **`prefers-reduced-motion`:** every animation (8a bubble-in, 8d lift/blur, 8e transition) must degrade to instant/none under it.
- **Multi-select interplay:** the focus menu (8d) and hover bar (8c) must not appear while `selectionMode` is active (today's long-press-in-selection toggles selection instead — preserve that branch in `onBubblePointerDown`). Stacking is off in selection mode; don't regress.
- **Pending bubbles** (`pending:` ids) are never actionable — no hover bar, no focus menu, no selection. Current code guards this; keep it.
- **Testing reality:** no real touch hardware in this environment. Do the desktop self-test per sub-stage (Playwright/devtools, light+dark, mobile+desktop widths), and explicitly flag the mobile-gesture and iOS pieces (8d blur, 8e all gestures + getUserMedia/AudioContext) as pending the standing Samsung/iPhone gate. Don't fake a device pass.

## 5. Definition of done (per sub-stage)

`npm run typecheck && npm run lint && npm run test` green · desktop self-test done in both themes and both breakpoints · iOS-divergent items listed on the device-test gate with the specific risk · `UI_REVAMP.md`/`BACKBONE.md` updated when the whole of UI-8 lands.
