# In-app camera & composer rehaul

Owner-requested, pulled forward off the §13 roadmap (same posture as image paste, message edit, embeds, staged attachments). Plan doc per PROJECT.md §16; decisions below were settled in the design session of 2026-09-01 and are recorded here rather than re-derived at implementation time.

## 1. What we're building

Two things that only make sense together — the second exists to give the first a home:

1. **An in-app camera panel.** A full-screen capture surface reached from the composer: live camera feed, a shutter button, camera-switch, and a gallery shortcut. What it captures lands as a staged attachment on the current draft. **Photo only in this phase** — see §8 for why video is deliberately second.
2. **A composer rehaul.** The composer becomes a single Instagram-style pill that owns everything: the camera entry on the left, the text field filling the middle, and the media cluster (attach / GIF / mic) on the right. No dropdown, no controls floating outside the pill.

The composer today puts its buttons *outside* the text field, which is why there is nowhere to put a camera button — the row is already documented as tight at 360px (`Composer.tsx`, the GIF button's withdrawal comment). The rehaul is what creates the slot.

## 2. Non-negotiables that apply here

- **Media bytes never transit the API server** (invariant 2) — a captured frame is a client-side `Blob` → `File`, staged exactly like a picked file. The upload path is not touched at all.
- **Authorization = chat membership** (invariant 1) — no new routes, so nothing new to guard; the existing `POST /media/uploads` path already calls `assertMember`.
- **Server is truth** (invariant 3) — captures live in the same client-only `StagedAttachment` state as picked files and are deliberately lost on reload (docs/MEDIA_ATTACHMENTS.md D1/§2).
- **Never trust client-declared mime/size** (invariant 7) — our own capture is no more trusted than a picked file; it goes through the same HEAD + magic-number sniff at complete time.
- **EXIF/GPS stripped** (invariant 6) — satisfied twice over here: sharp strips metadata on re-encode as always, and a canvas-captured frame carries no EXIF to begin with. **A capture therefore has no GPS in it even before the server sees it**, which is strictly better than the picked-file path.
- **No third-party JS, no gesture/animation libraries** (invariant 10) — the shutter, its ring, and the panel's transitions are hand-rolled CSS + Pointer Events, same as every other gesture surface in the app.
- **Design tokens only** (PROJECT.md §11) — with one deliberate exception, §4.1 D6.

## 3. Decisions (settled — do not re-litigate during implementation)

| # | Decision | Why |
|---|---|---|
| D1 | **`getUserMedia` + canvas frame grab, not `ImageCapture.takePhoto()`.** | `ImageCapture` is Chromium-only — absent on iOS Safari, which is most of the circle. Canvas is the one portable path. Owner accepted the consequence knowingly (§3 D2). |
| D2 | **Accepted: capture resolution is the video track's, not the sensor's** — typically ~1080p/2MP against a phone camera's 12MP. | There is no portable way to do better today. Owner's call: ship this, revisit as browser support moves. The device gate (§10) should include an honest look at whether the quality is tolerable in practice. |
| D3 | **Photo only in phase 1; hold-for-video is phase 2** (§8). | All of the platform risk is concentrated in video (MediaRecorder with a video track on iOS, baked-in stream orientation, duration capping against the 500MB ceiling). Photo-only is a complete, useful feature by itself and gets the panel onto a real iPhone sooner. Phase 1 also never requests the microphone, so it prompts for exactly one permission. |
| D4 | **Capture → an in-panel review step (Use / Retake / Close), not an in-panel stack.** | Originally specced as "captures stack until a checkmark". Dropped because it roughly doubles the panel's state model for something the composer already does: the composer holds up to `MediaLimits.maxAttachments` (10) attachments, and the camera button stays available while a draft has attachments. So "take several photos into one message" is still fully reachable — one panel visit per shot, rather than a second batching UI inside the panel. |
| D5 | **The shutter overlaps the feed** — roughly 70% over the video, 30% on the black strip below. | Owner's call, matching Instagram. Also lets the black strip stay short, so the feed gets more of the screen. |
| D6 | **The camera button is an accent-filled circle inside the pill's leading edge.** | Matches the reference. This is the one place the composer uses a filled accent circle for something that isn't Send — deliberate: the camera is the primary media action and should read as such. |
| D7 | **The trailing cluster thins on `hasContent`, but attach stays.** GIF withdraws (unchanged from before) and the mic becomes Send (unchanged from before); camera and attach persist. | Five controls plus a text field does not fit 360px, so *something* has to give. But the reference's full collapse can't be copied literally: **you attach a photo to a message you have already started typing all the time**, and the tray's own "+" only exists once something is already staged — so hiding attach on `hasContent` would leave no way to attach to a typed draft at all. Same argument protects the camera. Withdrawing the GIF button alone is enough, and it is a rule the code already had for a documented reason (docs/GIFS.md §8 — a GIF *replaces* the composer's contents, so it is dead weight the moment there is a draft). ⚠️ Revised during implementation; the original decision said "collapse to Send alone" and that would have been a real regression. Measured at 360px: empty 155px of text field, typing 199px — i.e. *wider* than the 180px it had before this rehaul, in the state where it matters. |
| D8 | **The `+` (location / AI / drawing) is not rendered at all.** | Owner: not needed. A dead button costs 44px on the tightest row in the app. The concept keeps its place in the layout's ordering for later. |
| D9 | **The mic stays the rightmost control.** | It is the pointer-captured element backing the hold-to-record gesture, whose thresholds are tuned and dev-device-verified. Keeping it rightmost means the existing mic↔Send swap stays exactly where it is and the gesture is untouched by a layout rehaul. Non-negotiable during implementation. |
| D10 | **No flash/torch button**, despite it being in the reference screenshot. | Torch is `applyConstraints({advanced: [{torch: true}]})` — Chromium-only. It would work on the dev Samsung and silently do nothing for most of the circle, which is the worst possible outcome for a visible control. |
| D11 | **Front camera: preview mirrored, captured file NOT mirrored.** | Mirrored preview is what every user expects (it's what a mirror does). Un-mirrored output is what everyone else actually saw. This is a genuine toss-up and it is a one-line flip (`ctx.scale(-1, 1)`), so it is explicitly on the device-gate list to re-judge with a real selfie. |
| D12 | **Output is JPEG at quality 0.92**, not PNG, not WebP. | `canvas.toBlob('image/jpeg')` is universally supported; WebP `toBlob` is not, on older Safari. The server re-encodes to WebP regardless, so this is one lossy generation before an inevitable second — accepted in exchange for upload size (a 1080p PNG is ~3MB and this is a mobile-data app). If quality complaints appear, PNG is the lossless swap. |
| D13 | **Mobile only for now.** The camera button is not rendered on desktop; **the composer layout changes ship everywhere.** | Owner: main use is mobile, and desktop webcam capture is a different use case with no gesture story. Not hard to add later — the panel doesn't assume touch beyond the shutter's press handling. |
| D14 | **The composer rehaul restructures JSX slots only — no state-machine changes.** | `Composer.tsx` carries three rounds of iOS/Android keyboard fixes, `--kb-inset` padding ownership, the GIF panel's contents-replacement invariant, and the pointer-capture guarantee. Every ref, effect, handler and recState transition survives the rehaul unchanged. A rewrite would silently regress work that took multiple device passes to land. |
| D15 | **What you see is what you get: the capture is cropped to the visible feed.** | The preview is `object-cover` inside a letterboxed box, so the track is wider/taller than what's on screen. `drawImage` must use the matching source rect (§5.4) or the user gets framing they never saw. |

## 4. The composer rehaul

### 4.1 Layout

One pill (`rounded-[22px]`, `bg-surface`, `border-border`) is now the row. Inside it, `items-end` so the controls stay pinned to the bottom as the text field grows:

```
┌───────────────────────────────────────────────────────┐
│ (◉camera)  Message…            [img] [gif] [mic/send] │
└───────────────────────────────────────────────────────┘
```

- **Leading:** the camera button — a 40px accent-filled circle (D6). Mobile only, and only when `onOpenCamera` is actually supplied (D13), so the slot could ship with this rehaul without a dead control reaching anyone.
- **Middle:** the `textarea`, now transparent and border-less (the pill owns the border and the focus ring). Keeps `max-h-32`, `min-w-0 flex-1`, `rows={1}`, and the existing `onKeyDown` / `onPaste` / `onFocus` wiring verbatim.
- **Trailing:** attach (image icon, replacing today's paperclip), GIF, mic. Mic rightmost (D9). No `+` (D8).

**Control size is 40px, not 44px** (`h-10 w-10`), with `p-0.5` on the pill. That lands the pill at 45px against the pre-rehaul row's 44px — a 1px difference — while buying back the width four inline controls need at 360px. 40px is under the 44px touch-target ideal and is the deliberate cost of moving the controls inside the pill; it is on the device-gate list to confirm it doesn't feel fiddly in a real hand.

The form's outer `flex flex-col` stays — the attachment tray, the detected-embed chip and the `--kb-inset` padding all remain exactly where they are, above/around the pill. Only the inner `flex items-end gap-2` row becomes the pill.

### 4.2 The collapse rule (D7)

| Composer state | Leading | Trailing |
|---|---|---|
| Empty draft, no attachments | camera | attach, GIF, mic |
| Has draft text or staged attachments (`hasContent`) | camera | attach, **Send** (GIF withdraws) |
| `editing` | *(nothing)* | **Update only** |
| Recording (mobile, unlocked) | *(nothing)* | mic (the same element, never unmounted) |
| Recording (locked / desktop) | Cancel | Stop |

The `editing` row is today's behavior preserved (`docs/MESSAGE_EDIT.md` §4.3 — an edit only ever touches `body`, never media, so no media control may appear). The recording rows are today's behavior preserved too; the only change is that **the recording bar now takes over the whole pill's interior** rather than just the middle slot, with the mic anchored at its right edge.

`gifsEnabled === false` (no Klipy key server-side) removes the GIF button as it does today.

### 4.3 What must not change (D14)

Called out explicitly because these are the things a layout pass is most likely to break:

- The mic button element must remain **the same JSX branch across `idle → requesting → recording`** so the pointer-captured node is never unmounted mid-touch. The existing comment above the trailing slot says this; it stays true.
- `touchAction: 'none'` on the mic; `touchAction: 'manipulation'` on every other control.
- `onPointerDown={(e) => e.preventDefault()}` on Send and Update — the focus-steal suppression that keeps the soft keyboard from collapsing on send.
- The form's `paddingBottom` swap between `var(--kb-inset)` and `env(safe-area-inset-bottom)` (docs/IOS_KEYBOARD.md).
- The `gifOpen` branch replacing the composer's contents wholesale, inside the same `<form>`.
- `animate-composer-morph` on the textarea↔recording-bar swap.

### 4.4 Wiring the camera button

`Composer` gets one new prop, `onOpenCamera?: () => void`, and renders the button only when it is supplied and `isMobile` is true. `ChatView` owns the panel's open state and renders `<CameraPanel>`; the panel's output goes to the **existing `onAddFiles` path** (`ChatView.handleAddFiles` → `stageFiles` → `setAttachments`). No new staging, validation, upload or send code — `stageFiles` already enforces kind, per-kind size and `MediaLimits.maxAttachments`, and already reports "N skipped (up to 10 attachments)" if the panel returns one too many.

## 5. The camera panel (`CameraPanel.tsx`)

### 5.1 Shell

Full-screen, portalled to `document.body` **with an explicit `zIndex` on the outermost wrapper** — PROJECT.md §11's hard-won stacking lesson; a `position: fixed` element with `z-index: auto` paints at its parent's layer, and this mounts from inside the chat subtree where message blocks carry `relative z-10`.

Registers on the back stack: `useBackHandler(true, onClose, { escape: true })`.

Layout, top to bottom:

- **Feed box** — full width, `flex-1`, `bg-black`, `overflow-hidden`. The `<video autoplay muted playsinline>` fills it with `object-cover`. `playsinline` is not optional: without it iOS takes the video fullscreen into its native player.
- **Black strip** — fixed ~112px plus `env(safe-area-inset-bottom)`.
- **Shutter** — absolutely positioned, horizontally centered, straddling the boundary so ~70% sits over the feed (D5). A white filled circle inside a white ring with a gap, both hand-drawn; the ring scales/dims on press (`:active` + a pressed state) for the "reactive" feel. The ring is also where phase 2's video progress will draw (§8) — leave it a separate element rather than a `border` on the button.
- **Bottom-left** — gallery shortcut (opens the same hidden `<input type="file">` path). **Bottom-right** — camera switch.
- **Top-left** — close (✕).

Everything overlaying the feed gets a subtle scrim or drop shadow so white icons stay legible against a bright frame.

### 5.2 Stream lifecycle

```
getUserMedia({ video: { facingMode, width: {ideal: 1920}, height: {ideal: 1080} } })
```

No `audio` in phase 1 (D3) — one permission prompt, not two.

- Called from the panel's mount, which is itself downstream of the user's tap on the camera button. ⚠️ **iOS ties the camera prompt to the user gesture**, the same rule the mic path already documents in `Composer.tsx` — do not put an `await` before it.
- **Every track is stopped** on close, on unmount, and on `visibilitychange → hidden`. A live camera track in a backgrounded PWA is a battery and privacy problem, and iOS is the platform least likely to forgive it. Re-acquire on `visibilitychange → visible` if the panel is still open.
- Switching cameras stops the current stream before requesting the new `facingMode`. Some devices refuse two simultaneous streams.
- `width/height` are **hints, not guarantees** (D2) — never assume the returned track matches. Read `track.getSettings()` for the real dimensions.

### 5.3 Permissions & fallback

Three failure states, all landing on the same screen: a message plus a **"Choose from gallery"** button that opens the file input, and a Close.

| Cause | Message |
|---|---|
| `NotAllowedError` (denied) | Camera access is off for this site. Enable it in your browser settings. |
| `NotFoundError` (no camera) | No camera found on this device. |
| anything else | Couldn't start the camera. |

The panel must never be a dead end — the gallery path is always reachable from inside it, which is also why the gallery shortcut exists in the normal state.

### 5.4 Capture (D15 — this is the fiddly part)

The preview is `object-cover`, so the container shows a **crop** of the track. The capture must reproduce that crop exactly, or the photo contains framing the user never saw:

1. Read the track's real dimensions from `video.videoWidth/videoHeight`.
2. Compute the source rect the container is actually showing: compare the container's aspect to the track's, and inset the source on whichever axis overflows (this is the arithmetic `object-cover` does).
3. Size the canvas to that source rect (capped to the track's own resolution — never upscale).
4. `ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch)`.
5. Front camera: `ctx.translate(cw, 0); ctx.scale(-1, 1)` **only if** D11 is flipped. Default is un-mirrored output, so by default this step does nothing.
6. `canvas.toBlob(blob => …, 'image/jpeg', 0.92)` (D12).

Then `new File([blob], \`camera-${Date.now()}.jpg\`, { type: 'image/jpeg' })` — the explicit type matters, `kindForMime` reads it and `stageFiles` rejects anything that isn't image/video.

### 5.5 Review state (D4)

After a capture the live feed is replaced by the still (an object URL over the same box), and the controls become:

- **Retake** — discard and return to the live feed (the acquire effect is keyed on `captured`, so this re-acquires for free).
- **Done** (accent pill, bottom-right, per the reference) — hand the `File` to `onFiles`, close the panel. The chat is behind it with the photo already in the tray.
- **Close** (✕) — discard and leave without adding anything.

The still gets the `.media-preview` class + `suppressTouchContextMenu` (`lib/nativeMenu.ts`), like every other in-app media preview — otherwise a long-press raises the browser's own save/share menu over our UI (PROJECT.md §14, 2026-07-22).

Object URLs are revoked on retake, on use, and on unmount. One leak per photo is the exact bug the tray's lifecycle comments exist to prevent.

### 5.6 Orientation

`object-cover` on the preview plus a source-rect crop handles the common case, and a portrait-held phone reports a portrait-oriented track on both dev platforms. ⚠️ This is nonetheless flagged for the device gate: some devices report a landscape track regardless of hold, and the fix (rotating in canvas from `screen.orientation.angle`) is only worth writing once we know a real device needs it. Do not pre-emptively rotate — that is how you ship sideways photos to the platform that was fine.

## 6. Edge cases (decided)

- **Tray full.** `stageFiles` already caps at 10 and reports the overflow. The camera button stays enabled; a capture at the cap surfaces the existing "skipped (up to 10 attachments)" error. Not special-cased.
- **Panel open while a voice recording is in flight.** Can't happen — the camera button is only rendered when `recState === 'idle'`, same as the rest of the leading slot today.
- **Panel open while editing.** Can't happen — no media controls exist in edit mode (§4.2).
- **Chat switched / app backgrounded with the panel open.** `visibilitychange` stops the tracks; the panel stays mounted and re-acquires on return. A chat switch unmounts it (it's rendered from `ChatView`), which stops the tracks via the unmount cleanup.
- **Capture larger than the 25MB image ceiling.** Not reachable at 1080p JPEG (~300KB–1MB), but `stageFiles` enforces it anyway with no new code.
- **Desktop.** No camera button (D13); the panel is never mounted. The pill layout applies, with the trailing cluster free to stay expanded — desktop has the width.

## 7. iOS flags (⚠️ for the standing real-device gate — dev device is Android)

Per PROJECT.md §12, everything here is unverified on iOS and none of it can be settled on the Samsung:

- **`getUserMedia` inside the installed PWA.** Standalone-mode camera access was historically broken on iOS and has long since been fixed, well below the 16.4 floor push already requires — but this is precisely the class of thing the gate exists for. **Highest-risk item in the feature**: if it fails, the panel is unreachable for most of the circle and the fallback (§5.3) is the whole experience there.
- **The gesture chain** from tap → `getUserMedia`, surviving into the prompt. Same rule the mic path already depends on; different API.
- **`playsinline`** actually keeping the feed inline rather than punting to the native fullscreen player.
- **Capture orientation** on a portrait-held iPhone (§5.6), and the front-camera mirroring judgment (D11).
- **Capture resolution in practice** (D2) — whether ~2MP from an iPhone is tolerable next to what the OS camera produces.
- **Track teardown on background/foreground** in an installed PWA — whether the camera indicator actually goes out, and whether re-acquire works after a suspend.
- **The rehauled pill against the iOS keyboard** — the composer's `--kb-inset` behavior is unchanged in principle, but the pill now grows multi-line with controls pinned inside it, which is new geometry over load-bearing padding logic (docs/IOS_KEYBOARD.md).
- **The mic gesture inside the pill.** Unchanged code (D9), new surroundings — the drag-left-to-cancel path now travels across two sibling buttons. Pointer capture should make that a non-event; confirm it is.

## 8. Video — deliberately phase 2, not now (D3)

Recorded here so the phase-1 shape doesn't foreclose it:

- The shutter's **ring is a separate element** specifically so it can become the recording progress ring without restructuring the button.
- The gesture is a direct port of the voice recorder's, which is already tuned and dev-verified: `LOCK_THRESHOLD_DY = -115` slide-up-to-lock, `CANCEL_THRESHOLD_DX = -120` slide-left-to-cancel, haptic tick on threshold crossing, `setPointerCapture` on pointerdown, `pointercancel` handled. `lib/pressGesture.ts` is the precedent for the tap-vs-hold discriminator the shutter needs and the mic doesn't.
- Phase 2 must request `audio: true`, which means a second permission prompt and re-checking the iOS gesture rules for `AudioContext`.
- Container variance is already a solved problem: the transcode pipeline (docs/VIDEO_TRANSCODE.md, shipped 2026-08-26) normalizes whatever the platform records to h264+aac mp4, so Safari's `video/mp4` and Chrome's `video/webm` are both fine — the same posture voice already has.
- Needs a duration cap against `MediaLimits.maxBytes.video` (500MB) — a MediaRecorder left running is unbounded.
- The review step (§5.5) needs a `<video>` variant; the tray and `AttachmentSheet` already handle `kind: 'video'` thumbs.

## 9. Docs & bookkeeping (same change, not a follow-up)

- This file.
- PROJECT.md **§13** — add to "Also shipped off-roadmap" on completion, with the phase-2 video note.
- PROJECT.md **§14** — the decision-log row pulling this forward (added with this plan).
- PROJECT.md **§11** — the composer's description mentions the leading slot holding attach + GIF; update it for the pill layout and the collapse rule.
- PROJECT.md **§12** — fold §7's flags into the platform-reality list.
- docs/MEDIA_ATTACHMENTS.md **§5.1** — note the camera as a third entry point into `stageFiles`, alongside the attach button and paste.

No migration. No new routes. No new WS types. No new dependency.

## 10. Verification (definition of done)

- `npm run typecheck` / `npm run lint` / `npm run test` green.
- No server change, so no scripted multi-account flow is owed for the pipeline itself — but a captured photo must be sent end-to-end against the compose stack and **verified to arrive as a normal `ready` image for a second account**, confirming the capture path produces something the existing verify-and-process step accepts (invariant 7).
- Confirm the produced JPEG has **no EXIF** (invariant 6 — expected by construction, worth checking once).
- Browser pass on the dev Samsung, in Chrome (the daily driver per §12), installed PWA: permission prompt, capture, retake, use, switch cameras, denial fallback, back gesture, tray-full behavior.
- Composer regression pass, since D14 touches a much-fixed component: soft keyboard doesn't collapse on send; the multi-line pill grows correctly with the keyboard up; the GIF panel still replaces the composer wholesale; edit mode shows no media controls; **hold-to-record voice still locks and cancels at the same thresholds**.
- ⚠️ iOS gate per §7 — flagged, not blocking, never silently called done.

### 10.1 What the browser pass actually covered (2026-09-01)

Run against a throwaway Vite harness mounting the real components with the real compiled CSS, driven through Chromium at 360×740, with `getUserMedia` stubbed to a **1280×720 canvas-captured MediaStream** — a real `MediaStream` with real track dimensions, painted with vertical colour bands (left third red, middle green, right blue) so the crop's *position* is checkable and not just its size.

**Composer rehaul**
- The mic is **not remounted** when the layout collapses on record. Tagged the DOM node with an expando: it survives `idle → recording`, moving from child index 4 to 1 as slots 1 and 3 collapse, with its label, class and `touch-action: none` updated in place. (First probe reported a false remount — the mic's `aria-label` changes when recording starts, so a label selector finds a different node. The probe was wrong, not the code. Worth remembering: **a selector keyed on something the state change edits cannot test identity across that state change.**)
- The gesture still reaches lock in the new DOM: pointerdown → recording, a 60px drag holds (under the −115px threshold), a 130px drag locks and swaps in Stop/Cancel.
- All 8 layout states correct: empty · typing (GIF withdraws, Send appears) · multi-line (pill 133px, buttons stay bottom-pinned at a constant 3px) · attachment-only · editing (Update alone) · desktop (no camera) · no Klipy key (no GIF) · no `onOpenCamera` (no camera button).
- Measured widths at 360px: 155px of text field when empty, 199px when typing — the latter *wider* than the 180px before the rehaul.

**Camera panel**
- **The crop (D15) is right, and this is the assertion that mattered.** For a 360×628 feed box over a 1280×720 track the capture came back **413×720**, matching the predicted `object-cover` source rect exactly, and every sampled pixel was pure green — i.e. it captured the centre band the preview was showing, not the full frame and not an edge. A naive full-frame `drawImage` would have returned 1280×720 and contained all three colours.
- Shutter straddle measured at 50px over the feed / 22px over the strip — the intended ~70/30 (D5).
- Capture → review (still shown, feed torn down) → Retake (feed re-acquired, live again at 1280×720) → capture → Done (exactly one `File`, `camera-<ts>.jpg`, `image/jpeg`, handed to `onFiles`; `onClose` called; panel unmounted).
- **Track teardown verified by track state, not by inspection**: `live` while open, `ended` after Close, `ended` on `visibilitychange → hidden`, and a *new* stream acquired on return to visible with the feed live again.
- Both failure states render the right message with the gallery fallback present and the shutter/switch withdrawn: `NotAllowedError` → "Camera access is off for this site…", `NotFoundError` → "No camera found on this device."

**Not covered by this pass** (and not claimable from it): anything WebKit-specific in §7, real camera hardware, orientation on a physically rotated device, the front-camera mirroring judgment (D11), and actual capture quality (D2) — the source here was a flat synthetic canvas.
