# Video transcode — plan

Roadmap item 8's remaining piece (PROJECT.md §13; waveforms shipped
2026-07-22). This is a **correctness fix wearing a feature's clothes**, not a
nice-to-have.

## 1. What is actually broken today

`media/process.ts:processVideo` keeps the original bytes and reports:

```ts
r2Key: originalKey,   // no transcode, original bytes kept as-is
mime: 'video/mp4',    // best-effort; actual container may vary (iPhone .mov)
```

That comment is describing a bug. An iPhone records **HEVC/H.265 in a .mov
container**; the row says `video/mp4`, so every client is handed a `<video>`
source that claims to be something it is not. Two consequences:

- **Android and desktop Chrome frequently cannot decode HEVC.** A video sent
  from an iPhone can silently fail to play for most of the circle — a black
  box or a broken element, with nothing in the UI explaining why.
- Hard invariant 7 says *never trust client-declared mime* and verify after
  upload. We do verify the *upload*, then overwrite the verified answer with a
  hardcoded guess. The invariant is satisfied in letter and defeated in spirit.

Voice already solved exactly this problem, and the fix is to follow it. From
hard invariant 6: *"Voice is transcoded server-side to m4a/AAC — one storage
format, no playback-time format detection."* Video should say the same
sentence.

## 2. Target

**One stored format: H.264 (yuv420p) + AAC in MP4, `+faststart`.** It is the
only combination that plays natively in every browser Den supports, and
faststart moves the moov atom to the front so playback starts before the file
finishes downloading — which matters on a phone.

### 2.1 Remux when we can, transcode when we must

Always re-encoding would be simpler, and wrong: it burns CPU and throws away
quality on the many clips that are *already* H.264/AAC. So probe first:

| Input | Action | Cost |
|---|---|---|
| H.264 + AAC | **remux** — `-c copy -movflags +faststart` | ~seconds, lossless |
| anything else (HEVC, VP9, Opus…) | **full transcode** | CPU-bound |

Both paths produce the same container and the same honest `video/mp4`.

### 2.2 Bounds, because this runs inline

There is no job queue, and that is a deliberate standing decision (§14,
2026-07-20 — inline media processing specifically to avoid queue infra). A
2-minute transcode therefore occupies the request path.

- `preset veryfast`, `crf 23` — quality/speed balance suited to phone clips.
- Long edge capped at **1080p**; smaller videos are never upscaled.
- **`MAX_TRANSCODE_MS` (90s wall clock).** Past that, ffmpeg is killed and the
  original is kept with its **real, probed mime** rather than a guess. A long
  video that plays for some people is a worse outcome than one that plays for
  everyone, but it is a much better outcome than a blocked pipeline — and the
  honest mime at least lets the client fail visibly instead of silently.
- ⚠️ `runFfmpeg` currently has **no timeout at all**. A hung ffmpeg blocks the
  inline worker forever. That is survivable for a poster frame; it is not for a
  transcode. Adding the timeout is part of this work and is arguably the most
  important line in it.

### 2.3 The original

Deleted after the derived asset is confirmed uploaded — the same rule image and
voice already follow, and the reason the module header says "Video keeps its
original (no derived copy exists yet)" is precisely that no derived copy
existed. Now one does. ⚠️ Only delete on the transcode/remux path; the
timeout fallback keeps the original because it *is* the stored asset.

## 3. Mime honesty

`ProcessResult.mime` becomes whatever the file actually is:

- transcode or remux → `video/mp4` (true by construction)
- fallback → probed from the container, never assumed

This closes the invariant-7 gap in §1.

## 4. What this does NOT do

- No adaptive bitrate, no HLS, no multiple renditions. One file per video.
- No queue. If transcode time becomes a real problem, that is the moment to
  revisit the 2026-07-20 decision — not before, and not as a side effect of
  this.
- No re-processing of existing videos. A `scripts/backfill-video.ts` is the
  obvious follow-up (the waveform work set the precedent with
  `backfill-waveform.ts`), but existing rows keep playing exactly as well as
  they do today, so it is not urgent.

## 5. Verification

- `scripts/probe-video.ts` against the compose stack, using **generated
  fixtures** (ffmpeg can synthesize a test pattern — no binary blobs in the
  repo):
  - an **HEVC/.mov** input — the iPhone case — comes out H.264/AAC in MP4,
    and the row's mime says so;
  - an already-H.264/AAC input takes the **remux** path (verify it is fast and
    the video stream is bit-identical);
  - a video with **no audio track** survives both paths;
  - a **portrait** video keeps its displayed orientation (the rotation
    side-data handling in `probeMedia` is easy to break here);
  - the poster frame is still produced;
  - the original is deleted on success and **kept** on the timeout path.
- ⚠️ iOS device gate: playback of a Den-transcoded video in the installed PWA,
  and that a video recorded *on* an iPhone survives the round trip.
