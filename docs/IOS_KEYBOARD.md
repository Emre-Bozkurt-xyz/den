# iOS Keyboard & Composer Pinning (visualViewport pass)

**Status:** planned — not started. Fixes the known-unbuilt `visualViewport` composer quirk (PROJECT.md §12/§13), owner-confirmed from real-device testing (composer misbehaves when the iOS keyboard opens). Standalone task — benefits every chat now, and is a **prerequisite for the Vault portal** (`docs/EMBEDS.md` Phase 4).
**Executor note:** read CLAUDE.md and PROJECT.md §11 (frontend), §12 (platform reality) first. This is the single most device-specific surface in the app — **definition of done is real-device iPhone sign-off (Safari *and* installed PWA), not a green typecheck.** Dev device is Android; you cannot self-verify this.

---

## 1. The problem

On Android Chrome the layout viewport resizes when the soft keyboard opens, so a bottom-anchored composer (`env(safe-area-inset-bottom)`, `100dvh`) naturally sits above it. **iOS Safari does not resize the layout viewport** — the keyboard overlays the page. Result on iPhone: the composer is hidden behind the keyboard, or the page scrolls in a way that leaves the input off-screen / floating, and the last messages get covered. `100dvh`, `100vh`, and `env(safe-area-inset-*)` cannot see the keyboard — only the **`visualViewport`** API can.

## 2. The mechanism

`window.visualViewport` reports the *actually visible* region. When the keyboard opens, `visualViewport.height` shrinks and (on scroll) `visualViewport.offsetTop` moves. The keyboard's intrusion at the bottom is:

```
keyboardInset = layoutViewportHeight - visualViewport.height - visualViewport.offsetTop
```
(`layoutViewportHeight` = `window.innerHeight`; clamp `keyboardInset` to `>= 0`).

Drive the composer's bottom offset from that value, listening to **both** `visualViewport` `resize` and `scroll` (iOS fires `scroll` as the viewport pans, e.g. when focus moves or the keyboard animates):

- Keyboard **closed** (`keyboardInset ≈ 0`): composer bottom = `env(safe-area-inset-bottom)` (today's behavior).
- Keyboard **open** (`keyboardInset > 0`): composer bottom = `keyboardInset`, and **drop the safe-area inset** (the home indicator is hidden behind the keyboard — adding both double-counts and leaves a gap).

Expose the value as a CSS variable set from JS (e.g. `--kb-inset`) so the composer container positions with `padding-bottom` / `transform: translateY(-var(--kb-inset))` and the message list keeps its last message visible above it.

## 3. Implementation sketch

- **New hook `app/src/hooks/useKeyboardInset.ts`:** subscribes to `visualViewport` `resize`+`scroll`, computes clamped `keyboardInset`, writes it to a CSS var on the chat root (or returns it). Cleans up listeners on unmount. rAF-throttle the handler (iOS fires these rapidly during the keyboard animation).
- **Feature-gate to where it's needed.** Only engage when `window.visualViewport` exists *and* the platform actually overlays (iOS). On Android — where the layout already resizes — applying an inset double-counts and pushes the composer up by a keyboard's height into empty space. Gate on a small iOS/visualViewport-overlap check; when off, fall back to today's `env(safe-area-inset-bottom)` path unchanged.
- **Integration points:** `Composer.tsx` (the bottom-anchored container) consumes the inset; `ChatView.tsx` owns the scroll-to-keep-last-message-visible behavior. Reconcile with the existing scroll-to-bottom logic and the `PreviewImage` reserved-height fix (§14 2026-07-22) so opening the keyboard doesn't fight scroll restoration.
- **Consider the modern complement, don't rely on it:** the `interactive-widget=resizes-content` viewport-meta value makes some browsers resize the layout for the keyboard. Support is uneven on the iOS versions in the field, so treat it as a nice-to-have layered *under* the JS path, never the sole fix. If added, re-test that it doesn't double-count with the JS inset.
- **No new dependencies** — hand-rolled Pointer/viewport handling, consistent with invariant 10 and Den's existing gesture precedent.

## 4. Cases that must be checked on a real iPhone (the gate)

Safari **and** installed PWA (standalone), both orientations:
1. Focus the composer → keyboard opens → composer sits flush above the keyboard, last message visible; no gap, no overlap, no float.
2. Blur / send / dismiss → composer returns to the safe-area rest position cleanly (no lingering inset).
3. Keyboard-height changes mid-session: switch to the emoji keyboard, the autocorrect/predictive bar appearing/disappearing, third-party keyboards — the inset tracks each change.
4. Reply-preview bar and image-paste/upload chips present above the input → they move with the composer as one unit.
5. Rotate to landscape with the keyboard open.
6. Scroll the message list while the keyboard is open — composer stays pinned, `visualViewport scroll` doesn't cause jitter.
7. Notch/Dynamic-Island devices and a non-notch device (safe-area inset differs).
8. **Android regression check** (Samsung, dev device): keyboard open/close behaves exactly as before — the gate did not engage the iOS path.

## 5. Bookkeeping (with implementation, not after)

- PROJECT.md §12: move "`visualViewport` composer pinning against the iOS keyboard" out of *Known-unbuilt* once real-device-verified; note the verification date/device.
- PROJECT.md §13: mark the item shipped.
- PROJECT.md §14: short decision-log entry — visualViewport JS inset (iOS-gated) over `interactive-widget` alone, and why (field support).
- Cross-reference from `docs/EMBEDS.md` §6.5 (already points here as a portal prerequisite).

## 6. Verification (definition of done)
- `npm run typecheck && npm run lint && npm run test` green.
- The §4 real-device iPhone matrix passes (Safari + installed PWA), **and** the Android no-regression check passes. Not done until the iPhone sign-off exists — this is explicitly a real-device gate, not a code-review gate.
