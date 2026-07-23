# Image paste in the composer

**Status: implemented 2026-07-22.** Owner-requested QoL pull-forward (not on the §13 roadmap; logged in PROJECT.md §14).

## Scope

Pasting an image while the composer textarea is focused uploads and sends it — desktop `Ctrl+V` (e.g. a Win+Shift+S screenshot) and mobile long-press → Paste. That's the whole feature. Out of scope: drag-and-drop onto the chat, a pre-send preview/confirm step (the existing attach-button flow has neither — pasted media follows the same "picking is sending" precedent), and paste targets other than the composer.

## Design

One `onPaste` handler on the `<textarea>` in `app/src/components/Composer.tsx`, feeding the **existing** upload path — no new upload code:

1. Read `e.clipboardData?.files`. If empty → return without `preventDefault()` (normal text paste is untouched).
2. If files are present:
   - `e.preventDefault()` — some sources put both the file and junk text (a filename, HTML) on the clipboard; we take the file and suppress the text insertion.
   - If `uploading` is already true → surface an error ("Upload in progress") instead of silently dropping the paste, and stop. (Mirrors the attach button, which is `disabled` while uploading — `handleFilesPicked` has no concurrency guard, so a second serial queue must not start.)
   - Otherwise call `onPickFiles(files)` — the same callback the attach `<input type="file">` uses. `ChatView.handleFilesPicked` already: filters to image/video via `kindForMime` (with a "Skipped files…" error for the rest), sends the current draft as caption on the first item, attaches a pending reply to the first item, and uploads sequentially.

Mixed clipboard (text + image, e.g. copied from a web page): files win — the image uploads, the text is dropped. Matches Discord/Slack behavior and keeps the rule simple.

For the error path, generalize the existing `onRecordingError` prop to a plain `onError` (it's already just `setUploadError` in ChatView) rather than adding a parallel prop — one rename, two call sites.

Non-image clipboard files (a pasted PDF on desktop): passed through to `handleFilesPicked`, which already rejects them with its existing message. No new filtering logic in Composer.

## Invariants touched

None structurally — media still flows client → presigned R2 PUT via `uploadMedia`; server still sniffs/verifies after upload-complete; EXIF stripping unchanged. Pasted files often carry generic names (`image.png`) and possibly lying mimes — irrelevant, the server never trusted either (hard invariant 7).

## Platform reality / device checklist (flag, don't assume)

- **iOS Safari / installed PWA:** long-press → Paste in a focused textarea fires a `ClipboardEvent` whose `clipboardData.files` carries the image (Copy Photo from Photos, copied screenshot). Believed working on iOS 16+; **unverified on real hardware** → add to the PROJECT.md §12 unverified list. Copied photos may arrive as PNG/JPEG rather than HEIC; HEIC upload itself is already on the unverified list.
- **Android (dev device):** Samsung Keyboard / Gboard clipboard-image insertion should fire a standard `paste` event with files in Chrome; verify on the Samsung device.
- No new gesture surface, no keyboard/viewport interaction — nothing else to flag.

## Verification

- `npm run typecheck && npm run lint && npm run test` green.
- Desktop manual: copy a screenshot → focus composer → paste → image message appears; paste with draft text present → draft becomes the caption and clears; paste plain text → unchanged textarea behavior; paste while an upload is in flight → error, no second queue.
- Mobile: on the standing real-device checklist (above), not blocking merge.
